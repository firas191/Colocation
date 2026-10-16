// Platform endpoints (n8n/build_platform.py) > "Validate"
// One shared validator: build_platform.py writes the endpoint's spec into SPEC below at build time.
// spec = {params: {name: 'uuid' | 'int'}, query: {name: rule}, body: JSON schema | null, rules: [...]}
// rule = {type: 'int', min, max} | {type: 'bool'} | {type: 'enum', values} | {type: 'string', max, pattern} | {type: 'uuid'} | {type: 'date'}
// Output: {ok, gw, input: {params, query, body}} for the database call, or a 404/422 rejection.
/* @include lib/schema_lite.js */
const SPEC = __SPEC__;
const gw = $input.first().json;
const ctx = gw.ctx || {};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reject = (status, code, message, details = []) => [{ json: { ok: false, gw, status, error: { code, message, details } } }];

// Path parameters: a malformed id is a resource that does not exist (404), as in the /v1 GET-by-id endpoints.
const params = {};
for (const [k, t] of Object.entries(SPEC.params || {})) {
  const v = String((ctx.params || {})[k] ?? '');
  if (t === 'uuid' && !UUID.test(v)) return reject(404, 'NOT_FOUND', 'Not found');
  if (t === 'int' && !/^\d{1,18}$/.test(v)) return reject(404, 'NOT_FOUND', 'Not found');
  params[k] = t === 'uuid' ? v.toLowerCase() : v;
}

const details = [];
const query = {};
const q = ctx.query || {};
const rules = SPEC.query || {};
for (const k of Object.keys(q)) if (!(k in rules)) details.push({ field: k, issue: 'unknown_parameter' });
for (const [k, r] of Object.entries(rules)) {
  if (q[k] === undefined || q[k] === null || String(q[k]) === '') continue;
  if (Array.isArray(q[k])) { details.push({ field: k, issue: 'repeated_parameter' }); continue; }
  const v = String(q[k]).trim();
  if (r.type === 'int') {
    if (!/^-?\d{1,18}$/.test(v) || (r.min !== undefined && Number(v) < r.min) || (r.max !== undefined && Number(v) > r.max)) {
      details.push({ field: k, issue: 'out_of_range', min: r.min, max: r.max });
    } else query[k] = Number(v);
  } else if (r.type === 'bool') {
    if (!['true', 'false'].includes(v)) details.push({ field: k, issue: 'must_be_true_or_false' }); else query[k] = v === 'true';
  } else if (r.type === 'enum') {
    if (!r.values.includes(v)) details.push({ field: k, issue: 'not_allowed', allowed: r.values }); else query[k] = v;
  } else if (r.type === 'uuid') {
    if (!UUID.test(v)) details.push({ field: k, issue: 'invalid_format' }); else query[k] = v.toLowerCase();
  } else if (r.type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v + 'T00:00:00Z'))) details.push({ field: k, issue: 'invalid_date' }); else query[k] = v;
  } else {
    if (Array.from(v).length > (r.max || 200)) details.push({ field: k, issue: 'too_long', max: r.max || 200 });
    else if (r.pattern && !new RegExp(r.pattern).test(v)) details.push({ field: k, issue: 'invalid_format' });
    else query[k] = v;
  }
}

let body = null;
if (SPEC.body) {
  body = ctx.body || {};
  for (const e of validate(SPEC.body, body)) details.push({ field: e.path.replace(/^\$\.?/, '') || 'body', issue: e.issue });
  // one of these fields must be given (JSON Schema's anyOf/required, which schema_lite does not cover)
  if (SPEC.require_any && !SPEC.require_any.some((f) => body[f] !== undefined && body[f] !== null)) {
    details.push({ field: SPEC.require_any.join('|'), issue: 'one_required' });
  }
}
if (details.length) return reject(422, 'VALIDATION_FAILED', 'Request is invalid', details);
return [{ json: { ok: true, gw, input: { params, query, body: body || {}, lang: ctx.lang || null } } }];
