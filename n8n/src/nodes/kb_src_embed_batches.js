// wf.kb.ingest_source > "Embed batches"
// Input: [{chunk_id, strategy, chunk_index}] from "Store chunks". Builds one
// request per batch and model. Embedded text: the chunk text for strategy A,
// metadata.embed_text (heading path + text) for strategy B. Model prefixes come
// from ai.models (multilingual-e5-large: "passage: ").
const x = $('Cleaned').first().json;
const ch = $('Chunk').first().json;
const stored = $input.first().json.ids || [];
const byKey = new Map(ch.chunks.map((c) => [`${c.strategy}|${c.chunk_index}`, c]));
const rows = stored.map((s) => {
  const c = byKey.get(`${s.strategy}|${s.chunk_index}`);
  if (!c) throw new Error(`stored chunk ${s.strategy}/${s.chunk_index} not in the chunker output`);
  const text = (c.metadata && c.metadata.embed_text) || x.content.slice(c.start_char, c.end_char);
  return { chunk_id: s.chunk_id, text };
});
const out = [];
for (const m of x.models) {
  const size = Number(m.endpoint === 'tei' ? x.cfg.batch_e5 || 16 : x.cfg.batch_bge || 32);
  for (let i = 0; i < rows.length; i += size) {
    const b = rows.slice(i, i + size);
    const inputs = b.map((r) => (m.passage_prefix || '') + r.text);
    const req = m.endpoint === 'tei'
      ? { url: `${x.cfg.tei_base_url}/embed`, body: { inputs, normalize: true, truncate: true } }
      : { url: `${x.cfg.ollama_base_url}/api/embed`, body: { model: m.name, input: inputs, truncate: true } };
    out.push({ json: { model: m.name, endpoint: m.endpoint, dims: m.dims, chunk_ids: b.map((r) => r.chunk_id), ...req } });
  }
}
return out;
