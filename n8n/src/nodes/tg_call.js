// wf.channel.telegram > "Call: __CALL__": the input of wf.channel.telegram.api for one API call.
// The Telegram channel uses the public API like any client (D-079): signature, consent and rate limits apply.
const CALL = '__CALL__';
const P = $('Plan').first().json;
const idem = (suffix) => `tg-${P.update_id}-${suffix}`;
const listingId = () => $('API: create listing').first().json.body.data.listing_id;
let call;
switch (CALL) {
  case 'sync user':
    call = { method: 'POST', path: '/v1/users/sync', idem: idem('sync'),
      body: { external_auth_id: P.ext_id, locale: P.lang, jurisdiction_code: P.new_country || P.country } };
    break;
  case 'record consent': {
    const yes = P.route === 2;
    const user = yes ? $('API: sync user').first().json.body.data.user_id : P.user_id;
    call = { method: 'POST', path: '/v1/me/consents', user_id: user, idem: idem('consent'),
      body: { consents: ['terms', 'privacy', 'media_processing'].map((purpose) => ({ purpose, granted: yes })),
        policy_version: P.policy_version, source: 'telegram' } };
    break;
  }
  case 'ask assistant':
    call = { method: 'POST', path: '/v1/assistant/message', user_id: P.user_id, idem: idem('ask'),
      body: { text: P.text.slice(0, 2000), jurisdiction: P.country } };
    break;
  case 'trace':
    call = { method: 'GET', path: `/v1/admin/traces/${encodeURIComponent(P.last_request_id)}`, user_id: P.user_id };
    break;
  case 'create listing':
    call = { method: 'POST', path: '/v1/listings', user_id: P.user_id, idem: idem('listing'),
      body: { text: P.listing_text.slice(0, 5000), jurisdiction_code: P.country } };
    break;
  case 'presign': {
    const d = $('Download photo').first();
    const mime = (d.binary && d.binary.data && d.binary.data.mimeType) || 'image/jpeg';
    call = { method: 'POST', path: `/v1/listings/${listingId()}/media/presign`, user_id: P.user_id, idem: idem('presign'),
      body: { files: [{ kind: 'photo', content_type: ['image/png', 'image/webp'].includes(mime) ? mime : 'image/jpeg',
        bytes: Number((d.json.result || {}).file_size) || 1 }] } };
    break;
  }
  case 'analyze':
    call = { method: 'POST', path: `/v1/listings/${listingId()}/analyze`, user_id: P.user_id, idem: idem('analyze'), body: {} };
    break;
  case 'job':
    call = { method: 'GET', path: `/v1/jobs/${$('API: analyze').first().json.body.data.job_id}`, user_id: P.user_id };
    break;
  case 'get listing':
    call = { method: 'GET', path: `/v1/listings/${listingId()}`, user_id: P.user_id };
    break;
  default:
    throw new Error(`unknown call ${CALL}`);
}
return [{ json: call }];
