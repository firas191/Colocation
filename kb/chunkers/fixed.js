// Strategy A, "fixed_500_50" (spec 10.3): windows of 500 tokens with 50
// tokens of overlap over the whole document, ignoring structure. Token
// offsets come from kb/lib/tokens.js. A window's span runs from the start of
// its first token to the end of its last token.
//
// chunkFixed(text, tokens, {size, overlap}) -> [{chunk_index, start_char, end_char, token_count,
//                                              heading_path: [], article_ref: null, metadata}]

function chunkFixed(text, tokens, opts = {}) {
  const size = opts.size || 500;
  const overlap = opts.overlap ?? 50;
  if (overlap >= size) throw new Error('overlap must be smaller than size');
  const stride = size - overlap;
  const out = [];
  if (!tokens.length) return out;
  for (let i = 0; i < tokens.length; i += stride) {
    const j = Math.min(tokens.length, i + size);
    out.push({
      chunk_index: out.length,
      start_char: tokens[i][0],
      end_char: tokens[j - 1][1],
      token_count: j - i,
      heading_path: [],
      article_ref: null,
      metadata: { strategy_params: { size, overlap }, first_token: i, last_token: j - 1 },
    });
    if (j === tokens.length) break;
  }
  return out;
}

if (typeof module !== 'undefined') module.exports = { chunkFixed };
