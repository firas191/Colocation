// wf.orchestrator > "Legal answer": the Legal agent's checked answer with its citations, or its abstention (D-087).
// No fixed path behind the Legal agent: when it fails, the request fails with 503 and the channel says so.
const v = $('Validate body').first().json;
const d = $('Decide route').first().json;
const a = $input.first().json || {};
const o = d.router || {};
const steps = [...d.steps, ...(Array.isArray(a.steps) ? a.steps : [])];
if (a.ok !== true) {
  return [{ json: { ok: false, gw: v.gw, status: 503, steps, error: { code: 'UPSTREAM_UNAVAILABLE',
    message: 'The legal assistant is unavailable', details: [{ issue: a.error_code || 'agent_failed' }] } } }];
}
return [{ json: { ok: true, gw: v.gw, status: 200, steps,
  data: { intent: 'legal_question', language: o.language || d.detected_language || null, status: a.status, answer: a.answer,
          abstained: a.abstained, abstain_reason: a.abstain_reason, conflict: a.conflict, citations: a.citations,
          missing_information: a.missing_information, notice_version: a.notice_version,
          jurisdiction: d.extract.jurisdiction || null,
          warnings: [...(d.followup ? ['followup'] : []), ...(a.warnings || [])], agent: a.agent } } }];
