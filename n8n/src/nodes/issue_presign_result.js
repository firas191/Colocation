// wf.api.issue_photos_presign > "Build result": the PUT URLs in request order. A signing failure is UPSTREAM_UNAVAILABLE.
const gw = $('Gateway').first().json;
const plan = $('Sign each').all().map((i) => i.json);
if (plan[0] && plan[0].reject) {
  const r = plan[0].reject;
  if (r && r.error) return [{ json: { ok: false, gw, status: r.status, error: r.error } }];
  return [{ json: { ok: false, gw, status: 500, error: { code: 'INTERNAL', message: 'Internal error', details: [] } } }];
}
const answers = $input.all().map((i) => i.json);
const out = [];
for (let i = 0; i < plan.length; i++) {
  const a = answers[i] || {};
  const b = a.body !== undefined ? a.body : a;
  if ((a.statusCode && a.statusCode !== 200) || !b || !b.url) {
    return [{ json: { ok: false, gw, status: 503, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Upload URLs could not be created', details: [] } } }];
  }
  out.push({ upload_id: plan[i].slot.upload_id, method: 'PUT', url: b.url, headers: b.headers, expires_at: b.expires_at });
}
return [{ json: { ok: true, gw, status: 200, data: { uploads: out } } }];
