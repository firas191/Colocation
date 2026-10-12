// wf.channel.telegram > "Upload request": PUT the photo to the presigned URL. The URL is signed for the public
// proxy host (D-071); from inside n8n the proxy has another name, so the request goes to services.api_url with the
// signed Host header unchanged (the same thing the contract tests do).
const P = $('Plan').first().json;
const r = $input.first().json;
const ups = ((r.body || {}).data || {}).uploads || [];
const photos = $('Download photo').all();
if (ups.length !== photos.length) throw new Error(`presign failed: ${r.error_code || `${ups.length} slots for ${photos.length} photos`}`);
const api = /^(https?:\/\/[^/?#]+)/.exec(P.api_url);
if (!api) throw new Error('unexpected API URL');
// one PUT per photo, slot i for photo i (the API returns the slots in the order of the files asked for)
return ups.map((up, i) => {
  // (no URL class in the Code node's sandbox: split by hand)
  const parts = /^(https?:\/\/)([^/?#]+)(.*)$/.exec(up.url);
  if (!parts) throw new Error('unexpected upload URL');
  return { json: { url: `${api[1]}${parts[3]}`, headers: { ...(up.headers || {}), Host: parts[2] }, upload_id: up.upload_id },
    binary: photos[i].binary };
});
