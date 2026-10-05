// wf.listing.analyze > "Job failed": a step failed in a way the worker did not plan for. The job ends as
// failed (not retried), with the redacted error, so it never stays "running".
/* @include lib/errors.js */
const s = $('Start job').first().json;
const msg = redactPg(errorText($input.first().json)).slice(0, 500) || 'worker step failed without a message';
return [{ json: { params: [s.job_id, 'failed', JSON.stringify({ failed_step: true }), msg, false] } }];
