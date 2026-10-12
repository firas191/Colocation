// wf.channel.telegram > "Job state": 0 = finished (read the listing), 1 = still running (wait again),
// 2 = still running after telegram.job_wait_s: say so once and keep waiting (the result is sent when it comes),
// 3 = still running after telegram.job_wait_max_s, or the job could not be read: give the listing id and stop.
const P = $('Plan').first().json;
const r = $input.first().json;
const job = ((r.body || {}).data) || {};
const loops = Math.ceil(P.job_wait_s / 10);
const maxLoops = Math.max(loops + 1, Math.ceil(P.job_wait_max_s / 10));
if (r.status === 200 && ['succeeded', 'failed', 'cancelled'].includes(job.status)) return [{ json: { state: 0, job } }];
if (r.status !== 200 || $runIndex + 1 >= maxLoops) return [{ json: { state: 3, job } }];
if ($runIndex + 1 === loops) return [{ json: { state: 2, job } }];
return [{ json: { state: 1, job } }];
