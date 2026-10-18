// wf.api.documents_create > "Store input": the Media service's answer -> the document row (ready or failed).
const f = $('Fill').first().json;
const res = $input.first().json || {};
const body = res.body && typeof res.body === 'object' ? res.body : null;
const ok = res.statusCode === 200 && body && body.key === f.body.key;
const store = { ...f.store, status: ok ? 'ready' : 'failed', storage_key: ok ? body.key : null, bytes: ok ? body.bytes : null,
  sha256: ok ? body.sha256 : null, error_code: ok ? null : (body && body.error && body.error.code) || 'media_unavailable' };
return [{ json: { params: [f.gw.ctx.user_id, JSON.stringify({ store })] } }];
