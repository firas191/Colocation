// wf.kb.ingest > "Summarize"
// Input: one result per source from wf.kb.ingest_source (the loop's "done"
// output), or the {empty} item from "Plan". Output: the job's final state.
const items = $input.all().map((i) => i.json);
const plan = $('Plan').first().json;
if (plan.empty) {
  return [{ json: { job_id: plan.job_id, status: 'failed', error: plan.reason,
                    output: { sources: [], unknown_sources: plan.unknown_sources || [] } } }];
}
const results = items.map((r) => ({
  source_key: r.source_key || (r.source && r.source.source_key) || null,
  status: r.status || 'failed',
  step: r.step || null,
  action: r.action || null,
  error: r.status === 'ok' || r.status === 'skipped' ? null : (r.error || errorOf(r)),
  reason: r.status !== 'skipped' ? null : r.step === 'robots' && r.detail && r.detail.robots
    ? r.detail.robots.reason + (r.detail.robots.rule ? ` (${r.detail.robots.rule})` : '') + ` [robots.txt HTTP ${r.detail.robots.status}]`
      + (r.detail.robots.error ? ` ${r.detail.robots.error}` : '')
    : r.step,
  chunks: r.chunks || null,
  embeddings: r.embeddings || null,
  ms: r.ms || null,
}));
function errorOf(r) {
  const e = r.error;
  if (!e) return 'no result from the source workflow';
  return typeof e === 'string' ? e : (e.message || JSON.stringify(e)).slice(0, 300);
}
const failed = results.filter((r) => r.status === 'failed');
const counts = { ok: 0, skipped: 0, failed: 0 };
for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
// Every robots.txt request failed without any HTTP answer: that is our network, not
// the sites. Skipping is still right per source (RFC 9309), but the job must not
// report success (T-25).
const offline = items.filter((r) => r.status === 'skipped' && r.step === 'robots' && r.detail && r.detail.robots
                                    && r.detail.robots.status === 0);
const noNetwork = results.length >= 2 && offline.length === results.length;
const firstErr = noNetwork ? (offline[0].detail.robots.error || 'no error message') : null;
return [{ json: {
  job_id: plan.job_id,
  status: failed.length || noNetwork ? 'failed' : 'succeeded',
  error: noNetwork ? `no_network: robots.txt unreachable for all ${results.length} sources (${firstErr})`
    : failed.length ? `${failed.length} of ${results.length} sources failed` : null,
  output: { counts, sources: results, unknown_sources: plan.unknown_sources || [] },
} }];
