// Trust check rules (platform P8, D-107; backend spec 12.2). Plain code, no model:
//  - scanText: the phrase lists of the packs (kb/packs/<code>/scam_phrases.csv, built into the Code node) over a text;
//  - checkAgent: the Trust agent's answer -> signals that may count. A signal must quote the listing: a quote that is
//    not in the text is dropped (the model cannot invent evidence). A payment signal the phrase rules did not also find
//    becomes payment_claim_unconfirmed, which can never block on its own (12.2: "P4 plus phrase rules");
//  - merge: the database, rule and agent signals in one list for app.trust_score, which caps the points;
//  - detector (D-114, from Emna Safer's scam check, branch feat/scam-check): the answer of the single-call prompt
//    P8_scam_detector read with the same checks as the agent's, and price_mismatch, a rent written in the text far
//    from the stored rent (her mismatchSignal: only an amount really written in the text, said to be the rent).

const TRUST_AGENT_SIGNALS = ['urgency_pressure', 'payment_before_viewing', 'untraceable_payment', 'owner_abroad', 'contact_off_platform',
  'inconsistent_details', 'too_good_price_claim', 'discriminatory_language', 'other'];
const PAYMENT_SIGNALS = ['payment_before_viewing', 'untraceable_payment'];

// \b of JavaScript only knows ASCII letters ("à l'étranger" has no \b before the à): the lists use \b, read here as a
// boundary between a letter or digit and anything else, in any alphabet.
const UB = '(?:(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_])|(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_]))';

function compilePhrases(rows) {
  const out = [];
  for (const r of rows || []) {
    if (!r || !r.pattern || !r.signal) continue;
    try { out.push({ ...r, re: new RegExp(String(r.pattern).replace(/\\b/g, UB), 'iu') }); } catch (e) { /* a bad line is skipped; the unit test checks every line */ }
  }
  return out;
}

// a match right after a negation ("rien n'est payé avant la visite", "لا شيء يدفع قبل الزيارة") says the opposite. "ma" and
// "ما" are not in the list: in Tunisian "9bal ma tchouf" and "قبل ما تشوف" mean "before you see".
const NEGATION = new RegExp(`(?:^|${UB})(?:rien|pas|aucun|aucune|jamais|ne|n'|no|nothing|never|not|don't|لا|لن|مش|mich)(?:${UB}|$)`, 'iu');

/** Phrase-rule hits in a text for the packs given (GLOBAL and the country): one per signal, the first quote that is
 *  not negated within the 30 characters before it. */
