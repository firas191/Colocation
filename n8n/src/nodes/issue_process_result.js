// wf.api.issue_photos_process > "Build result": how many photos were processed and refused.
const gw = $('Gateway').first().json;
const res = $('Results').first().json;
if (res.reject) {
  const r = res.reject;
  if (r && r.error) return [{ json: { ok: false, gw, status: r.status, error: r.error } }];
}
const r = ($('Store').first().json || {}).r || null;
if (!r || r.error) return [{ json: { ok: false, gw, status: (r && r.status) || 500, error: (r && r.error) || { code: 'INTERNAL', message: 'Internal error', details: [] } } }];
const rows = JSON.parse(res.params[1]).results || [];
return [{ json: { ok: true, gw, status: 200, data: { issue_id: r.data.issue_id, processed: rows.filter((x) => x.ok).length,
  rejected: rows.filter((x) => !x.ok).map((x) => ({ upload_id: x.upload_id, issue: x.error_code })), pending: r.data.pending.length } } }];
