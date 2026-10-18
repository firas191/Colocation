// wf.api.document_get > "Sign request": a signed GET URL for the PDF (Media service, keys under documents/ only).
const r = ($input.first().json || {}).r || null;
const cfg = ($input.first().json || {}).cfg || {};
const key = r && r.data ? r.data.storage_key : null;
return [{ json: { r, url: `${String(cfg['services.media_url'] || '').replace(/\/+$/, '')}/v1/storage/presign-get`,
  body: { keys: key ? [key] : [], expires_s: Number(cfg['media.photo_url_ttl_s'] || 900) } } }];
