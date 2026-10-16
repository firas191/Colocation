// wf.api.listings_public > "Photo request": the listing (published, or the caller's own as a preview) and its photo
// keys, to be signed by the Media service. A listing the caller may not see is 404, like one that does not exist.
const v = $('Validate').first().json;
const row = $input.first().json || {};
const view = row.v || { found: false };
const cfg = row.cfg || {};
if (!view.found) return [{ json: { found: false } }];
return [{ json: { found: true, url: `${String(cfg['services.media_url'] || '').replace(/\/+$/, '')}/v1/storage/presign-get`,
  body: { keys: (view.photos || []).map((p) => p.key), expires_s: Number(cfg['media.photo_url_ttl_s'] || 900) },
  is_favourite: (row.f || []).includes(v.input.params.id) } }];
