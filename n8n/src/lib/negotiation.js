// Integer minor units only. The database repeats all authorization and amount checks.
const minor = (v) => Number.isSafeInteger(v) && v > 0 && v <= 1000000000;
const uuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
function proposal(raw, context) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  const ceiling = Math.min(context.asking_minor, context.max_minor,
    context.counter_minor || Number.MAX_SAFE_INTEGER);
  const amount = parsed && parsed.offer_minor;
  const modelUsed = minor(amount) && amount <= ceiling;
  const fallback = Math.max(1, Math.min(context.target_minor, ceiling));
  return { amount_minor: modelUsed ? amount : fallback, model_used: !!modelUsed,
    rationale: modelUsed && typeof parsed.reasoning_summary === 'string'
      ? parsed.reasoning_summary.replace(/[\u0000-\u001f<>]/g, ' ').slice(0, 220)
      : 'Proposition prudente sous le plafond autorisé.' };
}
if (typeof module !== 'undefined') module.exports = { minor, uuid, proposal };
