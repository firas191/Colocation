// wf.api.admin_eval_runs_get > "Build result"
// GET /v1/admin/eval/runs/:id (role admin): one run, its configuration, summary
// and per-query metrics (retrieved lists are left out; they are in eval.results).
const gw = $('Gateway').first().json;
const row = $input.first().json;
if (!row || !row.id) {
  return [{ json: { ok: false, gw, status: 404, error: { code: 'NOT_FOUND', message: 'Evaluation run not found', details: [] } } }];
}
return [{ json: { ok: true, gw, status: 200, data: {
  run_id: row.id, dataset: row.dataset, status: row.status, config: row.config, git_sha: row.git_sha,
  job_id: row.job_id, started_at: row.started_at, finished_at: row.finished_at, summary: row.summary,
  queries: row.queries || [],
} } }];
