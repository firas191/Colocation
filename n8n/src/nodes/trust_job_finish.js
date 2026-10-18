// wf.listing.trust > "Finish input": the job's output (docs/openapi.yaml, POST /v2/listings/{id}/submit) and the
// Trust agent's steps for the trace (request id = the job id). outcome: published, in_review, rejected, or
// not_submitted when the listing no longer passes the checks. No stored report: a transient failure, retried once
// by wf.jobs.dispatch; then the job fails with trust_check_failed and the listing stays a draft.
const p = $('Plan').first().json;
const n = $('Next steps').first().json;
const r = n.r || {};
let steps = [];
try { steps = ($('Trust check').first().json || {}).steps || []; } catch (e) { steps = []; }
const last = $input.first().json || {};
const exec = String($execution.id || '');
const finish = (status, output, error, transient) => [{ json: { params: [p.job_id, status, JSON.stringify(output), error, transient,
  'wf.listing.trust', exec, JSON.stringify(steps)] } }];
const base = { listing_id: p.listing_id, listing: null, signals: [], error: null };
if (r.status === 200 && r.data) {
  const embedded = n.embed ? last.stored !== undefined && last.stored !== null && !last.error : null;
  return finish('succeeded', { ...base, outcome: 'published',
    listing: { ...r.data, warnings: embedded === false ? ['embedding_pending'] : [] } }, null, false);
}
const d = ((r.error || {}).details || [])[0] || {};
if (d.field === 'trust' && (d.issue === 'in_review' || d.issue === 'rejected')) {
  return finish('succeeded', { ...base, outcome: d.issue, signals: d.signals || [] }, null, false);
}
if (d.field === 'trust' && d.issue === 'missing') {
  return finish('failed', { ...base, outcome: null }, 'trust_check_failed', true);
}
if (r.error) {
  return finish('succeeded', { ...base, outcome: 'not_submitted',
    error: { code: r.error.code, details: r.error.details || [] } }, null, false);
}
return finish('failed', { ...base, outcome: null }, 'no_result', true);
