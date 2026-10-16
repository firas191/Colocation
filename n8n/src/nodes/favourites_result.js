// wf.api.favourites_list > "Build result": each favourite with its card, or listing null when the listing is no
// longer published (the user can still remove it). Next page: meta.next_before is in data, as in notifications.
const gw = $('Gateway').first().json;
const plan = $('Cards input').first().json;
if (!plan.ok) {
  const r = plan.r;
  if (r && r.error) return [{ json: { ok: false, gw, status: r.status, error: r.error } }];
  return [{ json: { ok: false, gw, status: 500, error: { code: 'INTERNAL', message: 'Internal error', details: [] }, log: { reason: 'no_result' } } }];
}
const row = $('Cards').first().json || {};
const cards = new Map((row.cards || []).map((c) => [c.id, c]));
const covers = new Map((row.covers || []).map((c) => [c.listing_id, c]));
const signed = $input.first().json || {};
let body = signed.body !== undefined ? signed.body : signed;
if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
const urls = new Map(((body && body.urls) || []).map((u) => [u.key, u]));
let missing = false;
const items = plan.r.data.items.map((f) => {
  const c = cards.get(f.listing_id) || null;
  const cov = covers.get(f.listing_id) || {};
  const key = cov.keys && cov.keys[0] && cov.keys[0].key;
  const u = key ? urls.get(key) : null;
  if (key && !u) missing = true;
  const { rank, score, dense_rank, lexical_rank, distance_m, ...card } = c || {};
  return { id: f.id, listing_id: f.listing_id, saved_at: f.saved_at, available: !!c,
    listing: c ? { ...card, photo_count: cov.count || 0, cover_photo: u ? { url: u.url, expires_at: u.expires_at } : null, is_favourite: true } : null };
});
return [{ json: { ok: true, gw, status: 200, data: { items, next_before: plan.r.data.next_before, total: plan.r.data.total,
  warnings: missing ? ['photos_unavailable'] : [] } } }];
