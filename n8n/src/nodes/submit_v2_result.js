// wf.api.listings_submit_v2 > "Build result" (platform P12, D-112): 202 with the listing_trust job to follow, or
// the v1 answers (200 published without a check or already published; 404, 409, 422 as in v1).
const gw = $('Gateway').first().json;
const v = $('Validate').first().json;
const n = $('Next steps').first().json;
const r = n.r;
if (!r || typeof r !== 'object' || !r.status) {
  return [{ json: { ok: false, gw, status: 500, error: { code: 'INTERNAL', message: 'Internal error', details: [] }, log: { reason: 'no_result' } } }];
}
if (r.status === 202) {
  return [{ json: { ok: true, gw, status: 202, data: { listing_id: v.input.params.id, job_id: r.job_id, type: 'listing_trust',
    status: r.job_status, status_url: `/v1/jobs/${r.job_id}` } } }];
}
if (r.error) return [{ json: { ok: false, gw, status: r.status, error: { code: r.error.code, message: r.error.message, details: r.error.details || [] } } }];
const last = $input.first().json || {};
const embedded = n.embed ? last.stored !== undefined && last.stored !== null && !last.error : null;
return [{ json: { ok: true, gw, status: 200, data: { ...r.data, warnings: embedded === false ? ['embedding_pending'] : [] } } }];
