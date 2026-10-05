// wf.channel.telegram > "Wait notice": tell the owner the analysis is running.
/* @include lib/tg_texts.js */
const P = $('Plan').first().json;
return [{ json: { chat_id: P.chat_id, text: T(P.lang, 'listing_wait') } }];
