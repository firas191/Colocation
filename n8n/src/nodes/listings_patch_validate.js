// wf.api.listings_patch > "Validate body"   PATCH /v1/listings/:id (spec 2.4 journey B step 6, D-088)
// Body: the fields to change (rent, rent_period, deposit, bills_included, furnished, available_from, bedrooms,
// min_stay_months, place, amenities_add, amenities_remove, house_rules, remove_photos, status; amounts in the
// currency's main unit), checked in the database (app.listing_change_check); or {change_id} to apply a change the
// owner assistant proposed.
const gw = $input.first().json;
const id = (gw.ctx.params || {}).id || '';
const b = gw.ctx.body;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!UUID.test(id)) return [{ json: { ok: false, status: 404, gw, error: { code: 'NOT_FOUND', message: 'Listing not found', details: [] } } }];
const bad = (details) => [{ json: { ok: false, status: 422, gw, error: { code: 'VALIDATION_FAILED', message: 'Request body is invalid', details } } }];
if (!b || typeof b !== 'object' || Array.isArray(b) || !Object.keys(b).length) return bad([{ field: 'body', issue: 'no_change' }]);
if ('change_id' in b) {
  if (Object.keys(b).length > 1) return bad([{ field: 'change_id', issue: 'alone' }]);
  if (typeof b.change_id !== 'string' || !UUID.test(b.change_id)) return bad([{ field: 'change_id', issue: 'invalid_format' }]);
  return [{ json: { ok: true, gw, input: { user_id: gw.ctx.user_id, listing_id: id, change_id: b.change_id, changes: null } } }];
}
return [{ json: { ok: true, gw, input: { user_id: gw.ctx.user_id, listing_id: id, change_id: '', changes: b } } }];
