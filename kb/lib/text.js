// Text cleaning for the knowledge base (spec 10.2 steps 2 and 3).
// Pure functions, no n8n globals: inlined into Code nodes by n8n/build.py
// ("/* @include kb/lib/text.js */") and unit-tested by kb/tests/*.test.js.
//
// Output conventions of the cleaned text (what chunkers and gold spans rely on):
//  - Unicode NFKC, "\n" line ends, no NBSP / zero-width / soft hyphen characters
//  - one paragraph per line, blank line between blocks
//  - HTML headings become lines starting with "#", "##", ... (level = h1..h6)

const ZERO_WIDTH_RE = /[­​-‏‪-‮⁠-⁤﻿]/g;

// Characters outside the Basic Multilingual Plane (emoji, rare symbols) are removed:
// JavaScript counts them as two positions and PostgreSQL as one, so a single emoji
// shifted every chunk span after it (FAILURES F-030). They carry nothing for retrieval.
const ASTRAL_RE = /[\u{10000}-\u{10FFFF}]/gu;
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function normalizeText(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(ASTRAL_RE, '')
    .replace(LONE_SURROGATE_RE, '')
    .replace(/\r\n?/g, '\n')
    .replace(ZERO_WIDTH_RE, '')
    .replace(/[  -   　\t]/g, ' ')
    .split('\n')
    .map((l) => l.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Bytes -> string. Declarations, in the HTML order of precedence: the
// Content-Type header, then a <meta charset> / XML declaration in the first
// 4 KB, else UTF-8. See decodeBytes for what happens when they are wrong.
function declaredCharsets(contentType, headBytesLatin1) {
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '');
  const h = headBytesLatin1 || '';
  const meta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(h) || /<\?xml[^>]+encoding\s*=\s*["']([\w-]+)/i.exec(h);
  const norm = (x) => { const l = x.toLowerCase(); return CHARSET_ALIASES[l] || l; };
  return { header: m ? norm(m[1]) : null, meta: meta ? norm(meta[1]) : null };
}

function sniffCharset(contentType, headBytesLatin1) {
  const d = declaredCharsets(contentType, headBytesLatin1);
  return d.header || d.meta || 'utf-8';
}

// Single-byte code pages decoded without ICU: the Node build in n8n's runner image
// cannot decode windows-1256 with TextDecoder (F-029). Bytes 0x80-0xFF, generated
// from Python's codecs; U+FFFD marks bytes the code page leaves undefined.
const SINGLE_BYTE = {
  'windows-1256': '\u20ac\u067e\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0679\u2039\u0152\u0686\u0698\u0688\u06af\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u06a9\u2122\u0691\u203a\u0153\u200c\u200d\u06ba\u00a0\u060c\u00a2\u00a3\u00a4\u00a5\u00a6\u00a7\u00a8\u00a9\u06be\u00ab\u00ac\u00ad\u00ae\u00af\u00b0\u00b1\u00b2\u00b3\u00b4\u00b5\u00b6\u00b7\u00b8\u00b9\u061b\u00bb\u00bc\u00bd\u00be\u061f\u06c1\u0621\u0622\u0623\u0624\u0625\u0626\u0627\u0628\u0629\u062a\u062b\u062c\u062d\u062e\u062f\u0630\u0631\u0632\u0633\u0634\u0635\u0636\u00d7\u0637\u0638\u0639\u063a\u0640\u0641\u0642\u0643\u00e0\u0644\u00e2\u0645\u0646\u0647\u0648\u00e7\u00e8\u00e9\u00ea\u00eb\u0649\u064a\u00ee\u00ef\u064b\u064c\u064d\u064e\u00f4\u064f\u0650\u00f7\u0651\u00f9\u0652\u00fb\u00fc\u200e\u200f\u06d2',
  'windows-1252': '\u20ac\ufffd\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\ufffd\u017d\ufffd\ufffd\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\ufffd\u017e\u0178\u00a0\u00a1\u00a2\u00a3\u00a4\u00a5\u00a6\u00a7\u00a8\u00a9\u00aa\u00ab\u00ac\u00ad\u00ae\u00af\u00b0\u00b1\u00b2\u00b3\u00b4\u00b5\u00b6\u00b7\u00b8\u00b9\u00ba\u00bb\u00bc\u00bd\u00be\u00bf\u00c0\u00c1\u00c2\u00c3\u00c4\u00c5\u00c6\u00c7\u00c8\u00c9\u00ca\u00cb\u00cc\u00cd\u00ce\u00cf\u00d0\u00d1\u00d2\u00d3\u00d4\u00d5\u00d6\u00d7\u00d8\u00d9\u00da\u00db\u00dc\u00dd\u00de\u00df\u00e0\u00e1\u00e2\u00e3\u00e4\u00e5\u00e6\u00e7\u00e8\u00e9\u00ea\u00eb\u00ec\u00ed\u00ee\u00ef\u00f0\u00f1\u00f2\u00f3\u00f4\u00f5\u00f6\u00f7\u00f8\u00f9\u00fa\u00fb\u00fc\u00fd\u00fe\u00ff',
  'iso-8859-6': '\u0080\u0081\u0082\u0083\u0084\u0085\u0086\u0087\u0088\u0089\u008a\u008b\u008c\u008d\u008e\u008f\u0090\u0091\u0092\u0093\u0094\u0095\u0096\u0097\u0098\u0099\u009a\u009b\u009c\u009d\u009e\u009f\u00a0\ufffd\ufffd\ufffd\u00a4\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\u060c\u00ad\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\u061b\ufffd\ufffd\ufffd\u061f\ufffd\u0621\u0622\u0623\u0624\u0625\u0626\u0627\u0628\u0629\u062a\u062b\u062c\u062d\u062e\u062f\u0630\u0631\u0632\u0633\u0634\u0635\u0636\u0637\u0638\u0639\u063a\ufffd\ufffd\ufffd\ufffd\ufffd\u0640\u0641\u0642\u0643\u0644\u0645\u0646\u0647\u0648\u0649\u064a\u064b\u064c\u064d\u064e\u064f\u0650\u0651\u0652\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd',
};
const CHARSET_ALIASES = { 'cp1256': 'windows-1256', 'cp1252': 'windows-1252', 'iso-8859-1': 'windows-1252',
  'latin1': 'windows-1252', 'us-ascii': 'windows-1252', 'ascii': 'windows-1252', 'iso_8859-6': 'iso-8859-6',
  'arabic': 'iso-8859-6', 'utf8': 'utf-8' };

function decodeSingleByte(buf, table) {
  let s = '';
  for (let i = 0; i < buf.length; i++) s += buf[i] < 128 ? String.fromCharCode(buf[i]) : table[buf[i] - 128];
  return s;
}

// Length of the valid UTF-8 sequence starting at i (RFC 3629: no overlong
// forms, no surrogates, nothing above U+10FFFF), or 0 if it is not valid.
function utf8SeqLen(b, i) {
  const c = b[i];
  if (c < 0x80) return 1;
  const cont = (k, lo = 0x80, hi = 0xbf) => i + k < b.length && b[i + k] >= lo && b[i + k] <= hi;
  if (c >= 0xc2 && c <= 0xdf) return cont(1) ? 2 : 0;
  if (c === 0xe0) return cont(1, 0xa0) && cont(2) ? 3 : 0;
  if ((c >= 0xe1 && c <= 0xec) || c === 0xee || c === 0xef) return cont(1) && cont(2) ? 3 : 0;
  if (c === 0xed) return cont(1, 0x80, 0x9f) && cont(2) ? 3 : 0;
  if (c === 0xf0) return cont(1, 0x90) && cont(2) && cont(3) ? 4 : 0;
  if (c >= 0xf1 && c <= 0xf3) return cont(1) && cont(2) && cont(3) ? 4 : 0;
  if (c === 0xf4) return cont(1, 0x80, 0x8f) && cont(2) && cont(3) ? 4 : 0;
  return 0;
}

// Valid multi-byte sequences and invalid bytes in a buffer.
function utf8Scan(b) {
  let multibyte = 0, invalid = 0;
  for (let i = 0; i < b.length;) {
    const n = utf8SeqLen(b, i);
    if (n === 0) { invalid++; i++; } else { if (n > 1) multibyte++; i += n; }
  }
  return { multibyte, invalid };
}

// UTF-8 where valid; each invalid byte read as windows-1252. For pages whose
// template was saved in Latin-1 while the content is UTF-8 (F-032).
function decodeUtf8Mixed(b) {
  const parts = [];
  let start = 0;
  const flush = (end) => { if (end > start) parts.push(new TextDecoder('utf-8').decode(b.subarray(start, end))); };
  for (let i = 0; i < b.length;) {
    const n = utf8SeqLen(b, i);
    if (n === 0) { flush(i); parts.push(SINGLE_BYTE['windows-1252'][b[i] - 128]); i++; start = i; } else i += n;
  }
  flush(b.length);
  return parts.join('');
}

function decodeWith(buf, label) {
  if (SINGLE_BYTE[label]) return decodeSingleByte(buf, SINGLE_BYTE[label]);
  if (label === 'utf-8') return new TextDecoder('utf-8').decode(buf);
  try {
    return new TextDecoder(label).decode(buf);
  } catch (e) {
    throw new Error(`unsupported charset ${label}`);   // never guess: a wrong decoder garbles the text silently
  }
}

// Returns {text, charset, source, invalid_bytes}. HTML gives the header
// precedence over <meta>; we follow that except when the chosen charset is
// UTF-8 and the bytes are not valid UTF-8 (DECISIONS D-048, FAILURES F-032):
//  1. another declaration names a different charset -> use it
//     (a server default "charset=utf-8" over a windows-1256 page);
//  2. otherwise, if valid multi-byte sequences outnumber invalid bytes, the
//     text is UTF-8 with stray Latin-1 bytes -> decode them as windows-1252;
//  3. otherwise fail: the real charset is unknown.
function decodeBytes(buf, contentType) {
  const head = Buffer.from(buf.subarray(0, 4096)).toString('latin1');
  const d = declaredCharsets(contentType, head);
  const label = d.header || d.meta || 'utf-8';
  const source = d.header ? 'header' : d.meta ? 'meta' : 'default';
  if (label !== 'utf-8') return { text: decodeWith(buf, label), charset: label, source, invalid_bytes: 0 };
  const scan = utf8Scan(buf);
  if (scan.invalid === 0) return { text: decodeWith(buf, 'utf-8'), charset: 'utf-8', source, invalid_bytes: 0 };
  const other = [d.header, d.meta].find((x) => x && x !== 'utf-8');
  if (other) {
    return { text: decodeWith(buf, other), charset: other, source: d.meta === other ? 'meta' : 'header',
             invalid_bytes: scan.invalid, note: `declared utf-8 (${source}) but ${scan.invalid} bytes are not UTF-8` };
  }
  if (scan.multibyte >= scan.invalid) {
    return { text: decodeUtf8Mixed(buf), charset: 'utf-8+windows-1252', source, invalid_bytes: scan.invalid };
  }
  throw new Error(`decoding_failed utf-8 (${source}): ${scan.invalid} invalid bytes, ${scan.multibyte} valid multi-byte sequences, no other charset declared`);
}

// ---------------------------------------------------------------------------
// HTML -> text. A small tag scanner, not a full parser: enough for the article
// and law pages in the packs, tested on the cases in kb/tests/text.test.js.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', rsquo: '’',
  lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â', aacute: 'á', ccedil: 'ç',
  icirc: 'î', iuml: 'ï', ocirc: 'ô', ouml: 'ö', ugrave: 'ù', ucirc: 'û', uuml: 'ü', Eacute: 'É',
  Egrave: 'È', Ecirc: 'Ê', Agrave: 'À', Acirc: 'Â', Ccedil: 'Ç', Icirc: 'Î', Ocirc: 'Ô', Ucirc: 'Û',
  oelig: 'œ', OElig: 'Œ', deg: '°', euro: '€', copy: '©', reg: '®', sect: '§', middot: '·', bull: '•',
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, e) ? NAMED_ENTITIES[e] : m;
  });
}

