// wf.api.issues_list > "Photo request": the processed photo keys of the issues, to be signed by the Media service.
const row = $input.first().json || {};
const cfg = row.cfg || {};
const items = ((row.r || {}).data || {}).items || [];
const keys = items.flatMap((i) => i.photo_keys || []).slice(0, 60);
return [{ json: { url: `${String(cfg['services.media_url'] || '').replace(/\/+$/, '')}/v1/storage/presign-get`,
  body: { keys: keys.length ? keys : ['media/none'], expires_s: Number(cfg['media.photo_url_ttl_s'] || 900) } } }];
