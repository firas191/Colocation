// wf.channel.telegram > "Album request": all the photos of a listing (the button under a search result, D-086), sent by
// the Telegram relay as one album: n8n's Telegram node cannot upload several files in one message.
/* @include lib/tg_texts.js */
const P = $('Plan').first().json;
const row = $input.first().json;
const photos = row.photos || [];
if (!photos.length) return [{ json: { send: false, chat_id: P.chat_id, text: T(P.lang, 'no_photos') } }];
return [{ json: { send: true, chat_id: P.chat_id, url: `${String(row.relay_url || '').replace(/\/+$/, '')}/v1/send-album`,
  body: JSON.stringify({ chat_id: Number(P.chat_id), keys: photos.map((x) => x.key), caption: String(row.title || '').slice(0, 200) }) } }];
