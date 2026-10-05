// wf.channel.telegram > "__NAME__": an API call of the listing flow failed; the reason in plain words.
/* @include lib/tg_texts.js */
const P = $('Plan').first().json;
const r = $input.first().json;
return [{ json: { chat_id: P.chat_id, text: tgApiError(P.lang, r) || T(P.lang, 'failed', { code: r.error_code || r.status }) } }];
