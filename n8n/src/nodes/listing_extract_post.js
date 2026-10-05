// wf.listing.extract > "Check listing"
// Deterministic checks after P3 (spec 9.4, D-076, D-077): plausible rent ranges (lib/listing_check.js),
// main units to minor units with the currency exponent, one currency per listing, and issue codes
// for what the owner must confirm, including what the photos show against the text (P7, lib/photo_check.js).
// The model's answer and the checked fields are both kept in app.listings.extraction; the agent step
// records the call without the listing text.
/* @include lib/listing_check.js */
/* @include lib/photo_check.js */
const r = $input.first().json;
const c = $('Context').first().json;
const ctx = c.ctx || {};
const tr = $('Text analysis').first().json || {};
const tb = tr.body && typeof tr.body === 'object' ? tr.body : null;
const step = { agent: 'A1_extract', prompt_version_id: r.prompt_version_id || null, model: r.model || null,
  input: { chars: Array.from(String(c.text || '')).length, jurisdiction: c.jurisdiction_code },
  output: r.ok ? r.output : { error_code: r.error_code }, latency_ms: r.latency_ms, tokens_in: r.tokens_in || 0,
  tokens_out: r.tokens_out || 0, error: r.ok ? null : `${r.error_code}${r.detail ? ': ' + String(r.detail).slice(0, 200) : ''}` };
if (!r.ok) {
  return [{ json: { ok: false, store: false, listing_id: c.listing_id, transient: !!r.call_error,
    error: r.call_error ? 'model unavailable' : `extraction failed: ${r.error_code}`, steps: [step] } }];
}
const check = checkListing(r.output, ctx.rent_ranges || {}, ctx.default_currency || null, c.text || '');
const x = check.fields;
const issues = [...check.issues];
const exps = ctx.currencies || {};
let currency = x.rent_currency || null;
let rent_minor = toMinorUnits(x.rent_amount, x.rent_currency, exps);
if (x.rent_amount !== null && rent_minor === null) { issues.push('rent_currency_unknown'); currency = null; }
let deposit_minor = toMinorUnits(x.deposit_amount, x.deposit_currency, exps);
if (deposit_minor !== null && currency && x.deposit_currency !== currency) { issues.push('deposit_currency_differs'); deposit_minor = null; }
if (deposit_minor !== null && !currency) currency = x.deposit_currency;
if (rent_minor === null) issues.push('rent_missing');
else if (x.rent_scope === 'whole_flat' || x.rent_scope === 'unknown') issues.push(`rent_scope_${x.rent_scope}`);
// Photos against the text (P7, D-081): only what the photos show, never what they do not show.
const pf = photoFindings({ furnished: x.furnished, amenities: x.amenities || [] }, c.photos || []);
issues.push(...pf.issues);
const pii = tb && tb.pii ? tb.pii.counts || {} : null;
if (pii && ((pii.PHONE || 0) + (pii.EMAIL || 0)) > 0) issues.push('contact_details_in_text');
const fields = { kind: x.kind, rent_minor, currency: rent_minor === null && deposit_minor === null ? null : currency,
  rent_period: rent_minor === null ? null : x.rent_period, rent_scope: rent_minor === null ? null : x.rent_scope,
  deposit_minor, bills_included: x.bills_included, available_from: x.available_from, bedrooms: x.bedrooms,
  furnished: x.furnished, amenities: x.amenities || [], house_rules: x.house_rules || {}, city: x.city, neighbourhood: x.neighbourhood };
const extraction = { prompt_version_id: r.prompt_version_id, model: r.model, model_output: r.output, address_text: x.address_text,
  issues: [...new Set(issues)], model_issues: x.issues || [], field_confidence: x.field_confidence || {},
  checks_changed: check.changed, language: tb ? tb.language : null, pii_counts: pii,
  photos: { analyzed: pf.analyzed, failed: pf.failed, amenities_seen_not_in_text: pf.amenities_seen_not_in_text } };
return [{ json: { ok: true, store: true, listing_id: c.listing_id, steps: [step],
  params: [c.listing_id, JSON.stringify({ fields, description_lang: tb ? tb.language.language : null, extraction })],
  summary: { issues: extraction.issues, rent_minor, currency: fields.currency, rent_scope: fields.rent_scope } } }];
