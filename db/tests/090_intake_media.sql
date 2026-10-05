-- Phase 4 (migration 0010): listing drafts, presigned upload slots, processed photos, job retries.
\ir helpers.psql
begin;
select plan(37);

insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, timezone)
values ('ZM', 'ZM', 'pgTAP media', 'TND', 'fr', 'UTC');
insert into app.users (id, email, display_name, role) values
  ('00000000-0000-0000-0000-0000000000e1', 'owner-m@example.test', 'Owner', 'owner'),
  ('00000000-0000-0000-0000-0000000000e2', 'other-m@example.test', 'Other', 'owner');

-- ---------------------------------------------------------------- drafts
select is(app.listing_create('00000000-0000-0000-0000-0000000000e1', '{"jurisdiction_code":"XX","text":"room"}')->>'error_code',
  'VALIDATION_FAILED', 'unknown jurisdiction: refused');
create temp table t_l as select (app.listing_create('00000000-0000-0000-0000-0000000000e1',
  '{"jurisdiction_code":"zm","text":"Chambre meublée, 450 DT","title":"Chambre"}')->>'listing_id')::uuid as id;
select is((select status || ' ' || jurisdiction_code || ' ' || source from app.listings where id = (select id from t_l)),
  'draft ZM user', 'draft created for the owner, jurisdiction code upper-cased');
update app.listings set location = st_setsrid(st_makepoint(10.18, 36.80), 4326)::geography where id = (select id from t_l);

-- ---------------------------------------------------------------- upload slots
select is(app.media_upload_create('00000000-0000-0000-0000-0000000000e2', (select id from t_l),
  '[{"kind":"photo","content_type":"image/jpeg","bytes":1000}]')->>'error_code', 'NOT_FOUND', 'another user cannot add media');
select is(app.media_upload_create('00000000-0000-0000-0000-0000000000e1', gen_random_uuid(),
  '[{"kind":"photo","content_type":"image/jpeg","bytes":1000}]')->>'error_code', 'NOT_FOUND', 'unknown listing');
select is(app.media_upload_create('00000000-0000-0000-0000-0000000000e1', (select id from t_l),
  '[{"kind":"photo","content_type":"image/gif","bytes":1000},{"kind":"photo","content_type":"image/jpeg","bytes":99999999}]')
  #>> '{details}', '[{"field": "files[0].content_type", "issue": "not_accepted"}, {"field": "files[1].bytes", "issue": "too_large", "limit": 15728640}]',
  'GIF refused, oversized declared size refused; each error names its file');
select is(app.media_upload_create('00000000-0000-0000-0000-0000000000e1', (select id from t_l),
  '[{"kind":"exe","content_type":"application/x-msdownload","bytes":10}]')->>'error_code', 'VALIDATION_FAILED', 'unknown kind refused');
