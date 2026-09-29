// wf.api.users_sync > "Upsert failed"
// Error output of the upsert. Known constraint violations become client errors.
const gw = $('Validate body').first().json.gw;
/* @include lib/errors.js */
const msg = errorText($input.first().json);
// Postgres error text can contain the offending value (an email): never log it.
if (msg.includes('users_email_key') || (msg.includes('Key (email)=') && msg.includes('already exists'))) {
  return [{ json: { ok: false, gw, status: 409, error: { code: 'CONFLICT', message: 'This email is already linked to another account', details: [{ field: 'email' }] } } }];
}
if (msg.includes('users_jurisdiction_code_fkey') || msg.includes('is not present in table "jurisdictions"')) {
  return [{ json: { ok: false, gw, status: 422, error: { code: 'VALIDATION_FAILED', message: 'Request body is invalid', details: [{ field: 'jurisdiction_code', issue: 'unknown' }] } } }];
}
return [{ json: { ok: false, gw, status: 503, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'A backend dependency is unavailable', details: [] }, log: { reason: 'database_error', detail: redactPg(msg).slice(0, 300) } } }];
