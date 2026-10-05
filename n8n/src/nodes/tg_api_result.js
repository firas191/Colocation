// wf.channel.telegram.api > "Result": {status, body, request_id, error_code}. status 0 = no answer from the API.
const q = $('Request').first().json;
const r = $input.first().json || {};
let body = r.body !== undefined ? r.body : r.data;     // text response: parsed here (a JSON response object came back as a stream)
if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = { raw: body.slice(0, 300) }; } }
const status = Number(r.statusCode || 0);
return [{ json: { status, body: body || null, request_id: q.request_id,
  error_code: status >= 200 && status < 300 ? null : ((body && body.error && body.error.code) || (status ? `HTTP_${status}` : 'NO_ANSWER')) } }];
