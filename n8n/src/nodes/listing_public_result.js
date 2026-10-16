// wf.api.listings_public > "Build result": the public fields and the photos as signed URLs (keys are dropped). If
// the Media service does not answer, the listing comes without photos and warnings holds photos_unavailable.
const v = $('Validate').first().json;
const view = $('Load').first().json.v;
const plan = $('Photo request').first().json;
const signed = $input.first().json || {};
let body = signed.body !== undefined ? signed.body : signed;
if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
const urls = new Map(((body && body.urls) || []).map((u) => [u.key, u]));
const photos = [];
for (const p of view.photos || []) {
  const u = urls.get(p.key);
  if (u) photos.push({ media_id: p.media_id, url: u.url, expires_at: u.expires_at, width: p.width ?? null, height: p.height ?? null });
}
const warnings = photos.length < (view.photos || []).length ? ['photos_unavailable'] : [];
return [{ json: { ok: true, gw: v.gw, status: 200,
  data: { listing: { ...view.listing, is_favourite: plan.is_favourite }, photos, photo_count: (view.photos || []).length,
          warnings, data_attribution: ['openstreetmap'] } } }];
