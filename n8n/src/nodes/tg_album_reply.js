// wf.channel.telegram > "Album reply": a photo of an album sent without /annonce, a few seconds after it arrived
// (D-086). Taken by a listing: nothing to say. Arrived after the listing took its album: say it was not added. No
// message of the album had /annonce: explain how to post a listing, once (from the album's first photo).
/* @include lib/tg_texts.js */
const P = $('Plan').first().json;
const s = $input.first().json.s || {};
if (s.taken) return [];
if (s.album_has_listing) return [{ json: { chat_id: P.chat_id, text: T(P.lang, 'album_late') } }];
if (!s.album_has_command && s.first) return [{ json: { chat_id: P.chat_id, text: T(P.lang, 'photo_hint') } }];
return [];
