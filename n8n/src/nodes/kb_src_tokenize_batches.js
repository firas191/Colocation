// wf.kb.ingest_source > "Tokenize batches"
// Input: {doc, progress} from "Store document". Decides whether chunking and
// embedding are needed: a new or changed version, force, or anything missing
// (chunks for a strategy, embeddings for a strategy and model). Output: the
// TEI /tokenize request bodies, or one {skip: true} item.
/* @include kb/lib/tokens.js */
const x = $('Cleaned').first().json;
const r = $input.first().json;
const doc = r.doc;
const prog = r.progress || { chunks: {}, embeddings: {} };
const strategies = x.cfg.strategies || ['fixed_500_50', 'structure_aware_v1'];
const models = x.models.map((m) => m.name);
const complete = strategies.every((s) => (prog.chunks[s] || 0) > 0
  && models.every((m) => (prog.embeddings[`${s}|${m}`] || 0) === prog.chunks[s]));
if (doc.action === 'unchanged' && !x.force && complete) {
  return [{ json: { skip: true, doc } }];
}
const pieces = splitPieces(x.content, 1000);
const size = Number(x.cfg.batch_tokenize || 32);
const out = [];
for (let i = 0; i < pieces.length; i += size) {
  out.push({ json: { skip: false, doc, batch: i / size,
    body: { inputs: pieces.slice(i, i + size).map((p) => p.text), add_special_tokens: false } } });
}
return out;
