// wf.channel.telegram.api > "Request": the signed request (docs/API_SIGNING.md). The signature was computed in the
// database by sec.sign_internal, which holds the telegram client's secret (D-079); here only the headers are set.
// Input (Start): {method, path, user_id?, body?, idem?}; the body is sent as the exact string that was signed.
const s = $('Prepare').first().json;
const g = $input.first().json;
const headers = { 'X-Key-Id': 'telegram', 'X-Timestamp': g.s.timestamp, 'X-Request-Id': g.rid, 'X-Signature': g.s.signature };
if (s.user_id) headers['X-User-Id'] = s.user_id;
if (s.idem) headers['X-Idempotency-Key'] = s.idem;
if (s.body_text) headers['Content-Type'] = 'application/json';
return [{ json: { url: String(g.api_url).replace(/\/+$/, '') + s.path, method: s.method, headers, body_text: s.body_text,
  has_body: !!s.body_text, request_id: g.rid } }];
