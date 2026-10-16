// wf.api.search_v2 > "Search input": explicit parameters win; with use_profile=true, missing ones come from the saved
// profile (same rule as GET /v1/search). Then the plan: a text query is embedded with bge-m3 unless empty.
const v = $('Validate query').first().json;
const row = $input.first().json || {};
const prof = row.profile || null;
const cfg = row.cfg || {};
const i = { ...v.input };
const used = [];
if (prof) {
  if (!i.jurisdiction && prof.jurisdiction_code) { i.jurisdiction = prof.jurisdiction_code; used.push('jurisdiction'); }
  if (i.max_rent_minor === null && prof.budget_max_minor !== null) {
    i.max_rent_minor = prof.budget_max_minor; i.currency = prof.currency; i.budget_period = prof.budget_period; used.push('budget');
  }
  if (i.lat === null && !i.place && !i.bbox && prof.lat !== null && prof.lng !== null) {
    i.lat = prof.lat; i.lng = prof.lng; if (i.radius_m === null) i.radius_m = prof.radius_m; used.push('anchor');
  }
}
if (!i.jurisdiction) i.jurisdiction = i.account_jurisdiction;
const q = (i.q || '').trim();
const p = { jurisdiction: i.jurisdiction, q_text: q || null, max_rent_minor: i.max_rent_minor, currency: i.currency,
  budget_period: i.budget_period, lat: i.lat, lng: i.lng, place: i.place, radius_m: i.radius_m, limit: i.limit,
  offset: v.offset, kind: i.kind, furnished: i.furnished, bills_included: i.bills_included, available_by: i.available_by,
  amenities: i.amenities, house_rules: i.house_rules, bbox: i.bbox, ids: i.ids };
return [{ json: { t0: Date.now(), p, profile_fields_used: used, no_jurisdiction: !i.jurisdiction, embed: !!q,
  media_url: String(cfg['services.media_url'] || '').replace(/\/+$/, ''), ttl_s: Number(cfg['media.photo_url_ttl_s'] || 900),
  url: `${String(cfg['ollama.base_url'] || '').replace(/\/+$/, '')}/api/embed`,
  body: { model: cfg['ollama.embed_model'] || 'bge-m3', input: [q], truncate: true, keep_alive: cfg['llm.keep_alive'] || '10m' } } }];
