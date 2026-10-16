// wf.api.favourites_list > "Cards input": the caller's favourites (api.favourites_list, row-level layer) -> the ids
// whose public cards and cover photos to load. An error of the api call is passed on as it is.
const r = ($input.first().json || {}).r || null;
if (!r || r.error || !r.data) return [{ json: { ok: false, r } }];
const ids = (r.data.items || []).map((x) => x.listing_id);
return [{ json: { ok: true, r, params: [JSON.stringify(ids.map((id) => ({ id }))), `{${ids.join(',')}}`] } }];
