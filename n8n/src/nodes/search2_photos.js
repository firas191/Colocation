// wf.api.search_v2 > "Photo request": the cover photo key of each result, to be signed by the Media service, and the
// caller's favourites among the results. Keys never reach the client.
const plan = $('Search input').first().json;
const r = $('Search').first().json.r || {};
const keys = (r.covers || []).map((c) => c.key).filter(Boolean);
return [{ json: { url: `${plan.media_url}/v1/storage/presign-get`, body: { keys, expires_s: plan.ttl_s },
  ids: JSON.stringify((r.results || []).map((x) => x.id)) } }];
