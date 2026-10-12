// wf.orchestrator > "Decide route" (deterministic, spec 8.1). Output index for the Switch:
// 0 search_listings, 1 ask a clarifying question (needs_clarification, or confidence below
// router.min_confidence), 2 a supported intent whose agent comes in a later phase,
// 3 smalltalk_or_unsupported, 4 the router failed, 5 legal_question with the A5 Legal agent on (D-087),
// 6 post_listing from a user with listings, the owner assistant on (D-088).
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
else if (r.output.intent === 'legal_question' && $('Context').first().json.legal_enabled === true) route = 5;
// a user who already has listings and writes about posting: the owner assistant changes them (D-088); without
// listings, the hint to send /annonce as before
else if (r.output.intent === 'post_listing' && $('Context').first().json.owner_enabled === true
         && $('Context').first().json.has_listings === true) route = 6;
else route = 2;
// A follow-up of a recent search ("cheaper?", "and the second one?") or legal answer ("and if he refuses?") reads as
// smalltalk or unclear to P1, which sees one message. It goes to the agent of the most recent conversation within
// match.followup_minutes, if that agent is on; the agent has the conversation (D-084, D-087).
const ctx = $('Context').first().json;
const open = ctx.followup_agent;
let followup = false;
if (route === 1 || route === 3) {
  if (open === 'match' && ctx.agent_enabled === true) { route = 0; followup = true; }
  else if (open === 'legal' && ctx.legal_enabled === true) { route = 5; followup = true; }
  else if (open === 'owner' && ctx.owner_enabled === true && ctx.has_listings === true) { route = 6; followup = true; }
}
// A message about the user's own listing ("mon annonce", "my listing", "annonce mte3i", "إعلاني") from a user who has
// listings goes to the owner assistant whatever P1 said: on the PC (T-56) P1 sent 3 such requests to the Legal agent,
// the search or report_problem (D-089).
const OWN = /(^|[^\p{L}])(mon annonce|mes annonces|my listings?|annonce mte3i|annonce mta3i|el annonce mte3i)([^\p{L}]|$)|إعلاني/iu;
let ownListing = false;
if (route !== 4 && route !== 6 && ctx.owner_enabled === true && ctx.has_listings === true && OWN.test(v.text)) {
  route = 6; ownListing = true;
}
const o = r.ok ? r.output : {};
const hint = ['TN', 'FR', 'GB'].includes(o.jurisdiction_hint) ? o.jurisdiction_hint : null;
return [{ json: { route, followup, own_listing: ownListing, agent_enabled: ctx.agent_enabled === true, router: o, call_error: !!r.call_error, steps: [textStep, step],
  detected_language: tb ? tb.language.language : null,
  extract: { text: v.text, jurisdiction: hint || v.jurisdiction, today: v.today } } }];
