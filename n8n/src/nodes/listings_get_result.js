// wf.api.listings_get > "Build result"   GET /v1/listings/:id (owner view; the public view comes with publication)
const gw = $('Gateway ok?').first().json;
const v = ($input.first().json || {}).v;
if (!v) return [{ json: { ok: false, gw, status: 404, error: { code: 'NOT_FOUND', message: 'Listing not found', details: [] } } }];
return [{ json: { ok: true, gw, status: 200, data: v } }];
