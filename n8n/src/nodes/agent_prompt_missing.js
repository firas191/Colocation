// wf.match.agent > "No prompt": the registry has no active P6_match_agent version; the orchestrator falls back.
const a = $input.first().json;
return [{ json: { ok: false, error_code: a.error_code, steps: [{ agent: 'A3_match_agent', model: null, input: {}, output: null,
  latency_ms: 0, tokens_in: 0, tokens_out: 0, error: a.error_code }] } }];
