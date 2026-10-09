// wf.match.agent > "Result": the checked answer with the cards of the search this request ran (if any).
const o = $('Check answer').first().json;
const r = ($input.first().json || {}).r || null;
const steps = [...((r && r.steps) || []), o.step];
if (!o.ok) return [{ json: { ok: false, error_code: o.error_code, steps } }];
const results = r ? r.results || [] : [];
return [{ json: { ok: true, status: r ? 'results' : 'answered', answer: o.answer, results, count: results.length,
  profile: r ? r.profile : null, anchor: r ? r.anchor : null, warnings: o.warnings, steps,
  agent: { tool_calls: o.tool_calls, memory_messages: o.memory_messages } } }];
