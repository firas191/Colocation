// wf.owner.agent > "Check answer": the AI Agent node's answer -> a checked answer and one trace step (D-088).
// The proposal itself (what would change) comes from the database (app.owner_change_of_request), not from the model's
// words; the model's answer is kept only when every number in it comes from the message, the memory or a tool.
/* @include lib/agent_check.js */
const a = $('Agent input').first().json;
const r = $('Owner agent').first().json;
const p = ($input.first().json || {}).p || null;
const calls = toolCalls(r.intermediateSteps);
const err = r.error ? String(r.error.message || r.error).slice(0, 300) : null;
const raw = typeof r.output === 'string' ? r.output.trim() : '';
let answer = plainText(raw);
const warnings = [];
let dropped = null;
let cut = false;
if (answer) {
  const chk = checkAnswer(answer, [a.text, a.memory_text, ...calls.map((x) => x.output)]);
  if (!chk.ok) { dropped = { reason: 'unsupported_numbers', numbers: chk.unsupported }; warnings.push('agent_answer_unsupported'); answer = null; }
  else {
    const sh = shorten(answer, a.answer_max_chars || 400);
    if (sh.cut) { answer = sh.text; cut = true; warnings.push('agent_answer_cut'); }
  }
}
const ok = !err && (!!answer || dropped !== null || !!p);
const step = { agent: 'A1_owner_agent', prompt_version_id: a.prompt_version_id || null, model: a.model || null,
  input: { chars: Array.from(a.text || '').length, memory_messages: a.memory_messages ?? null },
  output: { proposed: !!p, fields: p ? (p.diff || []).map((d) => d.field) : [], answer_chars: answer ? Array.from(answer).length : 0,
            raw_chars: Array.from(raw).length, cut, dropped },
  tool_calls: calls.map((x) => ({ tool: x.tool,
    ok: x.output && typeof x.output === 'object' ? (x.output.ok ?? null) : null,
    count: x.output && typeof x.output === 'object' ? (x.output.count ?? undefined) : undefined,
    errors: x.output && Array.isArray(x.output.errors) ? x.output.errors.map((e) => e.issue) : undefined })),
  latency_ms: Date.now() - a.t0, tokens_in: null, tokens_out: null, error: err || (ok ? null : 'no_answer') };
if (!ok) return [{ json: { ok: false, error_code: err ? 'agent_failed' : 'no_answer', steps: [step] } }];
return [{ json: { ok: true, status: p ? 'proposed' : 'answered', answer: answer || null,
  proposal: p ? { change_id: p.change_id, listing_id: p.listing_id, listing_number: p.listing_number, diff: p.diff,
                  changes: p.changes, expires_at: p.expires_at } : null,
  warnings, steps: [step], agent: { tool_calls: calls.map((x) => x.tool), memory_messages: a.memory_messages } } }];