create temp table t_up as select x as u from jsonb_array_elements(app.media_upload_create('00000000-0000-0000-0000-0000000000e1',
  (select id from t_l), '[{"kind":"photo","content_type":"image/jpeg","bytes":200000},
                          {"kind":"photo","content_type":"image/png","bytes":300000},
                          {"kind":"audio","content_type":"audio/ogg","bytes":50000}]')->'uploads') x;
select is((select count(*)::int from t_up), 3, 'three upload slots');
select ok((select bool_and(u->>'key' ~ ('^uploads/' || (select id from t_l) || '/[0-9a-f-]{36}\.(jpg|png|ogg)$')) from t_up),
  'keys are uploads/<listing>/<upload id>.<ext>, extension from the declared type');
update app.settings set value = '4' where key = 'media.max_files_per_listing';
select is(app.media_upload_create('00000000-0000-0000-0000-0000000000e1', (select id from t_l),
  '[{"kind":"photo","content_type":"image/jpeg","bytes":1},{"kind":"photo","content_type":"image/jpeg","bytes":1}]')
  #>> '{details,0,issue}', 'too_many', 'per-listing limit counts pending uploads');
update app.media_uploads set expires_at = now() - interval '1 minute'
  where id = ((select u->>'upload_id' from t_up where u->>'kind' = 'audio'))::uuid;
select is(app.media_upload_create('00000000-0000-0000-0000-0000000000e1', (select id from t_l),
  '[{"kind":"photo","content_type":"image/jpeg","bytes":1},{"kind":"photo","content_type":"image/jpeg","bytes":1}]')->>'ok',
  'true', 'an expired pending upload no longer counts');
select is((select status from app.media_uploads where id = ((select u->>'upload_id' from t_up where u->>'kind' = 'audio'))::uuid),
  'expired', 'and is marked expired');
update app.settings set value = '20' where key = 'media.max_files_per_listing';

-- ---------------------------------------------------------------- processed photo
create temp table t_rep as select jsonb_build_object(
  'mime', 'image/jpeg', 'width', 4000, 'height', 3000, 'bytes', 2100000,
  'sha256', repeat('a', 64), 'phash', 'f0f0f0f0f0f0f0f0',
  'exif', jsonb_build_object('captured_at', '2026-09-30T18:45:10', 'make', 'Maker', 'model', 'M1', 'software', null,
                             'has_gps', true, 'gps', jsonb_build_object('lat', 36.8045, 'lon', 10.1800)),
  'metrics', jsonb_build_object('sharpness', 120.5, 'brightness_mean', 130),
  'blur', jsonb_build_object('applied', true, 'counts', jsonb_build_object('face', 1, 'text', 0, 'screen', 0)),
  'output', jsonb_build_object('key', 'media/x/1.jpg', 'bytes', 400000, 'width', 2560, 'height', 1920)) as r;
create temp table t_s1 as select app.store_listing_photo(((select u->>'upload_id' from t_up where u->>'content_type' = 'image/jpeg'))::uuid,
  (select r from t_rep)) as res;
select is((select res->>'ok' from t_s1), 'true', 'photo stored');
select is((select (res->>'gps_distance_m')::int from t_s1), 500, 'GPS 0.0045 deg north of the listing: about 500 m, rounded to 100 m');
select is((select m.analysis #>> '{exif,gps}' from app.listing_media m where m.id = ((select res->>'media_id' from t_s1))::uuid), null,
  'GPS coordinates are not stored');
select is((select m.analysis #>> '{exif,has_gps}' from app.listing_media m where m.id = ((select res->>'media_id' from t_s1))::uuid), 'true',
  'only whether GPS was present');
select is((select moderation || ' ' || phash::text from app.listing_media m where m.id = ((select res->>'media_id' from t_s1))::uuid),
  'blurred 1111000011110000111100001111000011110000111100001111000011110000', 'moderation blurred; pHash stored as 64 bits');
select is((select status || ' ' || (media_id is not null)::text from app.media_uploads
           where id = ((select u->>'upload_id' from t_up where u->>'content_type' = 'image/jpeg'))::uuid), 'processed true',
  'upload marked processed and linked');
select is(app.store_listing_photo(((select u->>'upload_id' from t_up where u->>'content_type' = 'image/png'))::uuid,
  (select r || '{"output":{"key":"media/x/2.jpg","bytes":1,"width":1,"height":1}}' from t_rep))->>'error_code',
  'DUPLICATE_IN_LISTING', 'same file twice in one listing: rejected');
select is((select error_code from app.media_uploads where id = ((select u->>'upload_id' from t_up where u->>'content_type' = 'image/png'))::uuid),
  'DUPLICATE_IN_LISTING', 'and the upload records why');

-- near duplicate in another owner's listing
insert into app.listings (id, owner_id, jurisdiction_code, status, title)
values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000e2', 'ZM', 'draft', 'other');
insert into app.media_uploads (id, listing_id, owner_id, kind, content_type, declared_bytes, storage_key, expires_at)
values ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000e2',
        'photo', 'image/jpeg', 10, 'uploads/f2/f3.jpg', now() + interval '10 minutes');
create temp table t_s2 as select app.store_listing_photo('00000000-0000-0000-0000-0000000000f3',
  (select r || jsonb_build_object('sha256', repeat('b', 64), 'phash', 'f0f0f0f0f0f0f0f3',
                                  'exif', '{"has_gps": false}'::jsonb, 'blur', '{"applied": false, "counts": {}}'::jsonb,
                                  'output', '{"key":"media/f2/1.jpg","bytes":5,"width":5,"height":5}'::jsonb) from t_rep)) as res;
select is((select res #>> '{near_duplicates,0,distance}' from t_s2), '2', 'near duplicate found at Hamming distance 2');
select is((select res #>> '{near_duplicates,0,same_owner}' from t_s2), 'false', 'flagged as another owner''s photo');
select is((select m.moderation from app.listing_media m where m.id = ((select res->>'media_id' from t_s2))::uuid), 'ok',
  'nothing blurred: moderation ok');
select is((select res->>'gps_distance_m' from t_s2), null, 'no GPS: no distance');

-- ---------------------------------------------------------------- owner view
select is(app.listing_owner_view('00000000-0000-0000-0000-0000000000e2', (select id from t_l)), null, 'not the owner: nothing');
select is(jsonb_array_length(app.listing_owner_view('00000000-0000-0000-0000-0000000000e1', (select id from t_l))->'media'), 1,
  'owner sees the stored photo');
select ok(app.listing_owner_view('00000000-0000-0000-0000-0000000000e1', (select id from t_l))::text !~ '36\.80',
  'owner view contains no GPS coordinate');

-- ---------------------------------------------------------------- jobs: start, retry with backoff, reaper
insert into app.jobs (id, type, input) values ('00000000-0000-0000-0000-0000000000a1', 'listing_analyze', '{}');
select is((select status || ' ' || attempts from app.job_start('00000000-0000-0000-0000-0000000000a1')), 'running 1', 'job started');
select ok((select lease_until between now() + interval '1790 seconds' and now() + interval '1810 seconds' from app.jobs
           where id = '00000000-0000-0000-0000-0000000000a1'), 'lease from jobs.lease_s for this type (1800 s)');
select is((select status from app.job_start('00000000-0000-0000-0000-0000000000a1')), null, 'a running job cannot be started twice');
select is((select status || ' ' || (next_attempt_at between now() + interval '29 seconds' and now() + interval '31 seconds')::text
           from app.job_finish('00000000-0000-0000-0000-0000000000a1', 'failed', null, 'media service down', true)),
  'queued true', 'transient failure: queued again, first retry after 30 s');
update app.jobs set next_attempt_at = now() - interval '1 second' where id = '00000000-0000-0000-0000-0000000000a1';
select is((select count(*)::int from app.jobs_due(10) where id = '00000000-0000-0000-0000-0000000000a1'), 1, 'due for retry');
select is((select attempts from app.job_start('00000000-0000-0000-0000-0000000000a1')), 2::smallint, 'second attempt');
select is((select (next_attempt_at between now() + interval '59 seconds' and now() + interval '61 seconds')::text
           from app.job_finish('00000000-0000-0000-0000-0000000000a1', 'failed', null, 'down again', true)),
  'true', 'second retry after 60 s (backoff doubles)');
update app.jobs set next_attempt_at = now() - interval '1 second' where id = '00000000-0000-0000-0000-0000000000a1';
select app.job_start('00000000-0000-0000-0000-0000000000a1');
update app.jobs set lease_until = now() - interval '1 second' where id = '00000000-0000-0000-0000-0000000000a1';
select is((select new_status from app.jobs_reap() where job_id = '00000000-0000-0000-0000-0000000000a1'), 'failed',
  'reaper: lease expired on the last attempt, job failed');
select is((select error from app.jobs where id = '00000000-0000-0000-0000-0000000000a1'), 'timeout: no result before the lease ended',
  'with the reason');
insert into app.jobs (id, type, input) values ('00000000-0000-0000-0000-0000000000a2', 'other', '{}');
select app.job_start('00000000-0000-0000-0000-0000000000a2');
select is((select status || ' ' || coalesce(error, '-') from app.job_finish('00000000-0000-0000-0000-0000000000a2', 'failed', null, 'bad input', false)),
  'failed bad input', 'non-transient failure: fails at once');

-- ---------------------------------------------------------------- privileges
select is(pg_temp.as_user('api_user', '00000000-0000-0000-0000-0000000000e1', 'select count(*) from app.media_uploads'),
  'ERROR 42501', 'api_user cannot read upload slots');

select * from finish();
rollback;
