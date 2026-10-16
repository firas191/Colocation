// Scam agent (A4): reading the AI Agent node's final answer and its tool calls.
// The final answer must be one JSON object {signals, prices_in_text, note}; text around it (a sentence, a ```json fence)
// is ignored. Anything else is not trusted: the check then runs on the rules alone.

function scamParseAnswer(raw) {
  const s = String(raw || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let o;
  try { o = JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
  if (!o || typeof o !== 'object' || !Array.isArray(o.signals)) return null;
  return { signals: o.signals.filter((x) => x && typeof x === 'object').slice(0, 8),
    prices_in_text: Array.isArray(o.prices_in_text) ? o.prices_in_text.filter((x) => x && typeof x === 'object').slice(0, 10) : [],
    note: typeof o.note === 'string' ? o.note.trim().slice(0, 400) : '' };
}

function scamToolOutput(x) {
  if (x == null) return null;
  if (typeof x === 'object') return x;
  try { return JSON.parse(String(x)); } catch (e) { return null; }
}

// contact_reuse results seen by the agent: [{contact, other_listings, other_owners}] (database counts, not model words).
function scamContactReuse(calls) {
  const out = [];
  for (const c of Array.isArray(calls) ? calls : []) {
    if (!c || c.tool !== 'contact_reuse') continue;
    const o = scamToolOutput(c.output);
    if (o && o.contact != null) out.push({ contact: String(o.contact), other_listings: Number(o.other_listings) || 0,
      other_owners: Number(o.other_owners) || 0 });
  }
  return out;
}

if (typeof module !== 'undefined') module.exports = { scamParseAnswer, scamContactReuse };
