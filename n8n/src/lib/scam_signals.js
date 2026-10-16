// Scam check (A4): deterministic signals and score. The model only lists text signals with quotes (prompt P8);
// price, profile, price_mismatch, weights and thresholds are computed here from app.scam_context (settings scam.*).
// Evidence of rule signals is data (numbers, codes), never sentences.
const MODEL_TYPES = ['off_platform_payment', 'advance_payment', 'owner_abroad', 'urgency', 'external_contact'];
// Contexts are normalized (no accents, lower case) before these tests.
const RENT_CTX = /\b(rent|loyer|kra|price|prix|real|reel|vrai|actual|monthly|mensuel)\b|per month|par mois/;
const OTHER_CTX = /\b(deposit|caution|fees?|frais|bills?|transfer|virement)\b/;
const RENT_WORD = /\b(rent|loyer|kra)\b/;
const CURRENCY_ALIAS = { 'dt': 'TND', 'tnd': 'TND', 'dinar': 'TND', 'dinars': 'TND',
  '€': 'EUR', 'eur': 'EUR', 'euro': 'EUR', 'euros': 'EUR', '$': 'USD', 'usd': 'USD', '£': 'GBP', 'gbp': 'GBP' };

function normText(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function normCurrency(c) {
  if (!c) return null;
  const k = String(c).trim().toLowerCase();
  return CURRENCY_ALIAS[k] || k.toUpperCase();
}

function quoteInText(quote, text) {
  const q = normText(quote);
  return q.length >= 4 && normText(text).includes(q);
}

function monthlyOf(amount, period) {
  return period === 'week' ? (amount * 52) / 12 : amount;
}

// Missing settings must fail loudly: zero weights would silently pass every listing as "low".
function requireSettings(S) {
  const missing = ['scam.weights', 'scam.price_ratio', 'scam.thresholds'].filter((k) => !S[k] || typeof S[k] !== 'object');
  if (missing.length) throw new Error(`scam settings missing: ${missing.join(', ')}`);
}

// Rent against the median of comparable listings (same unit: monthly, minor units).
function priceSignal(ctx, W) {
  const m = ctx.market || {};
  const R = ctx.settings['scam.price_ratio'];
  if (ctx.rent_minor == null || !m.median_monthly_minor || ctx.rent_scope === 'whole_flat') return null;
  const ratio = monthlyOf(Number(ctx.rent_minor), ctx.rent_period) / Number(m.median_monthly_minor);
  let type = null;
  if (ratio <= R.very_low) type = 'price_very_low';
  else if (ratio <= R.low) type = 'price_low';
  else if (ratio >= R.very_high) type = 'price_very_high';
  else if (ratio >= R.high) type = 'price_high';
  if (!type) return null;
  const full = W[type] || 0;
  const weight = m.scope === 'jurisdiction' ? Math.round(full / 2) : full;
  return { type, source: 'rule', weight,
    evidence: { ratio: Math.round(ratio * 100) / 100, median_monthly_minor: m.median_monthly_minor, scope: m.scope, comparables: m.comparables } };
}

// An amount written as a rent in the text that is far from the stored rent (title says 300, text says 900).
// Compared to the closest of stored / stored-as-monthly, so a weekly rent quoted per month is not a mismatch.
function mismatchSignal(ctx, pricesInText, W) {
  if (ctx.rent_minor == null || !Array.isArray(pricesInText)) return null;
  const exp = ctx.currency_exponent == null ? 2 : Number(ctx.currency_exponent);
  const stored = Number(ctx.rent_minor) / Math.pow(10, exp);
  const storedMonthly = monthlyOf(stored, ctx.rent_period);
  const cur = normCurrency(ctx.currency);
  for (const p of pricesInText) {
    if (!p || typeof p.amount !== 'number' || p.amount <= 0) continue;
    const pc = normCurrency(p.currency);
    if (pc && cur && pc !== cur) continue;
    const c = normText(p.context);
    if (!RENT_CTX.test(c)) continue;
    if (OTHER_CTX.test(c) && !RENT_WORD.test(c)) continue;
    const r = (x) => Math.max(p.amount, x) / Math.min(p.amount, x);
    const best = Math.min(r(stored), r(storedMonthly));
    if (best >= 1.5) {
      return { type: 'price_mismatch', source: 'rule', weight: W.price_mismatch || 0,
        evidence: { stored_main: stored, text_amount: p.amount, ratio: Math.round(best * 100) / 100, context: c.slice(0, 40) } };
    }
  }
  return null;
}

function profileSignals(ctx, S, W) {
  const o = ctx.owner || {};
  const out = [];
  const days = S['scam.new_account_days'];
  const burst = S['scam.burst_listings_24h'];
  if (o.account_age_days != null && days != null && o.account_age_days < days) {
    out.push({ type: 'new_account', source: 'rule', weight: W.new_account || 0, evidence: { account_age_days: o.account_age_days } });
  }
  if (o.account_age_days != null && o.verified_level === 0) {
    out.push({ type: 'unverified_owner', source: 'rule', weight: W.unverified_owner || 0, evidence: { verified_level: 0 } });
  }
  if (burst != null && o.listings_24h != null && o.listings_24h >= burst) {
    out.push({ type: 'listing_burst', source: 'rule', weight: W.listing_burst || 0, evidence: { listings_24h: o.listings_24h } });
  }
  return out;
}

// Signals of the model kept only if the type is allowed and the quote is really in the text (one per type).
function modelSignals(output, text, W) {
  const kept = [], dropped = [];
  const seen = new Set();
  const list = output && Array.isArray(output.signals) ? output.signals : [];
  for (const s of list) {
    if (!s || !MODEL_TYPES.includes(s.type)) { dropped.push({ type: (s && s.type) || null, reason: 'unknown_type' }); continue; }
    if (!quoteInText(s.quote, text)) { dropped.push({ type: s.type, reason: 'quote_not_in_text' }); continue; }
    if (seen.has(s.type)) continue;
    seen.add(s.type);
    kept.push({ type: s.type, source: 'model', weight: W[s.type] || 0, evidence: { quote: String(s.quote).slice(0, 160) } });
  }
  return { kept, dropped };
}

// ctx: app.scam_context; modelOutput: P8 output or null (model unavailable); returns {score, level, signals, dropped}.
function scamScore(ctx, modelOutput) {
  const S = ctx.settings || {};
  requireSettings(S);
  const W = S['scam.weights'];
  const T = S['scam.thresholds'];
  const signals = [];
  const p = priceSignal(ctx, W); if (p) signals.push(p);
  const mm = mismatchSignal(ctx, modelOutput && modelOutput.prices_in_text, W); if (mm) signals.push(mm);
  signals.push(...profileSignals(ctx, S, W));
  const ms = modelSignals(modelOutput, ctx.text, W);
  signals.push(...ms.kept);
  const score = Math.min(100, signals.reduce((a, s) => a + (s.weight || 0), 0));
  const level = score >= T.block ? 'high' : score >= T.review ? 'medium' : 'low';
  return { score, level, signals, dropped: ms.dropped };
}

if (typeof module !== 'undefined') module.exports = { scamScore, quoteInText, normCurrency };