function scanText(text, phrases, packs) {
  const t = String(text || '');
  const want = new Set((packs || []).map((p) => String(p).toUpperCase()));
  const hits = new Map();
  for (const p of phrases) {
    if (want.size && !want.has(String(p.pack || '').toUpperCase())) continue;
    if (hits.has(p.signal)) continue;
    const re = new RegExp(p.re.source, 'giu');
    let m;
    while ((m = re.exec(t)) !== null) {
      const before = t.slice(Math.max(0, m.index - 30), m.index);
      if (!NEGATION.test(before)) {
        hits.set(p.signal, { signal: p.signal, source: 'rules', pack: p.pack, lang: p.lang, quote: m[0].slice(0, 160) });
        break;
      }
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return [...hits.values()];
}

const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[’`´]/g, "'").replace(/\s+/g, ' ').trim();

/** The JSON object inside the model's text (it may add words or a code fence around it). null if none. */
function parseAgentJson(raw) {
  const s = String(raw || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

/** The agent's signals that may count: known kind, a quote found in the listing text, payment kinds confirmed by a rule. */
function checkAgent(raw, listingText, ruleSignals, source = 'agent') {
  const j = parseAgentJson(raw);
  const out = { parsed: !!j, kept: [], dropped: [], summary: null };
  if (!j || !Array.isArray(j.signals)) return out;
  out.summary = typeof j.summary === 'string' ? j.summary.slice(0, 300) : null;
  const text = norm(listingText);
  const ruled = new Set((ruleSignals || []).map((x) => x.signal));
  for (const s of j.signals.slice(0, 12)) {
    const kind = s && typeof s.signal === 'string' ? s.signal.trim() : '';
    const quote = s && typeof s.evidence_quote === 'string' ? s.evidence_quote.trim() : '';
    if (!TRUST_AGENT_SIGNALS.includes(kind)) { out.dropped.push({ signal: kind.slice(0, 40), why: 'unknown_signal' }); continue; }
    if (quote.length < 3 || !text.includes(norm(quote))) { out.dropped.push({ signal: kind, why: 'quote_not_in_text' }); continue; }
    // no points given: null, so app.trust_score uses the setting's points (Number(null) is 0, which would count nothing)
    const pts = s.points !== null && s.points !== undefined && s.points !== '' && Number.isFinite(Number(s.points)) ? Math.round(Number(s.points)) : null;
    const conf = Number.isFinite(Number(s.confidence)) ? Math.max(0, Math.min(1, Number(s.confidence))) : null;
    const signal = PAYMENT_SIGNALS.includes(kind) && !ruled.has(kind) ? 'payment_claim_unconfirmed' : kind;
    out.kept.push({ signal, from: kind, points: pts, source, quote: quote.slice(0, 160), confidence: conf });
  }
  return out;
}

// ---- P8_scam_detector (D-114) -----------------------------------------------------------------------------------
// Her five text signal types, as the signals of the trust check (the same meaning; the points are ours).
const DETECTOR_SIGNALS = { off_platform_payment: 'untraceable_payment', advance_payment: 'payment_before_viewing',
  owner_abroad: 'owner_abroad', urgency: 'urgency_pressure', external_contact: 'contact_off_platform' };

/** The detector's answer {signals: [{type, quote, evidence}], prices_in_text} in the agent's shape, so checkAgent reads it
 *  with the same rules (quote in the text, payment confirmed by a phrase rule). No points: the setting gives them. */
function detectorAsAgent(out) {
  const sig = (out && Array.isArray(out.signals) ? out.signals : []).map((x) => ({
    signal: DETECTOR_SIGNALS[x && x.type] || String((x && x.type) || '').slice(0, 40), evidence_quote: x && x.quote, points: null }));
  const notes = (out && Array.isArray(out.signals) ? out.signals : []).map((x) => x && x.evidence).filter(Boolean);
  return JSON.stringify({ signals: sig, summary: notes.length ? notes.join('; ').slice(0, 300) : null });
}

const RENT_CTX = /\b(rent|loyer|kra|price|prix|real|reel|vrai|actual|monthly|mensuel)\b|per month|par mois/;
const OTHER_CTX = /\b(deposit|caution|fees?|frais|bills?|transfer|virement)\b/;
const RENT_WORD = /\b(rent|loyer|kra)\b/;
const CURRENCY_ALIAS = { dt: 'TND', tnd: 'TND', dinar: 'TND', dinars: 'TND', '€': 'EUR', eur: 'EUR', euro: 'EUR', euros: 'EUR',
  '£': 'GBP', gbp: 'GBP' };
const plain = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const currencyOf = (c) => (c ? CURRENCY_ALIAS[String(c).trim().toLowerCase()] || String(c).trim().toUpperCase() : null);

/** Numbers written in a text with the usual separators: 1200, 1 200, 1.200, 1,200, 1200.50. */
function numbersIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/\d(?:[\d.,]|\s(?=\d{3}\b))*/g)) {
    const s = m[0].replace(/[.,]+$/, '').replace(/\s/g, '');
    for (const c of [s.replace(/[.,]/g, ''), s.replace(/,/g, '.'), s.replace(/\./g, '').replace(',', '.'), s.replace(/,/g, '')]) {
      const n = Number(c);
      if (Number.isFinite(n)) out.add(n);
    }
  }
  return out;
}

/** price_mismatch: an amount the detector read as the rent, really written in the text, at least 1.5 times away from
 *  the stored rent (or the stored rent per month, so a weekly rent quoted per month is not a mismatch). listing:
 *  {rent_minor, exponent, rent_period, currency}. Returns the signal or null, and why amounts were dropped. */
function priceMismatch(listing, prices, text) {
  const dropped = [];
  if (!listing || listing.rent_minor == null || !Array.isArray(prices)) return { signal: null, dropped };
  const stored = Number(listing.rent_minor) / 10 ** (listing.exponent == null ? 2 : Number(listing.exponent));
  const monthly = listing.rent_period === 'week' ? (stored * 52) / 12 : stored;
  const cur = currencyOf(listing.currency);
  const nums = numbersIn(text);
  for (const p of prices) {
    if (!p || typeof p.amount !== 'number' || p.amount <= 0) continue;
    const pc = currencyOf(p.currency);
    if (pc && cur && pc !== cur) continue;
    const c = plain(p.context);
    if (!RENT_CTX.test(c) || (OTHER_CTX.test(c) && !RENT_WORD.test(c))) continue;
    if (![...nums].some((n) => Math.abs(n - p.amount) < 0.005)) { dropped.push({ signal: 'price_mismatch', why: 'amount_not_in_text' }); continue; }
    const r = (x) => Math.max(p.amount, x) / Math.min(p.amount, x);
    const best = Math.min(r(stored), r(monthly));
    if (best >= 1.5) {
      return { signal: { signal: 'price_mismatch', points: null, source: 'detector',
        evidence: { stored, text_amount: p.amount, ratio: Math.round(best * 100) / 100 } }, dropped };
    }
  }
  return { signal: null, dropped };
}

/** One list for the score: database signals, rule signals, then agent signals (the score keeps the strongest per kind). */
function mergeSignals(dbSignals, ruleSignals, agentSignals) {
  return [...(dbSignals || []), ...(ruleSignals || []), ...(agentSignals || [])];
}

/** Codes shown with a message to the person who receives it (rule 2.7: rules only, no model). */
function messageCodes(text, phrases, packs) {
  return scanText(text, phrases, packs).filter((h) => PAYMENT_SIGNALS.includes(h.signal) || h.signal === 'urgency_pressure')
    .map((h) => h.signal);
}

if (typeof module !== 'undefined') {
  module.exports = { compilePhrases, scanText, checkAgent, mergeSignals, messageCodes, parseAgentJson, TRUST_AGENT_SIGNALS,
    detectorAsAgent, priceMismatch, numbersIn };
}