// del / s / strike: struck-through text is repealed wording on law sites (jurisitetunisie.com)
const DROP_ELEMENTS = ['script', 'style', 'noscript', 'svg', 'head', 'template', 'iframe', 'canvas', 'select', 'button',
  'del', 's', 'strike'];
const BOILERPLATE_ELEMENTS = ['nav', 'header', 'footer', 'aside', 'form'];
const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'main', 'ul', 'ol', 'table', 'tr', 'tbody', 'thead',
  'blockquote', 'pre', 'dl', 'dd', 'dt', 'figure', 'figcaption', 'address', 'center', 'hr', 'body', 'html']);

function attrMatches(tagText, sel) {
  if (sel.id) {
    const m = /\sid\s*=\s*["']([^"']*)["']/i.exec(tagText);
    if (!m || m[1] !== sel.id) return false;
  }
  if (sel.class) {
    const m = /\sclass\s*=\s*["']([^"']*)["']/i.exec(tagText);
    if (!m || !m[1].split(/\s+/).includes(sel.class)) return false;
  }
  return true;
}

// Inner HTML of the first element matching {tag, id, class}; null if absent.
// Nested elements with the same tag name are balanced.
function extractElement(html, sel) {
  const tag = (sel.tag || '[a-z][a-z0-9]*').toLowerCase();
  const openRe = new RegExp(`<(${tag})(\\s[^>]*)?>`, 'gi');
  let m;
  while ((m = openRe.exec(html))) {
    if (!attrMatches(m[0], sel)) continue;
    const name = m[1].toLowerCase();
    const re = new RegExp(`<(/?)${name}(?=[\\s>/])[^>]*>`, 'gi');
    re.lastIndex = m.index + m[0].length;
    let depth = 1, t;
    while ((t = re.exec(html))) {
      if (t[0].endsWith('/>')) continue;
      depth += t[1] ? -1 : 1;
      if (depth === 0) return html.slice(m.index + m[0].length, t.index);
    }
    return html.slice(m.index + m[0].length);
  }
  return null;
}

