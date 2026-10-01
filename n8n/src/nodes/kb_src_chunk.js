// wf.kb.ingest_source > "Chunk"
// Input: TEI /tokenize answers (text), one per batch, in batch order.
// Builds token offsets for the whole document and runs both chunkers.
/* @include kb/lib/text.js */
/* @include kb/lib/tokens.js */
/* @include kb/chunkers/structure.js */
/* @include kb/chunkers/fixed.js */
/* @include kb/chunkers/structure_aware.js */
const x = $('Cleaned').first().json;
const doc = $('Store document').first().json.doc;
const t0 = Date.now();
const text = x.content;
const pieces = splitPieces(text, 1000);
const answers = [];
for (const it of $input.all()) {
  const raw = it.json.data;
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(parsed)) throw new Error('unexpected /tokenize answer: ' + String(raw).slice(0, 200));
  for (const a of parsed) answers.push(a);
}
if (answers.length !== pieces.length) throw new Error(`tokenize returned ${answers.length} results for ${pieces.length} pieces`);
const { tokens, units } = assembleTokens(pieces, answers);
if (!tokens.length) throw new Error('no tokens');

const strategies = x.cfg.strategies || ['fixed_500_50', 'structure_aware_v1'];
const chunks = [];
const stats = {};
const add = (strategy, list) => {
  const n = list.map((c) => c.token_count);
  const mean = n.reduce((a, b) => a + b, 0) / (n.length || 1);
  const sd = Math.sqrt(n.reduce((a, b) => a + (b - mean) ** 2, 0) / (n.length || 1));
  stats[strategy] = { chunks: list.length, tokens_mean: Math.round(mean * 10) / 10, tokens_sd: Math.round(sd * 10) / 10,
                      tokens_min: Math.min(...n), tokens_max: Math.max(...n) };
  for (const c of list) chunks.push({ strategy, ...c });
};
if (strategies.includes('fixed_500_50')) add('fixed_500_50', chunkFixed(text, tokens, { size: 500, overlap: 50 }));
if (strategies.includes('structure_aware_v1')) {
  const st = parseStructure(text);
  add('structure_aware_v1', chunkStructureAware(text, tokens, st, { maxTokens: 400, minTokens: 150, citeAs: x.source.cite_as }));
  stats.structure_aware_v1.headings = st.headings.length;
  stats.structure_aware_v1.articles = st.units.filter((u) => u.kind === 'article').length;
}
return [{ json: { doc, chunks, stats, document_tokens: tokens.length, offset_units: units, chunk_ms: Date.now() - t0 } }];
