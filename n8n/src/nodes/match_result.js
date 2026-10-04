// wf.match.search > "Result"
// app.search_public answer plus timings: embed_ms (query embedding), db_ms (inside the
// database), total_ms (whole sub-workflow). Spec 2.6: search p95 excluding explanations.
const plan = $('Plan').first().json;
const prev = $('Search input').first().json;
const r = $input.first().json.r || {};
if (r.error) return [{ json: { ok: false, error_code: r.error } }];
const warnings = [...(r.warnings || [])];
if (prev.warning) warnings.push(prev.warning);
return [{ json: { ok: true, mode: r.mode, results: r.results || [], count: r.count || 0, applied: r.applied, warnings,
  timings: { embed_ms: prev.embed_ms, db_ms: r.db_ms, total_ms: Date.now() - plan.t0 } } }];
