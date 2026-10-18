// wf.api.documents_assistant > "Build result": the answer and the proposal stored in this request (if any). Making
// the PDF is a separate call the person confirms: POST /v1/households/{id}/documents {draft_id}.
const a = $('Agent input').first().json;
const c = $('Check answer').first().json;
const d = ($input.first().json || {}).r || null;
if (!c.ok) {
  return [{ json: { ok: false, gw: a.gw, status: 503, steps: [c.step], error: { code: 'UPSTREAM_UNAVAILABLE',
    message: 'The document assistant is unavailable', details: [{ issue: c.step.error || 'agent_failed' }] } } }];
}
return [{ json: { ok: true, gw: a.gw, status: 200, steps: [c.step], data: { answer: c.answer,
  draft: d && d.data ? d.data.draft : null, language: a.language } } }];
