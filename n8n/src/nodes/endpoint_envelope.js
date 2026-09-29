// Shared by every API workflow > "Envelope"
// Input: either a handler result {ok:true, status, data, gw} or a rejection
// from the gateway or a handler {ok:false, status, error | replay+response}.
// Output: {status, response, finish} where finish is the app.api_finish payload.
const x = $input.first().json;
const gw = x.gw || x;                       // handlers carry the gateway item in x.gw
const t0 = gw.t0 || Date.now();
const latency = Date.now() - t0;
const requestId = gw.request_id || (gw.ctx && gw.ctx.request_id) || null;
let status, response;
if (x.replay) {
  status = x.status;
  response = x.response;                    // stored response, returned unchanged
} else if (x.ok) {
  status = x.status || 200;
  response = { request_id: requestId, data: x.data ?? {}, meta: { latency_ms: latency, ...(x.meta || {}) } };
} else {
  status = x.status || 500;
  const e = x.error || { code: 'INTERNAL', message: 'Internal error', details: [] };
  response = { request_id: requestId, error: { code: e.code, message: e.message, details: e.details || [] } };
}
const finish = {
  request_id: requestId,
  workflow: $workflow.name,
  n8n_execution_id: String($execution.id),
  user_id: (gw.ctx && gw.ctx.user_id) || '',
  channel: 'api',
  status_code: status,
  latency_ms: latency,
  error_code: response && response.error ? response.error.code : null,
  idempotency: gw.idempotency || null,
  idempotency_replay: !!x.replay,
  response_body: response,
  result_user_id: x.result_user_id || null,
  // reason and detail go to ai.executions.error only, never to the client
  error_detail: x.log ? [x.log.reason, x.log.detail].filter(Boolean).join(': ').slice(0, 500) : null,
};
const headers = { 'X-Request-Id': requestId || '', 'Cache-Control': 'no-store' };
if (status === 429) {
  const d = (response.error && response.error.details || []).find((y) => y.retry_after_s);
  if (d) headers['Retry-After'] = String(d.retry_after_s);
}
return [{ json: { status, response, finish, headers } }];
