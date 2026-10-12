// A5 Legal agent checks (D-087), shared by the agent workflow and the unit tests.
//  - parseLegal(text): reads the tokens [NOT_FOUND] and [CONFLICT] and removes them; moves a marker written after a
//    sentence end into that sentence ("dues. [1]" -> "dues [1].").
//  - markers(text): the citation numbers written in the text, in order: "[2]", "[1, 3]", "[1][2]".
//  - renumber(text, valid): keeps the markers whose number is in `valid` (numbers the search tool gave), drops the
//    others, and renumbers the kept ones 1, 2, ... in order of first appearance. Returns {text, used (the original
//    numbers, in the new order), invalid (numbers dropped)}.
//  - stripMarkers(text): the text without markers, for the number check (a marker is not a claim).
//  - uncited(text): sentences that state something without a marker (sentences of fewer than four words are skipped).

const MARK_RE = /\[\s*(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\s*\]/g;

function parseLegal(text) {
  let t = String(text || '').trim();
  let notFound = false;
  let conflict = false;
  for (;;) {
    const m = /^\[?\s*(NOT_FOUND|CONFLICT)\s*\]?\s*[:.-]?\s*/i.exec(t);
    if (!m) break;
    if (m[1].toUpperCase() === 'NOT_FOUND') notFound = true; else conflict = true;
    t = t.slice(m[0].length);
  }
  // a model may also put the token elsewhere: it still counts, and is removed
  if (/\[\s*NOT_FOUND\s*\]/i.test(t)) { notFound = true; t = t.replace(/\[\s*NOT_FOUND\s*\]/gi, ' '); }
  if (/\[\s*CONFLICT\s*\]/i.test(t)) { conflict = true; t = t.replace(/\[\s*CONFLICT\s*\]/gi, ' '); }
  // "... dues. [1] Voir" -> "... dues [1]. Voir": a marker belongs to the sentence before it
  t = t.replace(/([.!?\u061F])\s*((?:\[\s*\d{1,3}(?:\s*[,;]\s*\d{1,3})*\s*\]\s*)+)/g, (m, p, marks) => ` ${marks.trim()}${p} `);
  return { notFound, conflict, text: t.replace(/\s+([.!?\u061F])/g, '$1').replace(/\s{2,}/g, ' ').trim() };
}

function markers(text) {
  const out = [];
  for (const m of String(text || '').matchAll(MARK_RE)) for (const x of m[1].split(/[,;]/)) out.push(Number(x.trim()));
  return out;
}

function renumber(text, valid) {
  const ok = new Set((valid || []).map(Number));
  const order = [];
  const invalid = [];
  const out = String(text || '').replace(MARK_RE, (all, list) => {
    const nums = list.split(/[,;]/).map((x) => Number(x.trim()));
    const kept = [];
    for (const n of nums) {
      if (!ok.has(n)) { invalid.push(n); continue; }
      if (!order.includes(n)) order.push(n);
      const k = order.indexOf(n) + 1;
      if (!kept.includes(k)) kept.push(k);
    }
    return kept.length ? '[' + kept.join(', ') + ']' : '';
  }).replace(/\s+([.,;:!?؟])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  return { text: out, used: order, invalid };
}

function stripMarkers(text) {
  return String(text || '').replace(MARK_RE, ' ').replace(/\s{2,}/g, ' ').trim();
}

function uncited(text) {
  const sentences = String(text || '').split(/(?<=[.!?؟])\s+/).map((s) => s.trim()).filter(Boolean);
  return sentences.filter((s) => s.split(/\s+/).length >= 4 && !markers(s).length).length;
}

if (typeof module !== 'undefined') module.exports = { parseLegal, markers, renumber, stripMarkers, uncited };
