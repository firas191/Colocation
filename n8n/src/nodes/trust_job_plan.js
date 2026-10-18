// wf.listing.trust > "Plan" (platform P12, D-112): the job app.job_start claimed, or nothing when another run
// already has it (the job is then not queued any more and the row is empty).
const row = $input.first().json || {};
if (!row.job_id) return [{ json: { none: true } }];
const input = row.input || {};
return [{ json: { none: false, job_id: row.job_id, attempts: row.attempts, max_attempts: row.max_attempts,
  listing_id: input.listing_id, user_id: input.user_id, request_id: row.job_id } }];
