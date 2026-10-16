// wf.api.listing_change_cancel > "Build result": POST /v1/listing-changes/{id}/cancel. Someone else's proposal, or
// none, is 404; one that was already applied, cancelled, failed or has expired is 409 with the reason in details.
const v = $('Validate').first().json;
const r = ($input.first().json || {}).r || {};
if (!r.found) return [{ json: { ok: false, gw: v.gw, status: 404, error: { code: 'NOT_FOUND', message: 'Proposal not found', details: [] } } }];
if (!r.cancelled) {
  return [{ json: { ok: false, gw: v.gw, status: 409, error: { code: 'CONFLICT', message: 'The proposal can no longer be cancelled',
    details: [{ field: 'change_id', issue: r.issue }] } } }];
}
return [{ json: { ok: true, gw: v.gw, status: 200, data: { change_id: r.change_id, listing_id: r.listing_id, status: 'cancelled',
  decided_at: r.decided_at } } }];
