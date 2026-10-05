// wf.api.listings_analyze > "Validate body"   POST /v1/listings/:id/analyze  {} (owner only)
// Runs the intake job on the uploaded files (spec 6.3, 11.2). Body must be empty.
const gw = $input.first().json;
const b = gw.ctx.body || {};
const details = Object.keys(b).map((k) => ({ field: k, issue: 'unknown_field' }));
if (details.length) return [{ json: { ok: false, status: 422, gw, error: { code: 'VALIDATION_FAILED', message: 'Request body is invalid', details } } }];
return [{ json: { ok: true, gw, params: [gw.ctx.user_id, gw.ctx.params.id || ''] } }];
