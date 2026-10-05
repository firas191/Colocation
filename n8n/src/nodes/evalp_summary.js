// wf.eval.prompts > "Summarize"
// Input: one row per run with every stored result. Output: run summaries (spec 9.5 step 1)
// and the failures to record in ai.prompt_failures (step 2), one per item and category.
/* @include eval/lib/prompt_metrics.js */
const runs = $input.all().map((i) => i.json).filter((r) => r.run_id);
const summaries = [];
const failures = [];
for (const run of runs) {
  const rows = (run.results || []).map((x) => ({ metrics: x.metrics, tags: x.tags, latency_ms: x.output.latency_ms,
    tokens_in: x.output.tokens_in, tokens_out: x.output.tokens_out, attempts: x.output.attempts, call_error: x.metrics.call_error }));
  const summary = run.config.prompt === 'P1_router' ? summarizeP1(rows)
    : run.config.prompt === 'P3_listing_extractor' ? summarizeP3(rows)
    : run.config.prompt === 'P7_photo_analyzer' ? summarizeP7(rows) : summarizeP2(rows);
  summary.load_ms_total = (run.results || []).reduce((a, x) => a + (x.output.load_ms || 0), 0);
  summaries.push({ run_id: run.run_id, summary });
  for (const x of run.results || []) {
    for (const cat of x.metrics.failures || []) {
      failures.push({ prompt_version_id: run.prompt_version_id, eval_run_id: run.run_id, item_id: x.external_id, category: cat,
        input: x.query, observed: x.output.raw || x.output.detail || x.output.error_code || '',
        expected: JSON.stringify(x.labels) });
    }
  }
}
return [{ json: { job_id: $('Plan').first().json.job_id, summaries, failures,
  brief: summaries.map((s) => {
    const run = runs.find((r) => r.run_id === s.run_id);
    const x = s.summary;
    return { run_id: s.run_id, model: run.config.model, version: run.config.version, items: x.items, json_valid: x.json_valid,
      intent_accuracy: x.intent_accuracy, f1: x.f1, f1_checked: x.checked ? x.checked.f1 : undefined, unit_error_items: x.unit_error_items,
      unit_error_items_checked: x.unit_error_items_checked, field_accuracy: x.field_accuracy,
      hallucination_rate: x.hallucination_rate, people_described_items: x.people_described_items, latency_p95_ms: x.latency_p95_ms };
  }).sort((a, b) => (a.model + a.version > b.model + b.version ? 1 : -1)) } }];
