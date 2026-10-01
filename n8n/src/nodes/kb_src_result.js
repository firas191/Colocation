// wf.kb.ingest_source > "Result" (after embeddings) and "Skipped" (nothing to do)
// Output: the outcome returned to wf.kb.ingest.
const x = $('Robots decision').first().json;
const mode = '__MODE__';
const base = { job_id: x.job_id, source_id: x.source.id, source_key: x.source.source_key, ms: Date.now() - x.t0 };
if (mode === 'robots') {
  return [{ json: { ...base, status: 'skipped', step: 'robots', action: null, detail: { robots: x.robots } } }];
}
const doc = $('Store document').first().json.doc;
if (mode === 'unchanged') {
  return [{ json: { ...base, status: 'skipped', step: 'unchanged', action: doc.action, detail: { doc, robots: x.robots } } }];
}
const ch = $('Chunk').first().json;
const counts = {};
for (const it of $input.all()) {
  const n = Number(it.json.n || 0);
  counts[it.json.model] = (counts[it.json.model] || 0) + n;
}
const cleaned = $('Cleaned').first().json;
return [{ json: { ...base, status: 'ok', step: 'done', action: doc.action,
  chunks: ch.stats, embeddings: counts,
  detail: { doc, robots: x.robots, document_tokens: ch.document_tokens, offset_units: ch.offset_units,
            chunk_ms: ch.chunk_ms, extractor: cleaned.extractor, doc_metadata: cleaned.doc_metadata } } }];
