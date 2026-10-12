// wf.channel.telegram > "Photo list": the Telegram file ids to download for the new listing. An album: the photos the
// /annonce message took from it (app.telegram_album_claim, in message order, D-086); otherwise the one photo.
const P = $('Plan').first().json;
let photos = [];
try { photos = $('Claim album').first().json.photos || []; } catch (e) { photos = []; }
if (!photos.length) photos = [{ file_id: P.photo_file_id }];        // no album, or its photos were taken already
return photos.map((x) => ({ json: { file_id: x.file_id } }));
