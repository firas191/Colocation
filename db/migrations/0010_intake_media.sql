-- migrate:up
-- Phase 4: listing drafts, presigned media uploads, processed photos, and job retries.
-- docs/DECISIONS.md D-070 to D-073.

-- 1. Settings ------------------------------------------------------------------
insert into app.settings (key, value, description) values
  ('services.media_url', '"http://media:8000"', 'Media service base URL (bootstrap overwrites from MEDIA_URL)'),
  ('services.text_url',  '"http://text:8000"',  'Text service base URL (bootstrap overwrites from TEXT_URL)'),
  ('services.asr_url',   '"http://asr:8000"',   'ASR service base URL (bootstrap overwrites from ASR_URL)'),
  ('media.max_files_per_listing', '20', 'Photos, audio, video and PDFs per listing, processed or pending'),
  ('media.upload_expires_s', '600', 'Validity of a presigned upload URL, seconds'),
  ('media.max_bytes', '{"photo": 15728640, "audio": 20971520, "video": 104857600, "pdf": 10485760}',
     'Upload size limit per kind, bytes (the proxy allows at most 100 MiB)'),
  ('media.content_types', '{"photo": ["image/jpeg", "image/png", "image/webp"], "audio": ["audio/ogg", "audio/mpeg", "audio/mp4", "audio/webm", "audio/wav"], "video": ["video/mp4", "video/quicktime", "video/webm"], "pdf": ["application/pdf"]}',
     'Accepted declared content types per kind; the Media service sniffs the real type'),
  ('media.phash_max_distance', '6', 'Hamming distance at or under which two photos count as near duplicates (spec 11.2; to tune)'),
  ('jobs.lease_s', '{"default": 900, "listing_analyze": 1800}', 'A running job past this many seconds is reclaimed (spec 5.6)'),
  ('jobs.backoff_s', '30', 'First retry delay; doubles with each attempt')
on conflict (key) do nothing;

-- 2. Jobs: retry schedule and lease (spec 5.6, D-041 deferred this to phase 4) -------
alter table app.jobs
  add column next_attempt_at timestamptz,
  add column lease_until     timestamptz,
  add column last_error      text;
create index jobs_due on app.jobs (next_attempt_at) where status = 'queued';
create index jobs_running_lease on app.jobs (lease_until) where status = 'running';

-- Claim a queued job for a worker: running, one more attempt, lease from jobs.lease_s.
create or replace function app.job_start(p_job uuid) returns app.jobs
language sql as $$
  update app.jobs j set status = 'running', attempts = j.attempts + 1, started_at = coalesce(j.started_at, now()),
         lease_until = now() + make_interval(secs => coalesce(
           (select (value->>j.type)::int from app.settings where key = 'jobs.lease_s'),
           (select (value->>'default')::int from app.settings where key = 'jobs.lease_s'), 900)),
         next_attempt_at = null
  where j.id = p_job and j.status = 'queued'
  returning j.*
$$;

-- Finish a job. A transient failure with attempts left goes back to the queue with exponential backoff.
create or replace function app.job_finish(p_job uuid, p_status text, p_output jsonb, p_error text, p_transient boolean default false)
returns app.jobs
language sql as $$
  update app.jobs j set
    status = case when p_status = 'failed' and p_transient and j.attempts < j.max_attempts then 'queued' else p_status end,
    next_attempt_at = case when p_status = 'failed' and p_transient and j.attempts < j.max_attempts
      then now() + make_interval(secs => coalesce((select value::text::int from app.settings where key = 'jobs.backoff_s'), 30)
                                         * power(2, greatest(j.attempts - 1, 0))::int) end,
    output = coalesce(p_output, j.output),
    error = case when p_status = 'failed' and not (p_transient and j.attempts < j.max_attempts) then p_error else j.error end,
    last_error = coalesce(p_error, j.last_error),
    finished_at = case when p_status in ('succeeded', 'failed', 'cancelled')
                        and not (p_status = 'failed' and p_transient and j.attempts < j.max_attempts) then now() end,
    lease_until = null
  where j.id = p_job
  returning j.*
$$;

