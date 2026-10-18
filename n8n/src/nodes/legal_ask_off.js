// wf.api.legal_ask > "Agent off": legal.agent_enabled is false; there is no fixed path behind the Legal agent.
const v = $('Validate body').first().json;
return [{ json: { ok: false, gw: v.gw, status: 503, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'The legal assistant is off',
  details: [{ issue: 'agent_off' }] } } }];
