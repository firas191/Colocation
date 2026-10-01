// wf.kb.ingest > "Normalize result"
// Input: the outcome of wf.kb.ingest_source for the current source, or the
// error item when that workflow failed (Execute Workflow continues on error).
const cur = $('Loop sources').first().json;
const r = $input.first().json || {};
/* @include lib/errors.js */
let out;
if (r.status === 'ok' || r.status === 'skipped') {
  out = { ...r };
} else {
  out = {
    job_id: cur.job_id, source_id: cur.source.id, source_key: cur.source.source_key,
    status: 'failed', step: 'source_workflow', action: null,
    error: redactPg(errorText(r)).slice(0, 500) || 'source workflow failed without a message',
    detail: {}, ms: null,
  };
}
out.log = [cur.job_id, cur.source.id, cur.source.source_key, out.step || 'done', out.status,
  JSON.stringify({ action: out.action || null, chunks: out.chunks || null, embeddings: out.embeddings || null,
                   error: out.error || null, ...(out.detail || {}) }),
  out.ms == null ? null : Math.round(out.ms), out.status === 'failed' ? out.error : null];
return [{ json: out }];
