// wf.api.search_v2 > "Validate query" (platform P2, PLATFORM_SPEC 3.2)
// GET /v2/search: the parameters of GET /v1/search (q, jurisdiction, max_rent, currency, period, lat, lng, near,
// radius_m, limit, use_profile) plus kind, furnished, bills_included, available_by, amenities, house_rules, bbox, ids
// and cursor. Lists are comma separated: amenities=wifi,desk; house_rules=smoking:no,pets:yes;
// bbox=min_lng,min_lat,max_lng,max_lat (the map's visible area); ids=<uuid>,<uuid> (cards of known listings, in that
// order). The cursor is the one meta.next_cursor gave; it is tied to the other parameters (sending it with other
// filters is refused, so a page can never mix two searches).
/* @include lib/search2_query.js */
const gw = $input.first().json;
const q = gw.ctx.query || {};
const user = gw.ctx.user || {};
const r = parseSearch2(q, { accountJurisdiction: user.jurisdiction_code || null });
if (r.details.length) {
  return [{ json: { ok: false, status: 422, gw, error: { code: 'VALIDATION_FAILED', message: 'Query parameters are invalid', details: r.details } } }];
}
return [{ json: { ok: true, gw, input: r.input, fingerprint: r.fingerprint, offset: r.offset,
  params: [gw.ctx.user_id || '', r.useProfile] } }];
