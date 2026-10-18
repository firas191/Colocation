// wf.documents.tool > "Tool answer": what the model is told. After propose_document: the draft's id and what is still
// missing; the person confirms the draft on the page.
const p = $('Plan').first().json;
if (!p.store) return [{ json: p.answer }];
const r = ($input.first().json || {}).r || null;
if (!r || r.error) return [{ json: { ok: false, error: 'draft_not_stored' } }];
return [{ json: { ok: true, draft_id: r.data.draft_id, kind: r.data.kind, missing: p.missing, ignored_fields: p.dropped,
  next: p.missing.length ? 'ask the user for the missing fields, then propose again' : 'tell the user to check the proposal and confirm it with the button' } }];
