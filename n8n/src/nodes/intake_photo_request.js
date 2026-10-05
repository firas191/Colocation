// wf.intake.photos > "Request": one uploaded photo -> Media service (validate, EXIF, hashes, blur).
// The cleaned copy goes to media/<listing>/<upload>.jpg; the raw upload is deleted by the caller afterwards.
const x = $input.first().json;
return [{ json: { ...x, url: `${String(x.media_url).replace(/\/+$/, '')}/v1/images/process`,
  body: { source_key: x.key, output_key: `media/${x.listing_id}/${x.upload_id}.jpg`, blur: true } } }];
