// wf.api.listings_submit > "Build result": app.listing_submit's {status, data | error} for the Envelope. The text
// to embed and the model settings stay inside the workflow. embedded: whether the vector was stored now. The trust
// check's trace step (P8, D-107) goes with the request.
const gw = $('Gateway').first().json;
const n = $('Next steps').first().json;
const r = n.r;
let steps = [];
try { steps = ($('Trust check').first().json || {}).steps || []; } catch (e) { steps = []; }
if (!r || typeof r !== 'object' || !r.status) {
  return [{ json: { ok: false, gw, status: 500, error: { code: 'INTERNAL', message: 'Internal error', details: [] }, log: { reason: 'no_result' } } }];
}
if (r.error) return [{ json: { ok: false, gw, status: r.status, steps, error: { code: r.error.code, message: r.error.message, details: r.error.details || [] } } }];
// the item comes from "Store vector" ({stored}) when the vector was written, otherwise from a skipped branch
const last = $input.first().json || {};
const embedded = n.embed ? last.stored !== undefined && last.stored !== null && !last.error : null;
return [{ json: { ok: true, gw, status: 200, steps, data: { ...r.data, warnings: embedded === false ? ['embedding_pending'] : [] } } }];
