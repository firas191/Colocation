// A3 Match agent checks (D-084), shared by the agent workflow and the unit tests.
//  - toolCalls(steps): the AI Agent node's intermediate steps as [{tool, input, output}] (output parsed when JSON).
//  - numbersIn(text): every reading of every number written in a text (see readings).
//  - checkAnswer(answer, sources): every number of two digits or more in the answer must appear in one of the
//    sources (the user's message, the tool results). Small numbers (result positions, counts up to 10) pass.
//  - fallbackMask(text): e-mails and long digit runs masked, used only when the Text service did not answer.

function toolCalls(steps) {
  return (Array.isArray(steps) ? steps : []).map((s) => {
    const a = s.action || {};
    let out = s.observation;
    if (typeof out === 'string') { try { out = JSON.parse(out); } catch (e) { /* keep the text */ } }
    if (Array.isArray(out) && out.length === 1) out = out[0];          // a workflow tool answers with its items
    let input = a.toolInput;
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch (e) { /* keep the text */ } }
    return { tool: a.tool || null, input: input ?? null, output: out ?? null };
  });
}

// Each number written in a text, with its possible readings: "450.000" is 450 (Tunisian dinars, three decimals) or
// 450000 (dot as thousands separator); "1.225.000" is 1225000; "450,5" is 450.5.
function readings(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/\d{1,3}(?:\.\d{3})+(?!\d|,\d)|\d+(?:[.,]\d+)?/g)) {
    const raw = m[0];
    const alts = new Set();
    if (/^\d{1,3}(?:\.\d{3})+$/.test(raw)) alts.add(Number(raw.replace(/\./g, '')));
    const v = Number(raw.replace(',', '.'));
    if (Number.isFinite(v)) alts.add(v);
    out.push([...alts]);
  }
  return out;
}

function numbersIn(text) {
  return readings(text).flat();
}

function checkAnswer(answer, sources) {
  const allowed = new Set();
  for (const src of sources || []) {
    const text = typeof src === 'string' ? src : JSON.stringify(src ?? '');
    for (const n of numbersIn(text)) {
      allowed.add(n);
      allowed.add(Math.round(n));
    }
  }
  const unsupported = [];
  for (const alts of readings(answer)) {
    if (alts.some((n) => Number.isInteger(n) && n <= 10)) continue;
    if (alts.some((n) => allowed.has(n) || allowed.has(Math.round(n)))) continue;
    unsupported.push(alts[alts.length - 1]);
  }
  return { ok: unsupported.length === 0, unsupported };
}

function fallbackMask(text) {
  return String(text || '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<EMAIL>')
    .replace(/\+?\d[\d .-]{6,}\d/g, (m) => (m.replace(/\D/g, '').length >= 8 ? '<PHONE>' : m));
}

if (typeof module !== 'undefined') module.exports = { toolCalls, readings, numbersIn, checkAnswer, fallbackMask };
