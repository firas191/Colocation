// Platform endpoints (n8n/build_platform.py) > "Build result"
// The api.* function answers {status, data, meta?} or {status, error}; this turns it into the item the Envelope expects
// (meta: the next page's cursor, when there is one).
const gw = $('Gateway').first().json;
const r = ($input.first().json || {}).r || null;
if (!r || typeof r !== 'object' || !r.status) {
  return [{ json: { ok: false, gw, status: 500, error: { code: 'INTERNAL', message: 'Internal error', details: [] },
    log: { reason: 'no_result' } } }];
}
if (r.error) return [{ json: { ok: false, gw, status: r.status, error: { code: r.error.code, message: r.error.message, details: r.error.details || [] } } }];
return [{ json: { ok: true, gw, status: r.status, data: r.data || {}, meta: r.meta || {} } }];
