// wf.owner.tool_change > "Tool answer": what the model sees: proposed (with what would change) or why not.
// The owner still has to confirm; nothing is written yet.
const r = $input.first().json.r || {};
const c = $('Changes').first().json.changes;
if (!Object.keys(c).length) return [{ json: { ok: false, errors: [{ issue: 'nothing_understood' }], note: 'Give the fields to change.' } }];
if (!r.ok) return [{ json: { ok: false, listing: r.listing ?? null, errors: r.errors || [] } }];
return [{ json: { ok: true, proposed: true, listing: r.listing, changes: r.diff,
  note: 'Proposed, not applied: the owner confirms it with the button under your answer.' } }];
