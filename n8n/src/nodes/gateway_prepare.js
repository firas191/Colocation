// wf.gateway.auth > "Prepare request"
// Input: one webhook item whose json has {headers, params, query, body} plus
// json.route = {method, template, require_user, idempotent, required_consents, roles}
// and json.t0 (ms). The raw body is in binary.data (Webhook option rawBody).
/* @include lib/canonical.js */

const item = $input.first();
const j = item.json;
const h = j.headers || {};
const route = j.route || {};
const ridHeader = header(h, 'x-request-id');
const request_id = ridHeader && UUID_RE.test(ridHeader) ? ridHeader.toLowerCase() : correlationId();
const base = {
  request_id, route, t0: j.t0 || Date.now(), lang: header(h, 'accept-language'),
  input: { params: j.params || {}, query: j.query || {} },
};
const reject = (status, code, message, details = [], reason = null) =>
  [{ json: { ...base, ok: false, status, error: { code, message, details }, log: { reason } } }];

const q = canonicalQuery(j.query);
if (!q.ok) return reject(422, 'VALIDATION_FAILED', 'Nested query parameters are not supported', [{ field: q.field }], 'nested_query');

let body_b64 = '';
if (item.binary && item.binary.data) {
  const buf = await this.helpers.getBinaryDataBuffer(0, 'data');
  body_b64 = buf.toString('base64');
}

// IPs for rate limiting (app.gateway_check picks one): the signed X-Client-Ip
// sent by the website server, and the address the proxy saw (X-Forwarded-For,
// set by Caddy, which does not trust an incoming X-Forwarded-For).
const clientIp = header(h, 'x-client-ip');
const xff = (header(h, 'x-forwarded-for') || '').split(',').pop().trim();

const check = {
  key_id: header(h, 'x-key-id'),
  timestamp: header(h, 'x-timestamp'),
  method: String(route.method || '').toUpperCase(),
  path: buildPath(route.template, j.params),
  query: q.value,
  request_id: ridHeader,
  user_id: header(h, 'x-user-id') || '',
  idempotency_key: header(h, 'x-idempotency-key') || '',
  client_ip: clientIp || '',
  body_b64,
  signature: header(h, 'x-signature'),
  network_ip: xff || '',
};

return [{ json: { ...base, ok: true, check, body: j.body ?? null, content_type: header(h, 'content-type') } }];
