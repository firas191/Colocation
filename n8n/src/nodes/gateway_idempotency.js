// wf.gateway.auth > "Apply idempotency"
// Input: {r} from app.idempotency_begin. Passes the request on, returns the
// stored response for a finished duplicate, or rejects a conflicting reuse.
const d = $('Decide').first().json;
const r = $input.first().json.r || {};
const reject = (status, code, message, reason) =>
  [{ json: { request_id: d.request_id, route: d.route, t0: d.t0, lang: d.lang, ok: false, status,
             error: { code, message, details: [] }, log: { reason }, idempotency: null } }];

if (r.state === 'new') return [{ json: { ...d, idempotency_took_over: !!r.took_over } }];
if (r.state === 'replay') {
  return [{ json: { request_id: d.request_id, route: d.route, t0: d.t0, lang: d.lang, ok: false,
                    replay: true, status: r.response_status, response: r.response_body,
                    log: { reason: 'idempotent_replay' }, idempotency: d.idempotency } }];
}
if (r.state === 'conflict') return reject(409, 'CONFLICT', 'X-Idempotency-Key was already used for a different request', 'idempotency_conflict');
return reject(409, 'CONFLICT', 'A request with this X-Idempotency-Key is still being processed', 'idempotency_in_progress');
