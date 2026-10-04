// wf.orchestrator > "Other intents": clarification, intents of later phases, smalltalk, router failure.
// Status codes, not sentences (spec 17.1); the clarifying question is the router's, in the user's language.
const v = $('Validate body').first().json;
const d = $input.first().json;
const o = d.router || {};
if (d.route === 4) {
  if (d.call_error) return [{ json: { ok: false, gw: v.gw, status: 503, steps: d.steps, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'The language model is unavailable', details: [] } } }];
  return [{ json: { ok: true, gw: v.gw, status: 200, steps: d.steps, data: { intent: null, status: 'not_understood', language: null } } }];
}
const status = { 1: 'clarification_needed', 2: 'not_available_yet', 3: 'unsupported' }[d.route];
return [{ json: { ok: true, gw: v.gw, status: 200, steps: d.steps, data: { intent: o.intent, language: o.language,
  status, confidence: o.confidence, clarifying_question: d.route === 1 ? (o.clarifying_question || null) : null } } }];
