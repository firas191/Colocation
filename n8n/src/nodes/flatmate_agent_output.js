// wf.api.flatmate_assistant > "Check answer" (platform P12, D-115): the agent's text, and the proposal of its last
// propose_profile call checked again by code: known fields and values only, and an amount, a place or a date only when
// the person wrote it in this conversation ("Session text"). A trace step without the person's text (D-062).
/* @include lib/agent_check.js */
/* @include lib/flatmate_profile.js */
const a = $('Agent input').first().json;
const r = $('Profile agent').first().json || {};
const said = ($input.all() || []).map((i) => i.json && i.json.text).filter(Boolean);
said.push(a.text);
const raw = typeof r.output === 'string' ? r.output.trim() : '';
const err = r.error ? String(r.error.message || r.error).slice(0, 300) : null;
const calls = toolCalls(r.intermediateSteps);
const last = calls.filter((x) => x.tool === 'propose_profile').pop();
let proposal = null;
let dropped = [];
if (last && last.input) {
  const c = checkProposal(last.input.values !== undefined ? last.input.values : last.input);
  const s = supportedByText(c.values, said);
  dropped = [...c.errors.map((e) => ({ field: e.field, why: e.issue })), ...s.dropped];
  proposal = Object.keys(s.values).length ? s.values : null;
}
const q2 = twoQuestions(raw ? shorten(plainText(raw), 700).text : '');
const answer = raw ? q2.text : null;
const step = { agent: 'A7_flatmate_agent', prompt_version_id: a.prompt_version_id, model: a.model,
  input: { missing: a.missing_before }, output: { answer_chars: answer ? Array.from(answer).length : 0,
    proposed: proposal ? Object.keys(proposal) : [], dropped, questions_cut: q2.cut },
  tool_calls: calls.map((x) => ({ tool: x.tool })), latency_ms: Date.now() - a.t0, tokens_in: null, tokens_out: null,
  error: err || (raw ? null : 'no_answer') };
if (err || !raw) {
  return [{ json: { ok: false, gw: a.gw, status: 503, steps: [step], error: { code: 'UPSTREAM_UNAVAILABLE',
    message: 'The profile assistant is unavailable', details: [{ issue: step.error || 'agent_failed' }] } } }];
}
return [{ json: { ok: true, gw: a.gw, status: 200, steps: [step], data: { answer, proposal, dropped } } }];
