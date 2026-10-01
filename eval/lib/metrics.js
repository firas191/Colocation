// Retrieval metrics with chunking-independent gold (spec 10.7).
// Gold: character spans in documents. A retrieved chunk is relevant when it
// overlaps a gold span of the same document by at least `frac` of the shorter
// of the two (D-039). Credit is given per gold span, so a chunker that cuts one
// gold passage into two chunks does not get two hits for it.
//
// retrieved: [{document_id, start_char, end_char}] in rank order
// gold:      [{document_id, start, end, found}]
// Returns per-query metrics: hit@k and recall@k for k in 1,3,5,10, mrr, ndcg@10,
// plus the rank of each credited gold span.

const KS = [1, 3, 5, 10];

function overlap(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }

function matchedGold(chunk, gold, frac) {
  const out = [];
  gold.forEach((g, gi) => {
    if (!g.found || g.document_id !== chunk.document_id) return;
    const ov = overlap(chunk.start_char, chunk.end_char, g.start, g.end);
    const shorter = Math.min(g.end - g.start, chunk.end_char - chunk.start_char);
    if (ov > 0 && ov >= frac * shorter) out.push(gi);
  });
  return out;
}

function queryMetrics(retrieved, gold, frac = 0.5) {
  const usable = gold.filter((g) => g.found);
  const G = usable.length;
  const credited = new Map();        // gold index -> rank (1-based)
  const relevant = [];               // per rank: chunk matches any gold span
  const gain = [];                   // per rank: 1 if it credits a new gold span
  retrieved.forEach((c, i) => {
    const m = matchedGold(c, gold, frac);
    relevant.push(m.length > 0);
    let g = 0;
    for (const gi of m) if (!credited.has(gi)) { credited.set(gi, i + 1); g = 1; }
    gain.push(g);
  });
  const out = { gold_spans: G, relevant_ranks: relevant.map((r, i) => (r ? i + 1 : null)).filter(Boolean) };
  for (const k of KS) {
    out[`hit@${k}`] = relevant.slice(0, k).some(Boolean) ? 1 : 0;
    const got = [...credited.values()].filter((r) => r <= k).length;
    out[`recall@${k}`] = G ? got / G : null;
  }
  const first = relevant.findIndex(Boolean);
  out.mrr = first >= 0 ? 1 / (first + 1) : 0;
  let dcg = 0, idcg = 0;
  for (let i = 0; i < Math.min(10, gain.length); i++) dcg += gain[i] / Math.log2(i + 2);
  for (let i = 0; i < Math.min(10, G); i++) idcg += 1 / Math.log2(i + 2);
  out['ndcg@10'] = idcg ? dcg / idcg : null;
  if (!G) for (const k of Object.keys(out)) if (/@|mrr/.test(k)) out[k] = null;
  return out;
}

if (typeof module !== 'undefined') module.exports = { queryMetrics, matchedGold, overlap, KS };
