// wf.kb.ingest_source > "Refused (address)": the source URL points inside the stack or the local network
// (lib/url_guard.js, D-111). Nothing was fetched. The source counts as failed, so the job fails and says why.
const x = $('Robots URL').first().json;
return [{ json: { job_id: x.job_id, source_id: x.source.id, source_key: x.source.source_key, ms: Date.now() - x.t0,
  status: 'failed', step: 'address', action: null, error: `refused_address: ${x.refused}`, detail: { url: x.source.url } } }];
