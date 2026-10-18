// wf.api.issue_photos_presign > "Sign each": one Media service request per upload slot, or the function's error.
const r = ($input.first().json || {}).r || {};
if (r.error || !r.data) return [{ json: { reject: r } }];
const base = String(r.data.media_url || '').replace(/\/+$/, '');
return r.data.slots.map((s) => ({ json: { slot: s, url: `${base}/v1/storage/presign`,
  body: { key: s.key, content_type: s.content_type, expires_s: 600 } } }));
