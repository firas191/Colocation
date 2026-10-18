// wf.api.me_listings > "Build result": app.me_listings' answer with each cover key replaced by a signed URL. If the
// Media service does not answer, the covers are left out with the warning photos_unavailable (the list still shows).
const gw = $('Gateway').first().json;
const r = ($('Call').first().json || {}).r || null;
if (!r || typeof r !== 'object' || !r.status) {
  return [{ json: { ok: false, gw, status: 500, error: { code: 'INTERNAL', message: 'Internal error', details: [] }, log: { reason: 'no_result' } } }];
}
if (r.error) return [{ json: { ok: false, gw, status: r.status, error: r.error } }];
const signed = $input.first().json || {};
let body = signed.body !== undefined ? signed.body : signed;
if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
const urls = new Map(((body && body.urls) || []).map((u) => [u.key, u]));
let missing = false;
const items = (r.data.items || []).map(({ cover_key, ...x }) => {
  const u = cover_key ? urls.get(cover_key) : null;
  if (cover_key && !u) missing = true;
  return { ...x, cover_photo: u ? { url: u.url, expires_at: u.expires_at } : null };
});
return [{ json: { ok: true, gw, status: 200, data: { items, counts: r.data.counts, warnings: missing ? ['photos_unavailable'] : [] },
  meta: { next_cursor: (r.meta && r.meta.next_cursor) || null } } }];
