// wf.match.search > "Plan"
// Input: {jurisdiction, q, max_rent_minor, currency, budget_period, lat, lng, place, radius_m,
// limit} and settings. A text query is embedded (bge-m3, the model chosen in phase 2) unless empty.
const s = $('Start').first().json;
const cfg = $input.first().json.cfg || {};
const q = typeof s.q === 'string' ? s.q.trim() : '';
const p = { jurisdiction: s.jurisdiction, q_text: q || null, max_rent_minor: s.max_rent_minor ?? null, currency: s.currency || null,
  budget_period: s.budget_period || null, lat: s.lat ?? null, lng: s.lng ?? null, place: s.place || null,
  radius_m: s.radius_m ?? null, limit: s.limit ?? null };
return [{ json: { t0: Date.now(), p, embed: !!q, url: `${String(cfg['ollama.base_url'] || '').replace(/\/+$/, '')}/api/embed`,
  body: { model: cfg['ollama.embed_model'] || 'bge-m3', input: [q], truncate: true, keep_alive: cfg['llm.keep_alive'] || '10m' } } }];
