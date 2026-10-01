// Document structure for strategy B (spec 10.3): headings and articles of
// French and Arabic legal texts, markdown-style headings from cleaned HTML,
// and plain paragraphs. Works on the cleaned text from kb/lib/text.js.
//
// parseStructure(text) -> {
//   headings: [{start, end, level, label}],           // heading lines
//   units:    [{start, end, kind: 'article'|'para', ref, path: [heading index...]}]
// }
// Units never contain heading lines. Offsets are 0-based, end exclusive.

const FR_HEADING = [
  [/^livre\b/i, 1], [/^(titre|title)\b/i, 2], [/^(chapitre|chapter)\b/i, 3],
  [/^(section)\b/i, 4], [/^(sous-section|sous section)\b/i, 5], [/^(paragraphe|§)\s*\S/i, 6],
];
const AR_HEADING = [
  [/^الكتاب\s/, 1], [/^(العنوان|الباب)\s/, 2], [/^(القسم)\s/, 4], [/^(الفرع|الجزء)\s/, 5],
];
// "Article 727", "Art. 727 bis", "ARTICLE PREMIER", "Article 2 (nouveau)", "الفصل 727", "الفصل الأول"
const ARTICLE_FR = /^(?:article\.?|art\.)\s*(premier|unique|1er|\d+(?:\s*(?:bis|ter|quater|quinquies|sexies|septies|octies|nonies|decies))?(?:\s*\((?:nouveau|modifié|abrogé)\))?)\s*(?:[.:\-–—)]|$|\s)/i;
const ARTICLE_AR = /^(?:الفصل|فصل)\s*((?:\d+|[٠-٩]+)(?:\s*(?:مكرر|ثالثا|رابعا))?|الأول|الاول|أول|اول)\s*(?:[.:\-–—)]|$|\s)/;

function headingLevel(line) {
  const md = /^(#{1,6})\s+\S/.exec(line);
  if (md) return { level: md[1].length, md: true };
  if (line.length > 120 || /[.,;]$/.test(line)) return null;   // a body sentence, not a heading
  for (const [re, lvl] of FR_HEADING) if (re.test(line)) return { level: lvl, md: false };
  for (const [re, lvl] of AR_HEADING) if (re.test(line)) return { level: lvl, md: false };
  return null;
}

function articleRef(line) {
  let m = ARTICLE_FR.exec(line);
  if (m) {
    const n = m[1].replace(/\s+/g, ' ').replace(/^1er$/i, '1').replace(/^premier$/i, '1').replace(/^unique$/i, 'unique');
    return n.replace(/\s*\((nouveau|modifié|abrogé)\)/i, '');
  }
  m = ARTICLE_AR.exec(line);
  if (m) {
    let n = m[1].replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
    if (/^(الأول|الاول|أول|اول)$/.test(n)) n = '1';
    return n.replace(/\s+/g, ' ');
  }
  return null;
}

// A legal heading is often followed by its title on the next line, e.g.
// "TITRE PREMIER" / "DU LOUAGE". Such a short line without final punctuation
// is folded into the heading.
function isTitleContinuation(line) {
  if (!line || line.length > 120 || /[.;:]$/.test(line)) return false;
  if (articleRef(line) || headingLevel(line)) return false;
  const letters = line.replace(/[^A-Za-zÀ-ÿ]/g, '');
  const upper = letters && letters === letters.toUpperCase();
  return upper || /^[؀-ۿ]/.test(line) && line.length < 80;
}

function parseStructure(text) {
  const lines = [];
  let pos = 0;
  for (const l of text.split('\n')) { lines.push({ start: pos, end: pos + l.length, text: l }); pos += l.length + 1; }

  const headings = [];
  const units = [];
  const stack = [];                      // [{level, idx}]
  let cur = null;                        // open unit
  const path = () => stack.map((s) => s.idx);
  const close = () => { if (cur) { units.push(cur); cur = null; } };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const t = ln.text;
    if (!t.trim()) {                      // blank line ends a paragraph unit, not an article
      if (cur && cur.kind === 'para') close();
      continue;
    }
    const h = headingLevel(t);
    const ref = h ? null : articleRef(t);
    if (h) {
      close();
      let end = ln.end;
      let label = t.replace(/^#{1,6}\s+/, '');
      // fold a title line that follows a legal heading (skipping one blank line)
      if (!h.md) {
        let j = i + 1;
        if (j < lines.length && !lines[j].text.trim()) j++;
        if (j < lines.length && isTitleContinuation(lines[j].text)) {
          label += ' - ' + lines[j].text; end = lines[j].end; i = j;
        }
      }
      while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
      headings.push({ start: ln.start, end, level: h.level, label: label.trim() });
      stack.push({ level: h.level, idx: headings.length - 1 });
      continue;
    }
    if (ref) {
      close();
      cur = { start: ln.start, end: ln.end, kind: 'article', ref, path: path() };
      continue;
    }
    if (cur) { cur.end = ln.end; continue; }
    cur = { start: ln.start, end: ln.end, kind: 'para', ref: null, path: path() };
  }
  close();
  return { headings, units };
}

if (typeof module !== 'undefined') {
  module.exports = { parseStructure, articleRef, headingLevel, isTitleContinuation };
}
