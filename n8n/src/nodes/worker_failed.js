// Worker workflows (wf.kb.ingest, wf.eval.retrieval) > "Job failed"
// Error output of any step after "Start job": the job ends as failed with the
// (redacted) error text, so it never stays "running" after a handled failure.
/* @include lib/errors.js */
const start = $('Start job').first().json;
const msg = redactPg(errorText($input.first().json)).slice(0, 500) || 'worker step failed without a message';
return [{ json: { job_id: start.job_id, status: 'failed', error: msg, output: { failed_step: true } } }];
