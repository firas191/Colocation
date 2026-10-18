// wf.api.issue_photos_process > "Results": the Media service's answers -> rows for api.issue_photo_store, and the raw
// keys to delete (processed or rejected, a raw upload is not kept).
const v = $('Validate').first().json;
const plan = $('Each photo').all().map((i) => i.json);
const answers = $input.all().map((i) => i.json);
const results = [];
const raw = [];
plan.forEach((pl, i) => {
  if (!pl.p) return;
  const a = answers[i] || {};
  const b = a.body !== undefined ? a.body : a;
  const ok = a.statusCode === 200 && b && b.output;
  const err = !ok && b && b.error ? ((b.error.details || [])[0] || {}).issue || b.error.code : (ok ? null : `HTTP ${a.statusCode || 0}`);
  results.push({ upload_id: pl.p.upload_id, ok: !!ok, media_key: pl.p.media_key, error_code: err,
    width: ok ? b.output.width : null, height: ok ? b.output.height : null });
  if (ok || (a.statusCode && a.statusCode < 500)) raw.push(pl.p.raw_key);
});
const r0 = ($('Pending').first().json || {}).r || {};
return [{ json: { reject: plan[0] && plan[0].reject ? plan[0].reject : null,
  params: [v.gw.ctx.user_id, JSON.stringify({ ...v.input, results })],
  raw_keys: raw.length ? raw : ['uploads/none'],
  delete_url: `${String((r0.data || {}).media_url || '').replace(/\/+$/, '')}/v1/storage/delete` } }];
