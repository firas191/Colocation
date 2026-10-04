// wf.orchestrator > "Decide route" (deterministic, spec 8.1). Output index for the Switch:
// 0 search_listings, 1 ask a clarifying question (needs_clarification, or confidence below
// router.min_confidence), 2 a supported intent whose agent comes in a later phase,
// 3 smalltalk_or_unsupported, 4 the router failed.
const r = $input.first().json;
const v = $('Validate body').first().json;
const min = Number($('Context').first().json.min_confidence ?? 0.6);
const step = { agent: 'A0_orchestrator', prompt_version_id: r.prompt_version_id || null, model: r.model || null,
  input: { chars: Array.from(v.text).length }, output: r.ok ? r.output : { error_code: r.error_code },
  latency_ms: r.latency_ms, tokens_in: r.tokens_in || 0, tokens_out: r.tokens_out || 0,
  error: r.ok ? null : `${r.error_code}${r.detail ? ': ' + String(r.detail).slice(0, 200) : ''}` };
let route;
if (!r.ok) route = 4;
else if (r.output.needs_clarification || r.output.confidence < min) route = 1;
else if (r.output.intent === 'search_listings') route = 0;
else if (r.output.intent === 'smalltalk_or_unsupported') route = 3;
else route = 2;
const o = r.ok ? r.output : {};
const hint = ['TN', 'FR', 'GB'].includes(o.jurisdiction_hint) ? o.jurisdiction_hint : null;
return [{ json: { route, router: o, call_error: !!r.call_error, steps: [step],
  extract: { text: v.text, jurisdiction: hint || v.jurisdiction, today: v.today } } }];
