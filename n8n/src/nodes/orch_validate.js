// wf.orchestrator > "Validate body"
// POST /v1/assistant/message {text (required, up to 2000 characters), jurisdiction (default: the
// account's)}. Media ids come with phase 4.
const gw = $input.first().json;
const b = gw.ctx.body || {};
const user = gw.ctx.user || {};
const details = [];
for (const k of Object.keys(b)) if (!['text', 'jurisdiction'].includes(k)) details.push({ field: k, issue: 'unknown_field' });
const text = typeof b.text === 'string' ? b.text.trim() : '';
if (!text) details.push({ field: 'text', issue: 'required' });
else if (Array.from(text).length > 2000) details.push({ field: 'text', issue: 'too_long', max: 2000 });
const jurisdiction = b.jurisdiction === undefined ? (user.jurisdiction_code || null) : b.jurisdiction;
if (jurisdiction !== null && (typeof jurisdiction !== 'string' || !/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(jurisdiction))) details.push({ field: 'jurisdiction', issue: 'invalid_format' });
if (details.length) {
  return [{ json: { ok: false, status: 422, gw, error: { code: 'VALIDATION_FAILED', message: 'Request body is invalid', details } } }];
}
return [{ json: { ok: true, gw, text, jurisdiction, today: new Date().toISOString().slice(0, 10) } }];
