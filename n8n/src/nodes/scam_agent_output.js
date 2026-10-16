// wf.scam.check > "Agent output"
// The AI Agent node's answer and tool calls: the moderator note (plain text; kept only if every number in it comes from
// the listing or a tool result, agent_check.checkAnswer), the contact_reuse results and the list of tools it chose.
// No answer (model down, iteration limit) -> agent_ok false: the detector and the rules still score the listing.
/* @include lib/agent_check.js */
/* @include lib/scam_agent.js */
const a = $('Agent input').first().json;
const latency = Date.now() - (a.t0 || Date.now());
const base = { agent_model: a.model || null, agent_prompt_version_id: a.prompt_version_id || null, agent_latency_ms: latency };
if (!a.ok) return [{ json: { ...base, agent_ok: false, agent_error: a.error_code || 'agent_input', note: null, contact_reuse: [], tool_calls: [] } }];
const r = $input.first().json;
const calls = toolCalls(r.intermediateSteps);
const err = r.error ? String(r.error.message || r.error).slice(0, 300) : null;
let note = typeof r.output === 'string' ? plainText(r.output) : '';
let dropped = null;
if (note) {
  const chk = checkAnswer(note, [a.text, ...calls.map((x) => (typeof x.output === 'string' ? x.output : JSON.stringify(x.output)))]);
  if (chk.ok) note = shorten(note, 300).text; else { dropped = chk.unsupported; note = null; }
}
return [{ json: { ...base, agent_ok: !err && !!note, agent_error: err || (dropped ? 'note_unsupported_numbers' : (note ? null : 'no_answer')),
  note: note || null, contact_reuse: scamContactReuse(calls), tool_calls: calls.map((x) => x.tool) } }];
