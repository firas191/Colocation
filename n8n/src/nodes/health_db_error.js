// wf.api.health > "Database check failed"
// The gateway reached the database but the health query failed afterwards.
const gw = $('Gateway').first().json;
/* @include lib/errors.js */
const msg = errorText($input.first().json);
return [{ json: { ok: false, gw, status: 503,
  error: { code: 'UPSTREAM_UNAVAILABLE', message: 'A backend dependency is unavailable', details: [{ dependency: 'database' }] },
  log: { reason: 'database_error', detail: redactPg(msg).slice(0, 300) } } }];
