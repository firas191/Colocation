// Admin job endpoints > "Accepted"
// Input: the app.jobs row created for this request (after the worker was started).
// 202 with the job id and where to poll (spec 6.1 asynchronous calls).
const gw = $('Validate body').first().json.gw;
const row = $('Create job').first().json;
if (!row || !row.id) {
  return [{ json: { ok: false, gw, status: 422, error: { code: 'VALIDATION_FAILED', message: 'Request body is invalid', details: [{ field: row && row.reason || 'jurisdiction', issue: 'unknown' }] } } }];
}
return [{ json: { ok: true, gw, status: 202, data: { job_id: row.id, type: row.type, status: row.status, status_url: `/v1/jobs/${row.id}` } } }];
