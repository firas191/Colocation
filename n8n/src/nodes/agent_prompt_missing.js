// wf.match.agent and wf.legal.agent > "No prompt": the registry has no active version of the agent's prompt.
const a = $input.first().json;
return [{ json: { ok: false, error_code: a.error_code, steps: [{ agent: a.agent || 'A3_match_agent', model: null, input: {}, output: null,
  latency_ms: 0, tokens_in: 0, tokens_out: 0, error: a.error_code }] } }];
