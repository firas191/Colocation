// wf.api.saved_search_create > "Search parameters" (platform P7, D-106)
// The saved query goes through the same rules as GET /v2/search (lib/search2_query.js), so the daily alert runs exactly
// the search the person saw. A saved search is the filters only: no page, no listing ids, no profile defaults (the
// profile can change after the search is saved; the alert must not change with it).
/* @include lib/search2_query.js */
const v = $input.first().json;
const gw = v.gw;
const body = v.input.body || {};
const q = body.query || {};
const user = (gw.ctx || {}).user || {};
const details = [];
for (const k of ['cursor', 'ids', 'use_profile', 'limit']) if (q[k] !== undefined) details.push({ field: `query.${k}`, issue: 'not_saved' });
const r = parseSearch2(q, { accountJurisdiction: user.jurisdiction_code || null });
for (const d of r.details) details.push({ ...d, field: `query.${d.field}` });
if (details.length) {
  return [{ json: { ok: false, gw, status: 422, error: { code: 'VALIDATION_FAILED', message: 'Request is invalid', details } } }];
}
const i = r.input;
const params = { jurisdiction: i.jurisdiction || i.account_jurisdiction, q_text: (i.q || '').trim() || null,
  max_rent_minor: i.max_rent_minor, currency: i.currency, budget_period: i.budget_period, lat: i.lat, lng: i.lng,
  place: i.place, radius_m: i.radius_m, kind: i.kind, furnished: i.furnished, bills_included: i.bills_included,
  available_by: i.available_by, amenities: i.amenities, house_rules: i.house_rules, bbox: i.bbox };
for (const k of Object.keys(params)) if (params[k] === null || params[k] === undefined) delete params[k];
if (!params.jurisdiction) {
  return [{ json: { ok: false, gw, status: 422, error: { code: 'VALIDATION_FAILED', message: 'Request is invalid',
    details: [{ field: 'query.jurisdiction', issue: 'required' }] } } }];
}
return [{ json: { ok: true, gw, input: { ...v.input, body: { name: body.name, alert: body.alert || 'daily', query: q, params } } } }];
