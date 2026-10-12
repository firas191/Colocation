// wf.orchestrator > "Owner answer": the owner assistant's answer and, when it proposed a change, the proposal to
// confirm (PATCH /v1/listings/:id with {change_id}, or the Telegram button). D-088.
const v = $('Validate body').first().json;
const d = $('Decide route').first().json;
const a = $input.first().json || {};
const o = d.router || {};
const steps = [...d.steps, ...(Array.isArray(a.steps) ? a.steps : [])];
if (a.ok !== true) {
  return [{ json: { ok: false, gw: v.gw, status: 503, steps, error: { code: 'UPSTREAM_UNAVAILABLE',
    message: 'The owner assistant is unavailable', details: [{ issue: a.error_code || 'agent_failed' }] } } }];
}
return [{ json: { ok: true, gw: v.gw, status: 200, steps,
  data: { intent: 'post_listing', language: o.language || d.detected_language || null, status: a.status, answer: a.answer,
          proposal: a.proposal, warnings: [...(d.followup ? ['followup'] : []), ...(d.own_listing ? ['own_listing'] : []), ...(a.warnings || [])], agent: a.agent } } }];
