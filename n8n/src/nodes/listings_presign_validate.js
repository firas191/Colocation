// wf.api.listings_presign > "Validate body"   POST /v1/listings/:id/media/presign
// Body: {files: [{kind, content_type, bytes}]} (1 to 10). The database checks ownership, listing state,
// accepted types and sizes per kind (settings media.*); the Media service signs one PUT URL per file.
/* @include lib/schema_lite.js */
const gw = $input.first().json;
const b = gw.ctx.body || {};
const schema = {
  type: 'object', additionalProperties: false, required: ['files'],
  properties: { files: { type: 'array', minItems: 1, maxItems: 10, items: {
    type: 'object', additionalProperties: false, required: ['kind', 'content_type', 'bytes'],
    properties: { kind: { type: 'string', enum: ['photo', 'audio', 'video', 'pdf'] },
      content_type: { type: 'string', maxLength: 100 }, bytes: { type: 'integer', minimum: 1, maximum: 104857600 } } } } },
};
const details = validate(schema, b).map((e) => ({ field: e.path.replace(/^\$\.?/, '') || 'body', issue: e.issue }));
if (details.length) return [{ json: { ok: false, status: 422, gw, error: { code: 'VALIDATION_FAILED', message: 'Request body is invalid', details } } }];
return [{ json: { ok: true, gw, params: [gw.ctx.user_id, gw.ctx.params.id || '', JSON.stringify(b.files)] } }];
