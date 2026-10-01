// wf.api.admin_kb_ingest > "Validate body"
// POST /v1/admin/kb/ingest  (role admin)
// Body: {jurisdiction (required), include_global (default true), sources: [source_key] (optional),
//        force (default false)}
const gw = $input.first().json;
const b = gw.ctx.body;
const details = [];
if (b === null || typeof b !== 'object' || Array.isArray(b)) {
  return [{ json: { ok: false, status: 422, gw, error: { code: 'VALIDATION_FAILED', message: 'Request body must be a JSON object', details: [] } } }];
}
const allowed = ['jurisdiction', 'include_global', 'sources', 'force'];
for (const k of Object.keys(b)) if (!allowed.includes(k)) details.push({ field: k, issue: 'unknown_field' });
const j = b.jurisdiction;
if (typeof j !== 'string' || !/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(j)) details.push({ field: 'jurisdiction', issue: 'invalid_format' });
for (const k of ['include_global', 'force']) {
  if (b[k] !== undefined && typeof b[k] !== 'boolean') details.push({ field: k, issue: 'must_be_boolean' });
}
let sources = [];
if (b.sources !== undefined) {
  if (!Array.isArray(b.sources) || b.sources.length > 200) details.push({ field: 'sources', issue: 'must_be_array_max_200' });
  else {
    b.sources.forEach((s, i) => {
      if (typeof s !== 'string' || !/^[a-z0-9][a-z0-9-]{2,79}$/.test(s)) details.push({ field: `sources[${i}]`, issue: 'invalid_format' });
    });
    sources = [...new Set(b.sources)];
  }
}
if (details.length) {
  return [{ json: { ok: false, status: 422, gw, error: { code: 'VALIDATION_FAILED', message: 'Request body is invalid', details } } }];
}
const input = { jurisdiction: j, include_global: b.include_global !== false, sources, force: b.force === true };
const idem = gw.idempotency ? `${gw.idempotency.scope}:${gw.idempotency.key}` : null;
return [{ json: { ok: true, gw, params: [JSON.stringify(input), gw.ctx.user_id, idem, 'kb_ingest'] } }];
