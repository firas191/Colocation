// wf.listing.analyze > "Plan": one item per waiting file. Photos go to wf.intake.photos; other kinds
// are left pending until their intake workflows exist (voice, video and PDF later in phase 4).
const s = $input.first().json;
if (!s.job_id) return [];                                   // job not queued any more (already running or done)
const photos = (s.uploads || []).filter((u) => u.kind === 'photo');
if (!photos.length) return [{ json: { none: true } }];
return photos.map((u) => ({ json: { job_id: s.job_id, listing_id: s.input.listing_id, upload_id: u.upload_id, key: u.key,
  media_url: s.media_url } }));
