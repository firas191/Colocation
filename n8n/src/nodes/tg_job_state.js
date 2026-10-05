// wf.channel.telegram > "Job state": 0 = finished (read the listing), 1 = still running (wait again),
// 2 = waited too long (telegram.job_wait_s) or the job could not be read.
const P = $('Plan').first().json;
const r = $input.first().json;
const job = ((r.body || {}).data) || {};
const loops = Math.ceil(P.job_wait_s / 10);
if (r.status === 200 && ['succeeded', 'failed', 'cancelled'].includes(job.status)) return [{ json: { state: 0, job } }];
if (r.status === 200 && $runIndex + 1 < loops) return [{ json: { state: 1, job } }];
return [{ json: { state: 2, job } }];
