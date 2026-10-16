// wf.api.favourites_list > "Photo request": cover keys of the cards, to be signed by the Media service.
const row = $input.first().json || {};
const cfg = row.cfg || {};
const keys = (row.covers || []).map((c) => c.keys && c.keys[0] && c.keys[0].key).filter(Boolean);
return [{ json: { url: `${String(cfg['services.media_url'] || '').replace(/\/+$/, '')}/v1/storage/presign-get`,
  body: { keys, expires_s: Number(cfg['media.photo_url_ttl_s'] || 900) } } }];
