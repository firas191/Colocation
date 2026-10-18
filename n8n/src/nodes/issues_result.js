// wf.api.issues_list > "Build result": each issue with its photos as signed URLs (keys never reach the client).
const gw = $('Gateway').first().json;
const r = ($('Call').first().json || {}).r || null;
if (!r || !r.status) return [{ json: { ok: false, gw, status: 500, error: { code: 'INTERNAL', message: 'Internal error', details: [] }, log: { reason: 'no_result' } } }];
if (r.error) return [{ json: { ok: false, gw, status: r.status, error: r.error } }];
const signed = $input.first().json || {};
let body = signed.body !== undefined ? signed.body : signed;
if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
const urls = new Map(((body && body.urls) || []).map((u) => [u.key, u]));
let missing = false;
const items = (r.data.items || []).map(({ photo_keys, ...i }) => {
  const photos = (photo_keys || []).map((k) => urls.get(k)).filter(Boolean).map((u) => ({ url: u.url, expires_at: u.expires_at }));
  if (photos.length < (photo_keys || []).length) missing = true;
  return { ...i, photos };
});
return [{ json: { ok: true, gw, status: 200, data: { items, my_role: r.data.my_role, warnings: missing ? ['photos_unavailable'] : [] } } }];
