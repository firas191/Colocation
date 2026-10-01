// Strategy B, "structure_aware_v1" (spec 10.3).
//  - Units are the document's own: articles, or paragraphs under headings
//    (kb/chunkers/structure.js).
//  - A unit above maxTokens (400) is split at sentence boundaries; a sentence
//    longer than that is cut into token windows.
//  - A chunk under minTokens (150) is merged with a neighbour under the same
//    headings if the result stays within maxTokens. No overlap, so two
//    articles never share text.
//  - The embedded text is "heading > heading\n" + chunk text, stored in
//    metadata.embed_text so the embedding input can be reproduced.
// Needs kb/lib/tokens.js (countTokens, lowerBound) and kb/lib/text.js
// (sentenceStarts) in the same scope.

function chunkStructureAware(text, tokens, structure, opts = {}) {
  const maxT = opts.maxTokens || 400;
  const minT = opts.minTokens || 150;
  const embedMax = opts.embedMaxTokens || 510;
  const cite = opts.citeAs ? opts.citeAs + ' ' : '';
  const { headings, units } = structure;
  const count = (s, e) => countTokens(tokens, s, e);

  // 1. split long units
  const pieces = [];
  for (const u of units) {
    const n = count(u.start, u.end);
    if (n === 0) continue;
    if (n <= maxT) { pieces.push({ ...u, tokens: n, part: null }); continue; }
    const starts = [u.start, ...sentenceStarts(text, u.start, u.end).filter((p) => p > u.start), u.end];
    const segs = [];
    let s0 = starts[0];
    for (let k = 1; k < starts.length; k++) {
      const candidateEnd = starts[k];
      // cut before sentence k-1 unless that sentence alone is too long (it is then
      // windowed together with the text before it, see below)
      if (count(s0, candidateEnd) > maxT && starts[k - 1] > s0 && count(starts[k - 1], candidateEnd) <= maxT) {
        segs.push([s0, starts[k - 1]]);
        s0 = starts[k - 1];
      }
    }
    segs.push([s0, u.end]);
    const fine = [];
    for (const [a, b] of segs) {
      if (count(a, b) <= maxT) { fine.push([a, b]); continue; }
      // one sentence above the limit: windows of maxT tokens
      const i0 = lowerBound(tokens, a, 0);
      const i1 = lowerBound(tokens, b + 1, 1);
      for (let i = i0; i < i1; i += maxT) {
        const j = Math.min(i1, i + maxT);
        fine.push([i === i0 ? a : tokens[i][0], j === i1 ? b : tokens[j - 1][1]]);
      }
    }
    fine.forEach(([a, b], k) => {
      const ta = trimSpan(text, a, b);
      if (ta) pieces.push({ ...u, start: ta[0], end: ta[1], tokens: count(ta[0], ta[1]), part: `${k + 1}/${fine.length}` });
    });
  }

  // 2. merge small pieces with a neighbour under the same headings
  const samePath = (a, b) => a.path.length === b.path.length && a.path.every((x, i) => x === b.path[i]);
  const merged = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last && samePath(last, p) && (last.tokens < minT || p.tokens < minT)) {
      const n = count(last.start, p.end);
      if (n <= maxT) { last.end = p.end; last.tokens = n; last.members.push(p); continue; }
    }
    merged.push({ start: p.start, end: p.end, path: p.path, tokens: p.tokens, members: [p] });
  }

  // 3. labels, article refs, embedding text
  return merged.map((c, idx) => {
    const refs = [...new Set(c.members.filter((m) => m.ref).map((m) => m.ref))];
    const article_ref = refs.length === 0 ? null
      : refs.length === 1 ? `${cite}art. ${refs[0]}` : `${cite}art. ${refs[0]}-${refs[refs.length - 1]}`;
    let path = c.path.slice();
    const label = (i) => headings[i].label.slice(0, 150);
    const headTokens = (p) => p.reduce((s, i) => s + count(headings[i].start, headings[i].end) + 2, 0);
    let dropped = 0;
    while (path.length && c.tokens + headTokens(path) > embedMax) { path = path.slice(1); dropped++; }
    const content = text.slice(c.start, c.end);
    const heading_path = c.path.map(label);
    const embed_text = path.length ? path.map(label).join(' > ') + '\n' + content : content;
    return {
      chunk_index: idx,
      start_char: c.start,
      end_char: c.end,
      token_count: c.tokens,
      heading_path,
      article_ref,
      metadata: {
        kinds: [...new Set(c.members.map((m) => m.kind))],
        parts: c.members.filter((m) => m.part).map((m) => (m.ref ? m.ref + ' ' : '') + m.part),
        merged_units: c.members.length,
        embed_text,
        embed_token_estimate: c.tokens + headTokens(path),
        headings_dropped_for_length: dropped,
        strategy_params: { max_tokens: maxT, min_tokens: minT },
      },
    };
  });
}

function trimSpan(text, a, b) {
  while (a < b && /\s/.test(text[a])) a++;
  while (b > a && /\s/.test(text[b - 1])) b--;
  return b > a ? [a, b] : null;
}

if (typeof module !== 'undefined') module.exports = { chunkStructureAware, trimSpan };
