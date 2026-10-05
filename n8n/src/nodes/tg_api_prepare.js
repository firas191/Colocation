// wf.channel.telegram.api > "Prepare": the body as the exact string that is signed and sent.
const s = $input.first().json;
return [{ json: { method: s.method, path: s.path, user_id: s.user_id || '', idem: s.idem || '',
  body_text: s.body === undefined || s.body === null ? '' : JSON.stringify(s.body) } }];
