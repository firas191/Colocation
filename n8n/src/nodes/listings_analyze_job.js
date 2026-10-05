// wf.api.listings_analyze > "Job input": the listing must be the caller's and have text or files to analyze
// (phase 4.4: the text extraction runs even without files).
const v = $('Validate body').first().json;
const row = $input.first().json || {};
if (!row.mine) return [{ json: { ok: false, gw: v.gw, status: 404, error: { code: 'NOT_FOUND', message: 'Listing not found', details: [] } } }];
if (!['draft', 'processing', 'pending_review'].includes(row.status)) {
  return [{ json: { ok: false, gw: v.gw, status: 409, error: { code: 'CONFLICT', message: `Listing is ${row.status}`, details: [] } } }];
}
if (!Number(row.pending) && !row.has_text) {
  return [{ json: { ok: false, gw: v.gw, status: 422, error: { code: 'VALIDATION_FAILED', message: 'Nothing to analyze',
    details: [{ field: 'uploads', issue: 'none_pending' }] } } }];
}
const gw = v.gw;
const idem = gw.idempotency ? `${gw.idempotency.scope}:${gw.idempotency.key}` : null;
return [{ json: { ok: true, gw, params: [JSON.stringify({ listing_id: row.id, user_id: gw.ctx.user_id }), gw.ctx.user_id, idem, 'listing_analyze'] } }];
