// wf.orchestrator > "Search result"
const v = $('Validate body').first().json;
const d = $('Decide route').first().json;
const x = $('Extract profile').first().json;
// When the Match agent ran and failed, this is the fallback path (D-084): its step and a warning are kept.
let ag = null;
try { ag = $('Match agent').first().json; } catch (e) { ag = null; }
const fb = ag && !ag.ok ? ['agent_fallback'] : [];
const steps = [...d.steps, ...(ag && ag.steps ? ag.steps : []), ...(x.steps || [])];
const mi = $('Match input').first().json;
if (mi.skip) {
  const status = x.error_code === 'UPSTREAM_UNAVAILABLE' ? 503 : 200;
  if (status === 503) return [{ json: { ok: false, gw: v.gw, status, steps, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'The language model is unavailable', details: [] } } }];
  return [{ json: { ok: true, gw: v.gw, status: 200, steps, data: { intent: 'search_listings', language: d.router.language,
    status: 'profile_failed', profile: null, results: [], warnings: [...fb, 'profile_extraction_failed'] } } }];
}
const m = $input.first().json;
steps.push({ agent: 'A3_match', model: m.applied && m.applied.vector ? 'bge-m3' : null, input: { mode: m.mode },
  output: { count: m.count, warnings: m.warnings }, latency_ms: m.timings ? m.timings.total_ms : null,
  tool_calls: [{ tool: 'app.search_public', db_ms: m.timings && m.timings.db_ms, embed_ms: m.timings && m.timings.embed_ms }] });
return [{ json: { ok: true, gw: v.gw, status: 200, steps, meta: { timings: m.timings },
  data: { intent: 'search_listings', language: d.router.language, status: m.ok ? 'results' : 'search_failed',
          profile: x.profile, anchor: x.anchor, results: m.ok ? m.results : [], count: m.ok ? m.count : 0,
          applied: m.applied || null, warnings: [...fb, ...(x.warnings || []), ...(m.warnings || [])], data_attribution: ['openstreetmap'] } } }];
