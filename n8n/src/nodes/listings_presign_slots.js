// wf.api.listings_presign > "Slots": one item per upload slot to sign, or a rejection.
const v = $('Validate body').first().json;
const r = ($input.first().json || {}).r || {};
if (!r.ok) {
  const code = r.error_code || 'VALIDATION_FAILED';
  const status = { NOT_FOUND: 404, CONFLICT: 409 }[code] || 422;
  const message = { NOT_FOUND: 'Listing not found', CONFLICT: `Listing cannot take media (${r.message || ''})` }[code] || 'Request body is invalid';
  return [{ json: { reject: true, ok: false, gw: v.gw, status, error: { code, message, details: r.details || [] } } }];
}
const cfg = $('Settings').first().json;
return r.uploads.map((u) => ({ json: { reject: false, upload: u, expires_s: r.expires_s,
  url: `${String(cfg.media_url).replace(/\/+$/, '')}/v1/storage/presign`,
  body: { key: u.key, content_type: u.content_type, expires_s: r.expires_s } } }));
