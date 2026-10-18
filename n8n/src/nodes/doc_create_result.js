// wf.api.documents_create > "Build result": the stored document; the storage key stays inside (GET /v1/documents/{id}
// gives a signed download link). Values for unknown slots that were dropped are named in warnings.
const f = $('Fill').first().json;
const r = ($input.first().json || {}).r || null;
if (!r || !r.status) return [{ json: { ok: false, gw: f.gw, status: 500, error: { code: 'INTERNAL', message: 'Internal error', details: [] } } }];
if (r.error) return [{ json: { ok: false, gw: f.gw, status: r.status, error: { code: r.error.code, message: r.error.message, details: r.error.details || [] } } }];
const { storage_key, ...doc } = r.data;
return [{ json: { ok: true, gw: f.gw, status: 201, data: { ...doc, warnings: f.dropped.length ? ['unknown_slots_dropped'] : [], dropped: f.dropped } } }];
