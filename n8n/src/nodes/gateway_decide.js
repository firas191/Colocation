// wf.gateway.auth > "Decide"
// Input: {g} from app.gateway_check. Applies the gateway rules in order and
// returns ok:true with the request context, or ok:false with an error envelope.
const prep = $('Prepare request').first().json;
const g = $input.first().json.g || {};
const route = prep.route || {};
const base = { request_id: prep.request_id, route, t0: prep.t0, lang: prep.lang };
const reject = (status, code, message, details = [], reason = null) =>
  [{ json: { ...base, ok: false, status, error: { code, message, details }, log: { reason } } }];

const v = g.verify || {};
const ctx = g.context || {};
const s = ctx.settings || {};
const rate = g.rate || {};
const limitIp = Number(s['gateway.rate_limit_ip_per_min'] ?? 120);
const limitUser = Number(s['gateway.rate_limit_user_per_min'] ?? 60);
const retryAfter = 60 - (Math.floor(Date.now() / 1000) % 60);

// 1. Per-IP limit first: it also counts requests with bad signatures.
if (Number(rate.ip) > limitIp) return reject(429, 'RATE_LIMITED', 'Too many requests', [{ retry_after_s: retryAfter }], 'ip_limit');

// 2. Signature, timestamp window, replay.
if (!v.ok) {
  if (v.reason === 'stale_timestamp') {
    return reject(401, 'UNAUTHENTICATED', 'X-Timestamp is outside the accepted window', [{ server_time: v.server_time }], v.reason);
  }
  return reject(401, 'UNAUTHENTICATED', 'Request signature could not be verified', [], v.reason || 'unknown');
}

// 3. Per-user limit (counted only for verified requests).
if (rate.user != null && Number(rate.user) > limitUser) {
  return reject(429, 'RATE_LIMITED', 'Too many requests', [{ retry_after_s: retryAfter }], 'user_limit');
}

// 4. User, role, consent.
const uid = prep.check.user_id;
const user = ctx.user || null;
if (uid && !user) return reject(401, 'UNAUTHENTICATED', 'Unknown user', [], 'unknown_user');
if (user && user.deleted) return reject(403, 'FORBIDDEN', 'This account has been erased', [], 'erased_user');
if (route.require_user && !user) return reject(401, 'UNAUTHENTICATED', 'X-User-Id is required for this endpoint', [], 'user_required');
if (Array.isArray(route.roles) && route.roles.length > 0 && !(user && route.roles.includes(user.role))) {
  return reject(403, 'FORBIDDEN', 'Your role does not allow this action', [], 'role');
}
for (const purpose of route.required_consents || []) {
  if (!ctx.consents || ctx.consents[purpose] !== true) {
    return reject(403, 'CONSENT_REQUIRED', 'Consent is required for this action', [{ purpose }], 'consent');
  }
}

// 5. Body shape for methods that carry one.
if (['POST', 'PUT', 'PATCH'].includes(String(route.method).toUpperCase())) {
  if (!String(prep.content_type || '').toLowerCase().startsWith('application/json')) {
    return reject(422, 'VALIDATION_FAILED', 'Content-Type must be application/json', [], 'content_type');
  }
  if (prep.body === null || typeof prep.body !== 'object' || Array.isArray(prep.body)) {
    return reject(422, 'VALIDATION_FAILED', 'Body must be a JSON object', [], 'body_shape');
  }
}

// 6. Idempotency key on state-changing routes.
const idem = prep.check.idempotency_key;
if (route.idempotent && !/^[A-Za-z0-9_.:-]{8,128}$/.test(idem)) {
  return reject(422, 'VALIDATION_FAILED', 'X-Idempotency-Key is required: 8 to 128 characters from A-Z a-z 0-9 _ . : -', [], 'idempotency_key');
}

return [{
  json: {
    ...base,
    ok: true,
    ctx: {
      request_id: prep.request_id, key_id: v.key_id, user_id: uid || null, user,
      consents: ctx.consents || {}, lang: prep.lang, client_ip: prep.check.client_ip || null,
      params: prep.input.params, query: prep.input.query, body: prep.body,
    },
    idempotency: route.idempotent
      ? { scope: `${v.key_id}:${uid || 'anon'}`, key: idem, route: `${String(route.method).toUpperCase()} ${route.template}`, body_sha256: v.body_sha256 }
      : null,
  },
}];
