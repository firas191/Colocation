// wf.api.listings_presign > "Build result": the signed URLs, in request order. A signing failure is
// UPSTREAM_UNAVAILABLE (the slots stay pending and expire by themselves).
const v = $('Validate body').first().json;
const slots = $('Slots').all().map((i) => i.json);
const answers = $input.all().map((i) => i.json);
const out = [];
for (let i = 0; i < slots.length; i++) {
  const a = answers[i] || {};
  const body = typeof a.data === 'string' ? (() => { try { return JSON.parse(a.data); } catch (e) { return {}; } })() : (a.body || a);
  if (a.statusCode && a.statusCode !== 200 || !body.url) {
    return [{ json: { ok: false, gw: v.gw, status: 503, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Upload URLs could not be created', details: [] },
      log: { reason: 'presign', detail: `HTTP ${a.statusCode || 0}` } } }];
  }
  const u = slots[i].upload;
  out.push({ upload_id: u.upload_id, kind: u.kind, content_type: u.content_type, method: body.method, url: body.url,
    headers: body.headers, expires_at: body.expires_at });
}
return [{ json: { ok: true, gw: v.gw, status: 200, data: { uploads: out,
  next: { analyze: `/v1/listings/${v.gw.ctx.params.id}/analyze` } } } }];
