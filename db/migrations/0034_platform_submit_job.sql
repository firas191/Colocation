-- migrate:up
-- Platform P12 (D-112): the trust check of a submitted listing runs as a job. On the PC the Trust agent takes longer
-- than a request can wait (T-77: POST /v1/listings/{id}/submit timed out after 30 s in the contract tests and the
-- website's publish button gave up), and PLATFORM_SPEC 6.6 says the trust check is a 202 job the page polls.
-- POST /v2/listings/{id}/submit uses this function; /v1 keeps its synchronous answer.

-- The same checks as app.listing_submit. When the trust check is needed, a listing_trust job is created, or the one
-- already queued or running for this listing is returned, so a second click follows the same check. max_attempts 2:
-- wf.jobs.dispatch retries a check that failed (a dropped model call) once, after the backoff.
create or replace function app.listing_submit_job(p_user uuid, p_listing uuid, p_request uuid) returns jsonb
language plpgsql as $$
declare r jsonb; j app.jobs;
begin
  r := app.listing_submit(p_user, p_listing);
  if (r->>'status')::int is distinct from 100 then return r; end if;
  perform pg_advisory_xact_lock(hashtext('listing_trust:' || p_listing::text));
  select * into j from app.jobs
   where type = 'listing_trust' and status in ('queued', 'running') and input->>'listing_id' = p_listing::text
   order by created_at desc limit 1;
  if j.id is not null then
    return jsonb_build_object('status', 202, 'created', false, 'job_id', j.id, 'job_status', j.status);
  end if;
  insert into app.jobs (type, status, input, requested_by, max_attempts)
  values ('listing_trust', 'queued',
          jsonb_build_object('listing_id', p_listing, 'user_id', p_user, 'request_id', p_request), p_user, 2)
  returning * into j;
  return jsonb_build_object('status', 202, 'created', true, 'job_id', j.id, 'job_status', j.status);
end $$;
revoke execute on function app.listing_submit_job(uuid, uuid, uuid) from public;
grant execute on function app.listing_submit_job(uuid, uuid, uuid) to n8n_worker;

-- migrate:down
drop function if exists app.listing_submit_job(uuid, uuid, uuid);
