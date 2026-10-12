// wf.channel.telegram > "Album sent?": nothing more to say when the relay sent the album; otherwise say it failed.
/* @include lib/tg_texts.js */
const P = $('Plan').first().json;
const r = $input.first().json;
if (r.statusCode === 200 && r.body && r.body.ok) return [];
return [{ json: { chat_id: P.chat_id, text: T(P.lang, 'photos_failed') } }];
