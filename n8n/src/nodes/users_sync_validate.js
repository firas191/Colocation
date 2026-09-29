// wf.api.users_sync > "Validate body"
// POST /v1/users/sync, called by the website server after login.
// Body: {external_auth_id (required), email, display_name, locale, jurisdiction_code}
const gw = $input.first().json;
const b = gw.ctx.body || {};
const allowed = ['external_auth_id', 'email', 'display_name', 'locale', 'jurisdiction_code'];
const details = [];
for (const k of Object.keys(b)) if (!allowed.includes(k)) details.push({ field: k, issue: 'unknown_field' });

const str = (k, max, re) => {
  const v = b[k];
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') { details.push({ field: k, issue: 'must_be_string' }); return ''; }
  const t = v.trim();
  if (t.length > max) details.push({ field: k, issue: 'too_long', max });
  else if (t && re && !re.test(t)) details.push({ field: k, issue: 'invalid_format' });
  return t;
};
const external_auth_id = str('external_auth_id', 255, /^[\x21-\x7e]+$/);
if (!external_auth_id) details.push({ field: 'external_auth_id', issue: 'required' });
const email = str('email', 254, /^[^\s@]+@[^\s@]+\.[^\s@]+$/).toLowerCase();
const display_name = str('display_name', 100, /^[^\u0000-\u001f\u007f]+$/);
const locale = str('locale', 35, /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);
const jurisdiction_code = str('jurisdiction_code', 10, /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/);

if (details.length) {
  return [{ json: { ok: false, status: 422, gw,
    error: { code: 'VALIDATION_FAILED', message: 'Request body is invalid', details } } }];
}
return [{ json: { ok: true, gw, params: [external_auth_id, email, display_name, locale, jurisdiction_code] } }];
