// wf.api.listings_patch > "Build result": 200 with what changed; 404 for a listing that is not the caller's; 409 for a
// proposal that expired or was already decided; 422 with the field issues otherwise.
const gw = $('Validate body').first().json.gw;
const r = $input.first().json || {};
if (r.ok) {
  return [{ json: { ok: true, gw, status: 200, data: { listing_id: r.listing_id, status: r.status, diff: r.diff,
    publication: r.publication, photos_deleted_from_storage: r.photos_deleted_from_storage, embedded: r.embedded } } }];
}
const errors = Array.isArray(r.errors) ? r.errors : [];
if (r.found === false && !errors.some((e) => e.field === 'change_id')) {
  return [{ json: { ok: false, gw, status: 404, error: { code: 'NOT_FOUND', message: 'Listing not found', details: [] } } }];
}
const ch = errors.find((e) => e.field === 'change_id');
if (ch && ch.issue === 'not_found') return [{ json: { ok: false, gw, status: 404, error: { code: 'NOT_FOUND', message: 'Change not found', details: [ch] } } }];
if (ch) return [{ json: { ok: false, gw, status: 409, error: { code: 'CONFLICT', message: 'This change can no longer be applied', details: [ch] } } }];
return [{ json: { ok: false, gw, status: 422, error: { code: 'VALIDATION_FAILED', message: 'The change is invalid', details: errors } } }];
