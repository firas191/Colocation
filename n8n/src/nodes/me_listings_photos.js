// wf.api.me_listings > "Photo request": the cover photo keys of the owner's listings, to be signed by the Media service.
const row = $input.first().json || {};
const cfg = row.cfg || {};
const r = row.r || {};
const keys = ((r.data && r.data.items) || []).map((x) => x.cover_key).filter(Boolean);
return [{ json: { url: `${String(cfg['services.media_url'] || '').replace(/\/+$/, '')}/v1/storage/presign-get`,
  body: { keys: keys.length ? keys : ['none/none'], expires_s: Number(cfg['media.photo_url_ttl_s'] || 900) } } }];
