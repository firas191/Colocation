// wf.eval.retrieval > "Summarize"
// Input: one item per finished run (from "Store results"). Final job output.
const plan = $('Start job').first().json;
const runs = $input.all().map((i) => i.json).filter((r) => r.run_id);
return [{ json: {
  job_id: plan.job_id,
  status: runs.length === plan.input.configs.length ? 'succeeded' : 'failed',
  error: runs.length === plan.input.configs.length ? null : `${runs.length} of ${plan.input.configs.length} runs finished`,
  output: { dataset: plan.input.dataset, version: plan.input.version, queries: plan.queries.length,
            runs: runs.map((r) => ({ run_id: r.run_id, config: r.config, summary: r.summary })) },
} }];
