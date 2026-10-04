// wf.api.search > "Build result"
const v = $('Validate query').first().json;
const r = $input.first().json;
const si = $('Search input').first().json;
if (!r.ok) {
  return [{ json: { ok: false, gw: v.gw, status: 422, error: { code: 'VALIDATION_FAILED', message: 'Query parameters are invalid',
    details: [{ field: 'jurisdiction', issue: r.error_code || 'unknown' }] } } }];
}
return [{ json: { ok: true, gw: v.gw, status: 200,
  data: { mode: r.mode, count: r.count, results: r.results, applied: { ...r.applied, profile_fields_used: si.profile_fields_used },
          warnings: r.warnings, data_attribution: ['openstreetmap'] },
  meta: { timings: r.timings },
  steps: [{ agent: 'A3_match', model: r.applied && r.applied.vector ? 'bge-m3' : null, input: { mode: r.mode },
            output: { count: r.count, warnings: r.warnings }, latency_ms: r.timings.total_ms,
            tool_calls: [{ tool: 'app.search_public', db_ms: r.timings.db_ms, embed_ms: r.timings.embed_ms }] }] } }];
