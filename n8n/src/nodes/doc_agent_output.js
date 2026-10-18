// wf.api.documents_assistant > "Check answer": the agent's sentence (plain text, shortened) and a trace step without
// the person's text (D-062). The proposal shown comes from the database ("Last draft"), not from the model's text.
/* @include lib/agent_check.js */
const a = $('Agent input').first().json;
const r = $('Document agent').first().json || {};
const raw = typeof r.output === 'string' ? r.output.trim() : '';
const err = r.error ? String(r.error.message || r.error).slice(0, 300) : null;
const calls = toolCalls(r.intermediateSteps);
const answer = raw ? shorten(plainText(raw), 500).text : null;
const step = { agent: 'A6_document_agent', prompt_version_id: a.prompt_version_id, model: a.model,
  input: { kinds: a.kinds }, output: { answer_chars: answer ? Array.from(answer).length : 0, proposals: calls.filter((x) => x.tool === 'propose_document').length },
  tool_calls: calls.map((x) => ({ tool: x.tool })), latency_ms: Date.now() - a.t0, tokens_in: null, tokens_out: null,
  error: err || (raw ? null : 'no_answer') };
return [{ json: { ok: !err && !!raw, answer, step, params: [a.user_id, JSON.stringify({ household_id: a.household_id, since: a.since })] } }];
