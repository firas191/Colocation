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
// Text service result (language, PII), recorded as its own step; the request text is not stored (D-062).
const tr = $('Text analysis').first().json || {};
const tb = tr.body && typeof tr.body === 'object' ? tr.body : null;
const textStep = { agent: 'A0_text', model: tb ? tb.backend : null, input: { chars: Array.from(v.text).length },
  output: tb ? { language: tb.language.language, script: tb.language.script, method: tb.language.method,
    pii_counts: tb.pii ? tb.pii.counts : {}, ner: tb.pii ? tb.pii.ner : false } : null,
  latency_ms: tb ? Math.round(tb.ms) : null, tokens_in: 0, tokens_out: 0,
  error: tb ? null : `text service answered ${tr.statusCode || tr.code || 'nothing'}` };
let route;
if (!r.ok) route = 4;
else if (r.output.needs_clarification || r.output.confidence < min) route = 1;
else if (r.output.intent === 'search_listings') route = 0;
else if (r.output.intent === 'smalltalk_or_unsupported') route = 3;
else route = 2;
// A follow-up of a recent search ("cheaper?", "and the second one?") reads as smalltalk or unclear to P1, which sees
// one message. With the Match agent on and a search in the last match.followup_minutes, it goes to the agent,
// which has the conversation (D-084).
const ctx = $('Context').first().json;
const followup = (route === 1 || route === 3) && ctx.agent_enabled === true && ctx.followup_open === true;
if (followup) route = 0;
const o = r.ok ? r.output : {};
const hint = ['TN', 'FR', 'GB'].includes(o.jurisdiction_hint) ? o.jurisdiction_hint : null;
return [{ json: { route, followup, agent_enabled: ctx.agent_enabled === true, router: o, call_error: !!r.call_error, steps: [textStep, step],
  detected_language: tb ? tb.language.language : null,
  extract: { text: v.text, jurisdiction: hint || v.jurisdiction, today: v.today } } }];
