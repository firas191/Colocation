// wf.api.profiles_extract > "Validate body"
// POST /v1/profiles/extract  {text (required, up to 2000 characters), jurisdiction (default: the
// account's), save (default false: return the profile without storing it)}
const gw = $input.first().json;
const b = gw.ctx.body || {};
const user = gw.ctx.user || {};
const details = [];
for (const k of Object.keys(b)) if (!['text', 'jurisdiction', 'save'].includes(k)) details.push({ field: k, issue: 'unknown_field' });
const text = typeof b.text === 'string' ? b.text.trim() : '';
if (!text) details.push({ field: 'text', issue: 'required' });
else if (Array.from(text).length > 2000) details.push({ field: 'text', issue: 'too_long', max: 2000 });
const jurisdiction = b.jurisdiction === undefined ? user.jurisdiction_code : b.jurisdiction;
if (typeof jurisdiction !== 'string' || !/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(jurisdiction)) details.push({ field: 'jurisdiction', issue: jurisdiction ? 'invalid_format' : 'required' });
if (b.save !== undefined && typeof b.save !== 'boolean') details.push({ field: 'save', issue: 'must_be_boolean' });
if (details.length) {
  return [{ json: { ok: false, status: 422, gw, error: { code: 'VALIDATION_FAILED', message: 'Request body is invalid', details } } }];
}
// Dates are resolved against today's date in UTC (D-061).
return [{ json: { ok: true, gw, save: b.save === true, text, jurisdiction, today: new Date().toISOString().slice(0, 10) } }];
