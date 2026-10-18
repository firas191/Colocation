// wf.trust.tool > "Tool answer": one tool of the Trust agent, from the facts the database already checked
// (app.trust_facts) or, for text_signals, the phrase lists of the packs. The model gets facts, never other users' text.
/* @include lib/trust_rules.js */
const PHRASES = compilePhrases(__TRUST_PHRASES__);
const s = $('Start').first().json;
const f = ($input.first().json || {}).f || null;
if (!f) return [{ json: { found: false } }];
const L = f.listing || {};
const money = (m) => (m === null || m === undefined ? null : Number(m) / 10 ** (L.exponent ?? 2));
let out;
switch (String(s.tool || '')) {
  case 'listing_fields':
    out = { kind: L.kind, rent: money(L.rent_minor), rent_period: L.rent_period, rent_per_month: money(L.rent_monthly_minor), currency: L.currency,
      deposit: money(L.deposit_minor), city: L.city, neighbourhood: L.neighbourhood, furnished: L.furnished, photos: L.photos,
      analysis_issues: L.issues };
    break;
  case 'text_signals':
    out = { found: scanText([L.title, L.description].filter(Boolean).join('\n'), PHRASES, ['GLOBAL', L.jurisdiction_code])
      .map((x) => ({ signal: x.signal, quote: x.quote })) };
    break;
  case 'price_benchmark': {
    const b = f.benchmark || {};
    out = b.status === 'ok' ? { status: 'ok', source: b.source, level: b.level, comparable_listings: b.n, median_per_month: money(b.median_minor),
      rent_per_month: money(b.rent_minor), ratio: b.ratio, currency: b.currency } : { status: b.status || 'insufficient_data' };
    break;
  }
  case 'photo_duplicates':
    out = { photos_used_by_another_owner: (f.duplicates || []).length,
      other_listings: [...new Set((f.duplicates || []).map((d) => d.other_listing_id))].length };
    break;
  case 'owner_history':
    out = f.owner_history || {};
    break;
  default:
    out = { error: 'unknown_tool' };
}
return [{ json: out }];
