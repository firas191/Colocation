// wf.match.tool_search > "Session data": what is kept for the conversation (ids, understood profile, trace steps).
const s = $('Start').first().json;
const x = $('Extract profile').first().json;
let m = null;
try { m = $('Match').first().json; } catch (e) { m = null; }
const steps = [...(x.steps || [])];
if (m) steps.push({ agent: 'A3_match', model: m.applied && m.applied.vector ? 'bge-m3' : null, input: { mode: m.mode },
  output: { count: m.count, warnings: m.warnings }, latency_ms: m.timings ? m.timings.total_ms : null,
  tool_calls: [{ tool: 'app.search_public', db_ms: m.timings && m.timings.db_ms, embed_ms: m.timings && m.timings.embed_ms }] });
const results = m && m.ok ? (m.results || []).map((r) => ({ id: r.id, distance_m: r.distance_m ?? null, score: r.score ?? null })) : [];
return [{ json: { params: [s.session_id, s.user_id, s.request_id, JSON.stringify({
  results, profile: x.ok ? x.profile : null, anchor: x.ok ? x.anchor : null, steps })] } }];