function removeElements(html, names) {
  let out = html;
  for (const n of names) {
    out = out.replace(new RegExp(`<${n}(?=[\\s>/])[\\s\\S]*?</${n}\\s*>`, 'gi'), ' ');
    out = out.replace(new RegExp(`<${n}(?=[\\s>/])[^>]*/>`, 'gi'), ' ');
  }
  return out;
}

// opts: {select: {tag,id,class} | [..] (first match wins), keepBoilerplate: bool}
function htmlToText(html, opts = {}) {
  let h = String(html || '').replace(/<!--[\s\S]*?-->/g, ' ');
  h = removeElements(h, DROP_ELEMENTS);
  let selected = false;
  for (const sel of [].concat(opts.select || [])) {
    const inner = extractElement(h, sel);
    if (inner !== null) { h = inner; selected = true; break; }
  }
  if (!opts.keepBoilerplate) h = removeElements(h, BOILERPLATE_ELEMENTS);
  h = h.replace(/<(\/?)([a-z][a-z0-9]*)(\s[^>]*)?\/?>/gi, (m, close, name) => {
    const n = name.toLowerCase();
    if (/^h[1-6]$/.test(n)) return close ? '\n\n' : `\n\n${'#'.repeat(Number(n[1]))} `;
    if (n === 'br') return '\n';
    if (n === 'li') return close ? '' : '\n- ';
    if (n === 'td' || n === 'th') return ' ';
    if (BLOCK_TAGS.has(n)) return '\n\n';
    return '';
  });
  h = h.replace(/<[^>]*>/g, '');           // anything left (malformed tags)
  let text = normalizeText(decodeEntities(h));
  // a heading marker left alone on its line (empty heading) is dropped
  text = text.replace(/^#{1,6}\s*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  return { text, selected };
}

// Keep the text from the first line starting with startAt (inclusive) to the
// first later line starting with endAt (exclusive). Used per source to drop page
// chrome around an article (kb/packs/*/sources.csv, column "extract").
// A missing start marker is an error (the page changed); a missing end marker keeps
// the rest of the text and is reported.
function cutBetween(text, startAt, endAt) {
  const lines = text.split('\n');
  let a = 0, b = lines.length, ended = !endAt;
  if (startAt) {
    a = lines.findIndex((l) => l.trim().startsWith(startAt));
    if (a < 0) throw new Error(`start marker not found: ${startAt}`);
  }
  if (endAt) {
    const e = lines.findIndex((l, i) => i > a && l.trim().startsWith(endAt));
    if (e >= 0) { b = e; ended = true; }
  }
  return { text: normalizeText(lines.slice(a, b).join('\n')), ended };
}

// ---------------------------------------------------------------------------
// PDF pages (one string per page, lines separated by "\n", as n8n's Extract
// From File node returns them with joinPages=false) -> paragraphs.
const TERMINAL_RE = /[.!?:;؟»)\]"”]$/;
const STRUCTURE_LINE_RE = /^(#{1,6}\s|[-•*–]\s|\(?\d{1,3}[.)-]\s|\(?[a-z][.)]\s|(article|art\.?)\s*(premier|1er|\d)|(livre|titre|chapitre|section|sous-section|paragraphe)\s|(الفصل|الباب|العنوان|القسم|الفرع|الكتاب)\s|[IVXLC]+[.-]\s)/i;

function pdfPagesToText(pages, opts = {}) {
  const pageLines = pages.map((p) => normalizeText(p).split('\n').map((l) => l.trim()).filter((l) => l.length));
  // Running headers/footers: first/last two lines repeated on more than half of
  // the pages (digits ignored, so "Page 3" and "Page 4" count as the same line).
  const key = (l) => l.replace(/\d+/g, '#');
  const counts = new Map();
  for (const lines of pageLines) {
    const edge = new Set([...lines.slice(0, 2), ...lines.slice(-2)].map(key));
    for (const k of edge) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const minRepeats = Math.max(3, Math.ceil(pages.length / 2));
  // structural lines ("Article 12", "Chapitre 3") repeat in shape on many pages but are content
  const isRunning = (l, i, n) => (i < 2 || i >= n - 2) && !STRUCTURE_LINE_RE.test(l)
    && (counts.get(key(l)) || 0) >= minRepeats;
  const isPageNumber = (l) => /^(page\s*)?[-–]?\s*\d{1,4}\s*[-–]?(\s*\/\s*\d{1,4})?$/i.test(l);

  const kept = [];
  const pageStarts = [];
  for (const lines of pageLines) {
    pageStarts.push(kept.length);
    lines.forEach((l, i) => { if (!isRunning(l, i, lines.length) && !isPageNumber(l)) kept.push(l); });
  }
  const lengths = kept.map((l) => l.length).sort((a, b) => a - b);
  const median = lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0;
  const shortLine = Math.max(20, Math.floor(median * 0.6));

  const paras = [];
  let cur = '';
  kept.forEach((line, i) => {
    if (!cur) { cur = line; return; }
    const prev = kept[i - 1];
    // new paragraph when the line starts a structural unit, or the previous line
    // ends a sentence or is short (a wrapped line runs to the right margin)
    const breakHere = STRUCTURE_LINE_RE.test(line) || TERMINAL_RE.test(prev) || prev.length < shortLine;
    if (breakHere && !/-$/.test(prev)) { paras.push(cur); cur = line; return; }
    if (/[a-zà-ÿ]-$/i.test(cur) && /^[a-zà-ÿ]/.test(line)) cur = cur.slice(0, -1) + line;   // hyphenated word
    else cur += ' ' + line;
  });
  if (cur) paras.push(cur);
  return { text: normalizeText(paras.join('\n\n')), pages: pages.length, lines_dropped: pageLines.flat().length - kept.length };
}

// ---------------------------------------------------------------------------
// Sentence boundaries (French, English, Arabic). Returns character offsets
// where a new sentence starts, inside [start, end).
const ABBREV = new Set(['art', 'arts', 'al', 'cf', 'ex', 'etc', 'n', 'no', 'nos', 'p', 'pp', 'm', 'mm', 'mme', 'dr',
  'mr', 'mrs', 'st', 'vol', 'ch', 'chap', 'sect', 'op', 'loc', 'ibid', 'i.e', 'e.g', 'vs', 'av', 'bd', 'tél', 'tel']);

function sentenceStarts(text, start = 0, end = text.length) {
  const out = [];
  const re = /([.!?؟…]+)(["”»)\]]*)(\s+)(?=\S)/g;
  re.lastIndex = start;
  let m;
  while ((m = re.exec(text)) && m.index < end) {
    const next = m.index + m[0].length;
    if (next >= end) break;
    const before = text.slice(Math.max(start, m.index - 12), m.index);
    const word = (/([A-Za-zÀ-ÿ.]+)$/.exec(before) || [])[1] || '';
    if (m[1] === '.' && ABBREV.has(word.toLowerCase())) continue;
    if (m[1] === '.' && /\d$/.test(before) && /^\d/.test(text[next])) continue;   // 1. 2  / 3.5
    if (m[1] === '.' && /^[a-zà-ÿ]/.test(text[next])) continue;                   // lower case follows
    out.push(next);
  }
  // line breaks between paragraphs are always boundaries
  const nl = /\n+/g;
  nl.lastIndex = start;
  while ((m = nl.exec(text)) && m.index < end) {
    const next = m.index + m[0].length;
    if (next < end) out.push(next);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

if (typeof module !== 'undefined') {
  module.exports = { normalizeText, sniffCharset, declaredCharsets, utf8Scan, decodeUtf8Mixed, decodeBytes, decodeEntities, extractElement, htmlToText,
    pdfPagesToText, sentenceStarts, cutBetween };
}
