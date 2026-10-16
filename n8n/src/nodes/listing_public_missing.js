// wf.api.listings_public > "Not found": not published and not the caller's own, or no such listing.
const v = $('Validate').first().json;
return [{ json: { ok: false, gw: v.gw, status: 404, error: { code: 'NOT_FOUND', message: 'Listing not found', details: [] } } }];
