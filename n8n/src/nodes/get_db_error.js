// GET-by-id endpoints (jobs, evaluation runs) > "Database error"
// Error output of the database step: the client gets 503, the log gets the redacted text.
/* @include lib/errors.js */
const gw = $('Gateway').first().json;
const msg = errorText($input.first().json);
return [{ json: { ok: false, gw, status: 503, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'A backend dependency is unavailable', details: [] }, log: { reason: 'database_error', detail: redactPg(msg).slice(0, 300) } } }];
