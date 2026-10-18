// wf.api.issue_photos_process > "Each photo": one Media service request per uploaded photo (blur on), or nothing to do.
const r = ($input.first().json || {}).r || {};
if (r.error || !r.data) return [{ json: { reject: r } }];
const base = String(r.data.media_url || '').replace(/\/+$/, '');
if (!r.data.pending.length) return [{ json: { none: true, url: `${base}/health`, body: {} } }];
return r.data.pending.map((p) => ({ json: { p, url: `${base}/v1/images/process`,
  body: { source_key: p.raw_key, output_key: p.media_key, blur: true } } }));
