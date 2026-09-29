// wf.gateway.auth > "Database unavailable"
// Error output of a Postgres node: no partial writes happened, answer 503.
const prep = $('Prepare request').first().json;
/* @include lib/errors.js */
const msg = errorText($input.first().json);
return [{ json: { request_id: prep.request_id, route: prep.route, t0: prep.t0, lang: prep.lang, ok: false, status: 503,
                  error: { code: 'UPSTREAM_UNAVAILABLE', message: 'A backend dependency is unavailable', details: [] },
                  log: { reason: 'database_error', detail: redactPg(msg).slice(0, 300) } } }];
