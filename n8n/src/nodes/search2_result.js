// wf.api.search_v2 > "Build result": cards with their cover photo (signed URL), photo count and favourite flag, the
// next page's cursor in meta.next_cursor (null on the last page). If the Media service does not answer, the cards
// come without photos and warnings holds photos_unavailable.
/* @include lib/search2_query.js */
const v = $('Validate query').first().json;
const plan = $('Search input').first().json;
const prev = $('Query input').first().json;
const r = $('Search').first().json.r || {};
if (r.error) {
  return [{ json: { ok: false, gw: v.gw, status: 422, error: { code: 'VALIDATION_FAILED', message: 'Query parameters are invalid',
    details: [{ field: 'jurisdiction', issue: r.error }] } } }];
}
const fav = new Set((($('Favourites').first().json || {}).f) || []);
const signed = $('Cover URLs').first().json || {};
let body = signed.body !== undefined ? signed.body : signed;
if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
const urls = new Map(((body && body.urls) || []).map((u) => [u.key, u]));
const warnings = [...(r.warnings || [])];
if (prev.warning) warnings.push(prev.warning);
const covers = new Map((r.covers || []).map((c) => [c.listing_id, c]));
let missing = false;
const results = (r.results || []).map((x) => {
  const c = covers.get(x.id) || {};
  const u = c.key ? urls.get(c.key) : null;
  if (c.key && !u) missing = true;
  return { ...x, photo_count: c.count || 0, cover_photo: u ? { url: u.url, expires_at: u.expires_at } : null, is_favourite: fav.has(x.id) };
});
if (missing) warnings.push('photos_unavailable');
const next = r.next_offset === null || r.next_offset === undefined ? null : makeCursor(r.next_offset, v.fingerprint);
const total = Date.now() - plan.t0;
return [{ json: { ok: true, gw: v.gw, status: 200,
  data: { mode: r.mode, count: r.count, total_matching_filters: r.total_matching_filters, results,
          applied: { ...r.applied, offset: r.offset, profile_fields_used: plan.profile_fields_used }, warnings,
          data_attribution: ['openstreetmap'] },
  meta: { next_cursor: next, timings: { embed_ms: prev.embed_ms, db_ms: r.db_ms, total_ms: total } },
  steps: [{ agent: 'A3_match', model: r.applied && r.applied.vector ? 'bge-m3' : null, input: { mode: r.mode, version: 2 },
            output: { count: r.count, warnings }, latency_ms: total,
            tool_calls: [{ tool: 'app.search_public_v2', db_ms: r.db_ms, embed_ms: prev.embed_ms }] }] } }];
