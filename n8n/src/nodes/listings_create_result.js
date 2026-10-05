// wf.api.listings_create > "Build result"
const v = $('Validate body').first().json;
const r = ($input.first().json || {}).r || {};
if (r.ok) {
  return [{ json: { ok: true, gw: v.gw, status: 201, result_user_id: null,
    data: { listing_id: r.listing_id, status: r.status, next: { upload: `/v1/listings/${r.listing_id}/media/presign`,
      analyze: `/v1/listings/${r.listing_id}/analyze` } } } }];
}
return [{ json: { ok: false, gw: v.gw, status: 422, error: { code: 'VALIDATION_FAILED', message: 'Request body is invalid',
  details: [{ field: r.field || 'body', issue: 'unknown' }] } } }];
