// wf.api.me_consents > "Validate body"   POST /v1/me/consents (spec 6.2, 13.4)
// Records consent decisions for the calling user. Body: {consents: [{purpose, granted}], policy_version, source?}.
// No consent is required to call it (it is how consent is given).
/* @include lib/schema_lite.js */
const gw = $input.first().json;
const b = gw.ctx.body || {};
const schema = {
  type: 'object', additionalProperties: false, required: ['consents', 'policy_version'],
  properties: {
    consents: { type: 'array', minItems: 1, maxItems: 5, items: {
      type: 'object', additionalProperties: false, required: ['purpose', 'granted'],
      properties: { purpose: { type: 'string', enum: ['terms', 'privacy', 'cloud_llm_processing', 'media_processing', 'marketing'] },
        granted: { type: 'boolean' } } } },
    policy_version: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[\\w.:-]+$' },
    source: { type: 'string', enum: ['web', 'telegram', 'api'] },
  },
};
const details = validate(schema, b).map((e) => ({ field: e.path.replace(/^\$\.?/, '') || 'body', issue: e.issue }));
const purposes = (Array.isArray(b.consents) ? b.consents : []).map((c) => c && c.purpose);
if (new Set(purposes).size !== purposes.length) details.push({ field: 'consents', issue: 'duplicate_purpose' });
if (details.length) return [{ json: { ok: false, status: 422, gw, error: { code: 'VALIDATION_FAILED', message: 'Request body is invalid', details } } }];
return [{ json: { ok: true, gw, params: [gw.ctx.user_id, JSON.stringify({ consents: b.consents, policy_version: b.policy_version,
  source: b.source || 'web' })] } }];
