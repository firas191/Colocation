// wf.api.legal_ask > "Legal answer": the Legal agent's checked answer, the same fields and checks as the assistant's
// legal_question answer (D-087), without the router's fields.
const v = $('Validate body').first().json;
const r = $('Legal request').first().json;
const a = $input.first().json || {};
const steps = Array.isArray(a.steps) ? a.steps : [];
if (a.ok !== true) {
  return [{ json: { ok: false, gw: v.gw, status: 503, steps, error: { code: 'UPSTREAM_UNAVAILABLE',
    message: 'The legal assistant is unavailable', details: [{ issue: a.error_code || 'agent_failed' }] } } }];
}
return [{ json: { ok: true, gw: v.gw, status: 200, steps, data: { language: r.language, jurisdiction: v.jurisdiction, status: a.status,
  answer: a.answer, abstained: a.abstained, abstain_reason: a.abstain_reason, conflict: a.conflict, citations: a.citations,
  missing_information: a.missing_information, notice_version: a.notice_version, warnings: a.warnings || [] } } }];
