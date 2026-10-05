// wf.api.admin_traces_get > "Build result"   GET /v1/admin/traces/:request_id (admins; spec 6.2, 8.3)
// Every execution recorded for the request id (API requests and jobs) with its agent steps, prompt versions,
// timings and tokens. A malformed or unknown id answers 404.
const gw = $('Gateway').first().json;
const t = ($input.first().json || {}).t;
if (!t || !Array.isArray(t.executions) || !t.executions.length) {
  return [{ json: { ok: false, gw, status: 404, error: { code: 'NOT_FOUND', message: 'No trace for this request id', details: [] } } }];
}
return [{ json: { ok: true, gw, status: 200, data: t } }];
