// wf.ops.retention > "Each job" (platform P10, D-109): one item per file-deletion job (keys kept in the job by the
// erasure, backend spec 13.6), for the Media service's delete call. No job: no item, nothing else runs.
const row = $input.first().json || {};
const cfg = row.cfg || {};
const url = `${String(cfg['services.media_url'] || '').replace(/\/+$/, '')}/v1/storage/delete`;
return (row.jobs || []).filter((j) => Array.isArray(j.keys)).map((j) => ({ json: { job_id: j.job_id, url,
  body: { keys: j.keys.slice(0, 100) }, empty: j.keys.length === 0 } }));
