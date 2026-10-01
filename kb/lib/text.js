// Text cleaning for the knowledge base (spec 10.2 steps 2 and 3).
// Pure functions, no n8n globals: inlined into Code nodes by n8n/build.py
// ("/* @include kb/lib/text.js */") and unit-tested by kb/tests/*.test.js.
//
// Output conventions of the cleaned text (what chunkers and gold spans rely on):
//  - Unicode NFKC, "\n" line ends, no NBSP / zero-width / soft hyphen characters
//  - one paragraph per line, blank line between blocks
//  - HTML headings become lines starting with "#", "##", ... (level = h1..h6)

const ZERO_WIDTH_RE = /[­​-‏‪-‮⁠-⁤﻿]/g;

function normalizeText(s) {
  return String(s || '')
    .normalize('NFKC')
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
// Bytes -> string. The charset comes from the Content-Type header, else from a
// <meta charset> / XML declaration in the first 4 KB, else UTF-8.
function sniffCharset(contentType, headBytesLatin1) {
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '');
  if (m) return m[1].toLowerCase();
  const h = headBytesLatin1 || '';
  const meta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(h) || /<\?xml[^>]+encoding\s*=\s*["']([\w-]+)/i.exec(h);
  return meta ? meta[1].toLowerCase() : 'utf-8';
}

function decodeBytes(buf, contentType) {
  const head = Buffer.from(buf.subarray(0, 4096)).toString('latin1');
  let label = sniffCharset(contentType, head);
  try {
    return { text: new TextDecoder(label).decode(buf), charset: label };
  } catch (e) {
    label = 'utf-8';
    return { text: new TextDecoder(label).decode(buf), charset: label };
  }
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

const DROP_ELEMENTS = ['script', 'style', 'noscript', 'svg', 'head', 'template', 'iframe', 'canvas', 'select', 'button'];
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
  module.exports = { normalizeText, sniffCharset, decodeBytes, decodeEntities, extractElement, htmlToText,
    pdfPagesToText, sentenceStarts };
}
