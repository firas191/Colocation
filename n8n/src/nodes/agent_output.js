// wf.match.agent > "Check answer"
// The AI Agent node's answer and intermediate steps -> a checked answer and one trace step (spec 8.3).
//  - every number in the answer must come from the message, the memory or a tool result (agent_check.checkAnswer); otherwise
//    the answer is dropped and the channel shows the result cards alone (warning agent_answer_unsupported)
//  - no answer at all (model down, too many iterations) -> ok false, and the orchestrator falls back to P2 + search
/* @include lib/agent_check.js */
const a = $('Agent input').first().json;
const r = $input.first().json;
const calls = toolCalls(r.intermediateSteps);
const latency = Date.now() - a.t0;
const err = r.error ? String(r.error.message || r.error).slice(0, 300) : null;
let answer = typeof r.output === 'string' ? r.output.trim() : '';
const warnings = [];
let dropped = null;
if (answer) {
  const chk = checkAnswer(answer, [a.text, a.memory_text, ...calls.map((x) => x.output)]);
  if (!chk.ok) { dropped = { reason: 'unsupported_numbers', numbers: chk.unsupported }; warnings.push('agent_answer_unsupported'); answer = null; }
  else if (answer.length > 1200) { answer = answer.slice(0, 1200); warnings.push('agent_answer_cut'); }
}
const ok = !err && (answer !== '' || dropped !== null);
// no raw text in the trace (D-062): tool names, sizes and counts only
const step = { agent: 'A3_match_agent', prompt_version_id: a.prompt_version_id || null, model: a.model || null,
  input: { chars: Array.from(a.text || '').length, memory_messages: a.memory_messages ?? null },
  output: { answer_chars: answer ? Array.from(answer).length : 0, dropped },
  tool_calls: calls.map((x) => ({ tool: x.tool,
    input_chars: x.input && x.input.request ? Array.from(String(x.input.request)).length : undefined,
    number: x.input && x.input.number != null ? x.input.number : undefined,
    found: x.output && typeof x.output === 'object' ? (x.output.found ?? null) : null })),
  latency_ms: latency, tokens_in: null, tokens_out: null,
  error: err || (ok ? null : 'no_answer') };
return [{ json: { ok, error_code: ok ? null : (err ? 'agent_failed' : 'no_answer'), answer: answer || null, warnings, step,
  searched: calls.some((x) => x.tool === 'search_listings'), tool_calls: calls.map((x) => x.tool),
  session_id: a.session_id, request_id: a.request_id, memory_messages: a.memory_messages } }];