-- Reaper (spec 5.6): running jobs past their lease. Attempts left: queued again with backoff; else failed.
create or replace function app.jobs_reap() returns table (job_id uuid, type text, new_status text)
language sql as $$
  update app.jobs j set
    status = case when j.attempts < j.max_attempts then 'queued' else 'failed' end,
    next_attempt_at = case when j.attempts < j.max_attempts
      then now() + make_interval(secs => coalesce((select value::text::int from app.settings where key = 'jobs.backoff_s'), 30)
                                         * power(2, greatest(j.attempts - 1, 0))::int) end,
    error = case when j.attempts < j.max_attempts then j.error else 'timeout: no result before the lease ended' end,
    last_error = 'lease expired at ' || to_char(j.lease_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    finished_at = case when j.attempts < j.max_attempts then null else now() end,
    lease_until = null
  where j.status = 'running' and j.lease_until is not null and j.lease_until < now()
  returning j.id, j.type, j.status
$$;

-- Queued jobs whose retry time has come (the scheduled dispatcher starts them).
create or replace function app.jobs_due(p_limit int default 5) returns setof app.jobs
language sql stable as $$
  select * from app.jobs where status = 'queued' and next_attempt_at is not null and next_attempt_at <= now()
  order by next_attempt_at limit p_limit
$$;

-- 3. Uploads -------------------------------------------------------------------
create table app.media_uploads (
  id             uuid primary key default gen_random_uuid(),
  listing_id     uuid not null references app.listings(id) on delete cascade,
  owner_id       uuid references app.users(id) on delete set null,
  kind           text not null check (kind in ('photo', 'audio', 'video', 'pdf')),
  content_type   text not null,
  declared_bytes bigint not null check (declared_bytes > 0),
  storage_key    text not null unique,
  status         text not null default 'pending' check (status in ('pending', 'processing', 'processed', 'rejected', 'expired')),
  error_code     text,
  error          text,
  media_id       uuid references app.listing_media(id) on delete set null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  processed_at   timestamptz
);
create index media_uploads_listing on app.media_uploads (listing_id, status);

-- Draft listing from text (POST /v1/listings). Extraction (P3) runs in the analyze job.
create or replace function app.listing_create(p_user uuid, p jsonb) returns jsonb
language plpgsql as $$
declare v_id uuid; v_j text := upper(p->>'jurisdiction_code');
begin
  if not exists (select 1 from app.jurisdictions where code = v_j) then
    return jsonb_build_object('ok', false, 'error_code', 'VALIDATION_FAILED', 'field', 'jurisdiction_code');
  end if;
  insert into app.listings (owner_id, jurisdiction_code, kind, source, status, title, description)
  values (p_user, v_j, coalesce(p->>'kind', 'room'), 'user', 'draft', nullif(p->>'title', ''), p->>'text')
  returning id into v_id;
  return jsonb_build_object('ok', true, 'listing_id', v_id, 'status', 'draft');
end $$;

-- Presigned upload slots (POST /v1/listings/:id/media/presign). Checks ownership, listing state, kinds,
-- declared sizes and the per-listing count; returns the object keys to sign.
create or replace function app.media_upload_create(p_user uuid, p_listing uuid, p_files jsonb) returns jsonb
language plpgsql as $$
declare
  l app.listings;
  v_max_files int := coalesce((select value::text::int from app.settings where key = 'media.max_files_per_listing'), 20);
  v_bytes jsonb := (select value from app.settings where key = 'media.max_bytes');
  v_types jsonb := (select value from app.settings where key = 'media.content_types');
  v_exp int := coalesce((select value::text::int from app.settings where key = 'media.upload_expires_s'), 600);
  v_used int; f jsonb; i int := 0; v_id uuid; v_key text; v_ext text; out jsonb := '[]'::jsonb; errs jsonb := '[]'::jsonb;
begin
  select * into l from app.listings where id = p_listing;
  if l.id is null or l.owner_id is distinct from p_user then
    return jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND');
  end if;
  if l.status not in ('draft', 'processing', 'pending_review') then
    return jsonb_build_object('ok', false, 'error_code', 'CONFLICT', 'message', 'listing is ' || l.status);
  end if;
  update app.media_uploads set status = 'expired' where listing_id = p_listing and status = 'pending' and expires_at < now();
  select count(*) into v_used from (
    select id from app.listing_media where listing_id = p_listing
    union all select id from app.media_uploads where listing_id = p_listing and status in ('pending', 'processing')) x;
  if v_used + jsonb_array_length(p_files) > v_max_files then
    return jsonb_build_object('ok', false, 'error_code', 'VALIDATION_FAILED',
      'details', jsonb_build_array(jsonb_build_object('field', 'files', 'issue', 'too_many', 'limit', v_max_files, 'used', v_used)));
  end if;
  for f in select * from jsonb_array_elements(p_files) loop
    if not (v_types ? (f->>'kind')) or not ((v_types->(f->>'kind')) ? (f->>'content_type')) then
      errs := errs || jsonb_build_object('field', format('files[%s].content_type', i), 'issue', 'not_accepted');
    elsif (f->>'bytes')::bigint > (v_bytes->>(f->>'kind'))::bigint then
      errs := errs || jsonb_build_object('field', format('files[%s].bytes', i), 'issue', 'too_large',
                                         'limit', (v_bytes->>(f->>'kind'))::bigint);
    end if;
    i := i + 1;
  end loop;
  if jsonb_array_length(errs) > 0 then
    return jsonb_build_object('ok', false, 'error_code', 'VALIDATION_FAILED', 'details', errs);
  end if;
  for f in select * from jsonb_array_elements(p_files) loop
    v_id := gen_random_uuid();
    v_ext := case f->>'content_type' when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp'
      when 'audio/ogg' then 'ogg' when 'audio/mpeg' then 'mp3' when 'audio/mp4' then 'm4a' when 'audio/webm' then 'webm'
      when 'audio/wav' then 'wav' when 'video/mp4' then 'mp4' when 'video/quicktime' then 'mov' when 'video/webm' then 'webm'
      when 'application/pdf' then 'pdf' else 'bin' end;
    v_key := format('uploads/%s/%s.%s', p_listing, v_id, v_ext);
    insert into app.media_uploads (id, listing_id, owner_id, kind, content_type, declared_bytes, storage_key, expires_at)
    values (v_id, p_listing, p_user, f->>'kind', f->>'content_type', (f->>'bytes')::bigint, v_key, now() + make_interval(secs => v_exp));
    out := out || jsonb_build_object('upload_id', v_id, 'kind', f->>'kind', 'content_type', f->>'content_type', 'key', v_key);
  end loop;
  return jsonb_build_object('ok', true, 'expires_s', v_exp, 'uploads', out);
end $$;

-- Store a processed photo (from the Media service report). EXIF GPS is never stored: only whether it was
-- present and, when the listing has an exact location, the distance to it in whole hundreds of metres (D-072).
create or replace function app.store_listing_photo(p_upload uuid, r jsonb) returns jsonb
language plpgsql as $$
declare
  u app.media_uploads; l app.listings; v_media uuid; v_phash bit(64); v_dist int := null;
  v_thr int := coalesce((select value::text::int from app.settings where key = 'media.phash_max_distance'), 6);
  v_dups jsonb; v_counts jsonb := coalesce(r#>'{blur,counts}', '{}'::jsonb); v_blurred boolean := coalesce((r#>>'{blur,applied}')::boolean, false);
begin
  select * into u from app.media_uploads where id = p_upload for update;
  if u.id is null then return jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND'); end if;
  select * into l from app.listings where id = u.listing_id;
  v_phash := ('x' || (r->>'phash'))::bit(64);
  if coalesce((r#>>'{exif,has_gps}')::boolean, false) and l.location is not null then
    v_dist := (round(st_distance(l.location,
      st_setsrid(st_makepoint((r#>>'{exif,gps,lon}')::float, (r#>>'{exif,gps,lat}')::float), 4326)::geography) / 100) * 100)::int;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('media_id', s.media_id, 'listing_id', s.listing_id, 'distance', s.distance,
                                               'same_owner', ol.owner_id is not distinct from l.owner_id)
                            order by s.distance), '[]'::jsonb)
    into v_dups
    from app.find_similar_media(v_phash, v_thr, l.id) s join app.listings ol on ol.id = s.listing_id;
  begin
    insert into app.listing_media (listing_id, kind, storage_key, mime, bytes, sha256, phash, width, height, analysis, moderation)
    values (l.id, 'photo', r#>>'{output,key}', 'image/jpeg', (r#>>'{output,bytes}')::bigint, r->>'sha256', v_phash,
            (r#>>'{output,width}')::int, (r#>>'{output,height}')::int,
            jsonb_build_object(
              'source', jsonb_build_object('mime', r->>'mime', 'width', (r->>'width')::int, 'height', (r->>'height')::int,
                                           'bytes', (r->>'bytes')::bigint),
              'exif', jsonb_build_object('captured_at', r#>>'{exif,captured_at}', 'make', r#>>'{exif,make}',
                                         'model', r#>>'{exif,model}', 'software', r#>>'{exif,software}',
                                         'has_gps', coalesce((r#>>'{exif,has_gps}')::boolean, false),
                                         'gps_distance_m', v_dist),
              'metrics', r->'metrics',
              'blur', jsonb_build_object('applied', v_blurred, 'counts', v_counts),
              'near_duplicates', v_dups),
            case when v_blurred then 'blurred' else 'ok' end)
    returning id into v_media;
  exception when unique_violation then
    update app.media_uploads set status = 'rejected', error_code = 'DUPLICATE_IN_LISTING',
           error = 'the same file is already in this listing', processed_at = now() where id = p_upload;
    return jsonb_build_object('ok', false, 'error_code', 'DUPLICATE_IN_LISTING');
  end;
  update app.media_uploads set status = 'processed', media_id = v_media, processed_at = now(), error_code = null, error = null
  where id = p_upload;
  return jsonb_build_object('ok', true, 'media_id', v_media, 'near_duplicates', v_dups, 'gps_distance_m', v_dist);
end $$;

create or replace function app.media_upload_reject(p_upload uuid, p_code text, p_message text) returns void
language sql as $$
  update app.media_uploads set status = 'rejected', error_code = p_code, error = left(p_message, 300), processed_at = now()
  where id = p_upload
$$;

-- Owner view of a listing (GET /v1/listings/:id): fields, media without GPS, upload states.
create or replace function app.listing_owner_view(p_user uuid, p_listing uuid) returns jsonb
language sql stable as $$
  select case when l.id is null or l.owner_id is distinct from p_user then null else jsonb_build_object(
    'listing_id', l.id, 'status', l.status, 'jurisdiction_code', l.jurisdiction_code, 'kind', l.kind,
    'title', l.title, 'description', l.description, 'rent_minor', l.rent_minor, 'currency', l.currency,
    'rent_period', l.rent_period, 'deposit_minor', l.deposit_minor, 'bills_included', l.bills_included,
    'available_from', l.available_from, 'bedrooms', l.bedrooms, 'furnished', l.furnished, 'amenities', l.amenities,
    'house_rules', l.house_rules, 'city', l.city, 'neighbourhood', l.neighbourhood, 'extraction', l.extraction,
    'created_at', l.created_at, 'updated_at', l.updated_at,
    'media', coalesce((select jsonb_agg(jsonb_build_object('media_id', m.id, 'kind', m.kind, 'width', m.width, 'height', m.height,
                                                          'bytes', m.bytes, 'moderation', m.moderation, 'analysis', m.analysis,
                                                          'transcript', m.transcript, 'transcript_lang', m.transcript_lang,
                                                          'created_at', m.created_at) order by m.created_at)
                       from app.listing_media m where m.listing_id = l.id), '[]'::jsonb),
    'uploads', coalesce((select jsonb_agg(jsonb_build_object('upload_id', u.id, 'kind', u.kind, 'status', u.status,
                                                            'error_code', u.error_code, 'media_id', u.media_id) order by u.created_at)
                         from app.media_uploads u where u.listing_id = l.id and u.status <> 'processed'), '[]'::jsonb))
  end
  from (select p_listing as id) k left join app.listings l on l.id = k.id
$$;

-- 4. Grants (n8n only; api_user gets nothing new; PUBLIC loses the default EXECUTE, D-013) --------
revoke execute on function app.job_start(uuid), app.job_finish(uuid, text, jsonb, text, boolean), app.jobs_reap(),
  app.jobs_due(int), app.listing_create(uuid, jsonb), app.media_upload_create(uuid, uuid, jsonb),
  app.store_listing_photo(uuid, jsonb), app.media_upload_reject(uuid, text, text), app.listing_owner_view(uuid, uuid)
  from public;
grant select, insert, update on app.media_uploads to n8n_worker;
grant execute on function app.job_start(uuid), app.job_finish(uuid, text, jsonb, text, boolean), app.jobs_reap(),
  app.jobs_due(int), app.listing_create(uuid, jsonb), app.media_upload_create(uuid, uuid, jsonb),
  app.store_listing_photo(uuid, jsonb), app.media_upload_reject(uuid, text, text), app.listing_owner_view(uuid, uuid)
  to n8n_worker;

-- migrate:down
revoke all on app.media_uploads from n8n_worker;
drop function if exists app.listing_owner_view(uuid, uuid);
drop function if exists app.media_upload_reject(uuid, text, text);
drop function if exists app.store_listing_photo(uuid, jsonb);
drop function if exists app.media_upload_create(uuid, uuid, jsonb);
drop function if exists app.listing_create(uuid, jsonb);
drop table if exists app.media_uploads;
drop function if exists app.jobs_due(int);
drop function if exists app.jobs_reap();
drop function if exists app.job_finish(uuid, text, jsonb, text, boolean);
drop function if exists app.job_start(uuid);
drop index if exists app.jobs_due;
drop index if exists app.jobs_running_lease;
alter table app.jobs drop column if exists next_attempt_at, drop column if exists lease_until, drop column if exists last_error;
delete from app.settings where key in ('services.media_url', 'services.text_url', 'services.asr_url', 'media.max_files_per_listing',
  'media.upload_expires_s', 'media.max_bytes', 'media.content_types', 'media.phash_max_distance', 'jobs.lease_s', 'jobs.backoff_s');
