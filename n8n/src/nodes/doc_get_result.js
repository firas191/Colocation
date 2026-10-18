// wf.api.document_get > "Build result": the document with its download link (or download null when the file is not
// there or the signing service did not answer: warning download_unavailable).
const gw = $('Gateway').first().json;
const s = $('Sign request').first().json;
const r = s.r;
if (!r || !r.status) return [{ json: { ok: false, gw, status: 500, error: { code: 'INTERNAL', message: 'Internal error', details: [] } } }];
if (r.error) return [{ json: { ok: false, gw, status: r.status, error: { code: r.error.code, message: r.error.message, details: r.error.details || [] } } }];
const res = $input.first().json || {};
const u = res.statusCode === 200 && res.body && Array.isArray(res.body.urls) ? res.body.urls[0] : null;
const { storage_key, ...doc } = r.data;
return [{ json: { ok: true, gw, status: 200, data: { ...doc, download: u ? { url: u.url, expires_at: u.expires_at } : null,
  warnings: storage_key && !u ? ['download_unavailable'] : [] } } }];
