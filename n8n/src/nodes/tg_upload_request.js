// wf.channel.telegram > "Upload request": PUT the photo to the presigned URL. The URL is signed for the public
// proxy host (D-071); from inside n8n the proxy has another name, so the request goes to services.api_url with the
// signed Host header unchanged (the same thing the contract tests do).
const P = $('Plan').first().json;
const r = $input.first().json;
const up = (((r.body || {}).data || {}).uploads || [])[0];
if (!up) throw new Error(`presign failed: ${r.error_code || 'no upload slot'}`);
// (no URL class in the Code node's sandbox: split by hand)
const parts = /^(https?:\/\/)([^/?#]+)(.*)$/.exec(up.url);
const api = /^(https?:\/\/[^/?#]+)/.exec(P.api_url);
if (!parts || !api) throw new Error('unexpected upload or API URL');
const headers = { ...(up.headers || {}), Host: parts[2] };
return [{ json: { url: `${api[1]}${parts[3]}`, headers, upload_id: up.upload_id },
  binary: $('Download photo').first().binary }];
