// wf.api.jobs_get > "Build result"
// GET /v1/jobs/:id. The job is visible to the user who requested it and to
// admins and moderators. Anything else, including a malformed id, is 404 so
// the existence of other users' jobs is not revealed.
const gw = $('Gateway').first().json;
const row = $input.first().json;
const user = gw.ctx.user || {};
const visible = row && row.id && (row.requested_by === gw.ctx.user_id || ['admin', 'moderator'].includes(user.role));
if (!visible) {
  return [{ json: { ok: false, gw, status: 404, error: { code: 'NOT_FOUND', message: 'Job not found', details: [] } } }];
}
return [{ json: { ok: true, gw, status: 200, data: {
  job_id: row.id, type: row.type, status: row.status, attempts: row.attempts,
  created_at: row.created_at, started_at: row.started_at, finished_at: row.finished_at,
  output: row.output, error: row.error,
} } }];
