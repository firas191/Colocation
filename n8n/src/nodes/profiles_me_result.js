// wf.api.profiles_me > "Build result" / "Save failed"
/* @include lib/errors.js */
const v = $('Validate body').first().json;
const r = $input.first().json;
if (r.saved) return [{ json: { ok: true, gw: v.gw, status: 200, data: r.saved } }];
// unknown jurisdiction or currency (foreign key), or a check constraint
const msg = errorText(r);
const field = /currency/.test(msg) ? 'currency' : /jurisdiction/.test(msg) ? 'jurisdiction_code' : 'body';
return [{ json: { ok: false, gw: v.gw, status: 422, error: { code: 'VALIDATION_FAILED', message: 'Request body is invalid',
  details: [{ field, issue: 'rejected_by_database' }] }, log: { reason: 'save_profile', detail: redactPg(msg).slice(0, 200) } } }];
