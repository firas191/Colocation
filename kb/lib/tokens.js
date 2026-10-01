// Token offsets for chunking, from the TEI /tokenize endpoint (XLM-RoBERTa
// tokenizer of multilingual-e5-large, the same vocabulary as bge-m3; D-035).
//
// The document is cut into pieces of at most maxChars characters at whitespace,
// each piece is tokenized without special tokens, and the token offsets are
// shifted back to document positions. Cutting at whitespace does not change the
// tokens of a SentencePiece tokenizer, whose pieces never span whitespace.

function splitPieces(text, maxChars = 1000) {
  const pieces = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    let end = Math.min(n, i + maxChars);
    if (end < n) {
      const ws = text.lastIndexOf(' ', end);
      const nl = text.lastIndexOf('\n', end);
      const cut = Math.max(ws, nl);
      if (cut > i) end = cut;          // a piece with no whitespace at all is cut hard
    }
    pieces.push({ start: i, text: text.slice(i, end) });
    i = end;
  }
  return pieces;
}

// Byte offset (UTF-8) -> UTF-16 index table for one string.
function byteToCharMap(s) {
  const map = new Int32Array(Buffer.byteLength(s, 'utf8') + 1);
  let b = 0;
  for (let c = 0; c < s.length; c++) {
    const cp = s.codePointAt(c);
    const len = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    for (let k = 0; k < len; k++) map[b + k] = c;
    b += len;
    if (cp >= 0x10000) c++;            // surrogate pair: two UTF-16 units
  }
  map[b] = s.length;
  return map;
}

// TEI returns offsets either in characters or in UTF-8 bytes depending on the
// version; tell them apart on the piece itself (D-035). Pure ASCII pieces are
// the same either way.
function offsetUnit(pieceText, tokens) {
  const bytes = Buffer.byteLength(pieceText, 'utf8');
  if (bytes === pieceText.length) return 'char';
  const maxStop = tokens.reduce((m, t) => Math.max(m, t.stop ?? t.end ?? 0), 0);
  return maxStop > pieceText.length ? 'byte' : 'char';
}

// pieceTokens: TEI answer for one piece, [{id, text, special, start, stop}].
// Returns [[startChar, endChar], ...] in document positions, specials dropped.
function pieceOffsets(piece, pieceTokens) {
  const toks = (pieceTokens || []).filter((t) => !t.special && (t.start ?? null) !== null);
  const unit = offsetUnit(piece.text, toks);
  const map = unit === 'byte' ? byteToCharMap(piece.text) : null;
  const out = [];
  for (const t of toks) {
    let s = t.start, e = t.stop ?? t.end;
    if (map) { s = map[s]; e = map[e]; }
    // SentencePiece puts the word-start marker on the token, and some tokenizers
    // include the preceding space in the offsets: trim it so spans start on text.
    while (s < e && /\s/.test(piece.text[s])) s++;
    if (e > s) out.push([piece.start + s, piece.start + e]);
  }
  return { offsets: out, unit };
}

function assembleTokens(pieces, answers) {
  const all = [];
  const units = new Set();
  pieces.forEach((p, i) => {
    const r = pieceOffsets(p, answers[i]);
    units.add(r.unit);
    for (const o of r.offsets) all.push(o);
  });
  return { tokens: all, units: [...units] };
}

// Number of tokens fully inside [start, end): binary search on sorted tokens.
function lowerBound(tokens, pos, idx) {
  let lo = 0, hi = tokens.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (tokens[mid][idx] < pos) lo = mid + 1; else hi = mid; }
  return lo;
}
function countTokens(tokens, start, end) {
  const a = lowerBound(tokens, start, 0);
  const b = lowerBound(tokens, end + 1, 1);   // tokens with end <= end
  return Math.max(0, b - a);
}

if (typeof module !== 'undefined') {
  module.exports = { splitPieces, byteToCharMap, offsetUnit, pieceOffsets, assembleTokens, countTokens, lowerBound };
}
