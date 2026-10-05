// wf.jobs.dispatch > "Dispatch": queued jobs whose retry time has come, by type. Only job types that use
// app.job_start / app.job_finish (retries with backoff) are listed here.
const WORKERS = { listing_analyze: true };
return $input.all().map((i) => i.json).filter((j) => j && j.id && WORKERS[j.type]).map((j) => ({ json: { id: j.id, type: j.type } }));
