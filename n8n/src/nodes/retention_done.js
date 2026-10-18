// wf.ops.retention > "Results": which jobs the Media service did (a job without keys is done at once); failed ones go
// back to the queue, up to five attempts (app.media_deletions_done).
const jobs = $('Each job').all().map((i) => i.json);
const res = $input.all().map((i) => i.json || {});
const out = jobs.map((j, k) => {
  const r = res[k] || {};
  const ok = j.empty || (r.statusCode === 200 && r.body && Number.isInteger(r.body.deleted));
  return { job_id: j.job_id, ok, deleted: ok && r.body ? r.body.deleted || 0 : 0 };
});
return [{ json: { results: JSON.stringify(out) } }];
