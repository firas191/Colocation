// Pure helpers shared by Code nodes and unit tests (n8n/tests/canonical.test.js).
// n8n/build.py inlines this file into Code nodes that contain the marker
// "/* @include lib/canonical.js */". Keep it free of n8n globals.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Path from a route template like "/v1/listings/:id/analyze" and the params object.
function buildPath(template, params) {
  return String(template || '').replace(/:([A-Za-z_][A-Za-z0-9_]*)/g,
    (_, k) => encodeURIComponent(String((params || {})[k] ?? '')));
}

// Canonical query string: encodeURIComponent(key)=encodeURIComponent(value),
// pairs sorted by encoded key (stable, so repeated keys keep their order).
// Returns { ok: true, value } or { ok: false, field } for nested values.
function canonicalQuery(query) {
  const pairs = [];
  for (const [k, v] of Object.entries(query || {})) {
    for (const x of (Array.isArray(v) ? v : [v])) {
      if (typeof x !== 'string') return { ok: false, field: k };
      pairs.push([encodeURIComponent(k), encodeURIComponent(x)]);
    }
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { ok: true, value: pairs.map(([k, v]) => `${k}=${v}`).join('&') };
}

// First non-empty string value of a header (Node lower-cases header names).
function header(headers, name) {
  const v = (headers || {})[name];
  if (Array.isArray(v)) return v.length ? String(v[0]) : null;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// Random v4-style uuid for correlation ids when the caller sent none.
// Not used for anything security-relevant (Code nodes cannot load node:crypto).
function correlationId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function envelopeError(requestId, code, message, details) {
  return { request_id: requestId, error: { code, message, details: details || [] } };
}

const ERROR_STATUS = {
  UNAUTHENTICATED: 401, FORBIDDEN: 403, VALIDATION_FAILED: 422, NOT_FOUND: 404,
  CONSENT_REQUIRED: 403, RATE_LIMITED: 429, CONFLICT: 409, UPSTREAM_UNAVAILABLE: 503,
  POLICY_BLOCKED: 403, INTERNAL: 500, PAYLOAD_TOO_LARGE: 413, EXTRACTION_FAILED: 422,
};

if (typeof module !== 'undefined') {
  module.exports = { UUID_RE, buildPath, canonicalQuery, header, correlationId, envelopeError, ERROR_STATUS };
}
