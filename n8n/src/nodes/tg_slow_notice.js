// wf.channel.telegram > "Slow notice": the analysis is still running after telegram.job_wait_s; the result follows.
/* @include lib/tg_texts.js */
const P = $('Plan').first().json;
const id = $('API: create listing').first().json.body.data.listing_id;
return [{ json: { chat_id: P.chat_id, text: T(P.lang, 'listing_slow', { id }) } }];
