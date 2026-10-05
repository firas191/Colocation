// wf.api.listings_create > "Validate body"   POST /v1/listings
// A draft listing from the owner's text (spec 6.3). Extraction (P3), photos and checks run later
// in POST /v1/listings/:id/analyze. Body: {text, jurisdiction_code, kind?, title?}.
/* @include lib/schema_lite.js */
const gw = $input.first().json;
const b = gw.ctx.body || {};
const schema = {
  type: 'object', additionalProperties: false, required: ['text', 'jurisdiction_code'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 5000 },
    jurisdiction_code: { type: 'string', pattern: '^[A-Za-z]{2}$' },
    kind: { type: 'string', enum: ['room', 'shared_flat', 'roommate_wanted'] },
    title: { type: 'string', maxLength: 120 },
  },
};
const details = validate(schema, b).map((e) => ({ field: e.path.replace(/^\$\.?/, '') || 'body', issue: e.issue }));
if (!details.length && !String(b.text).trim()) details.push({ field: 'text', issue: 'blank' });
if (details.length) return [{ json: { ok: false, status: 422, gw, error: { code: 'VALIDATION_FAILED', message: 'Request body is invalid', details } } }];
return [{ json: { ok: true, gw, params: [gw.ctx.user_id, JSON.stringify({ ...b, text: String(b.text).trim() })] } }];
