-- Migration 0034: POST /v2/listings/{id}/submit turns the trust check into one listing_trust job per listing (D-112).
\ir helpers.psql
begin;
select plan(7);

insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, timezone)
values ('ZJ', 'ZJ', 'pgTAP submit job', 'TND', 'fr', 'UTC');
insert into app.users (id, email, display_name, role, jurisdiction_code) values
  ('00000000-0000-0000-0000-000000000ba1', 'o-p12@example.test', 'Olfa', 'user', 'ZJ'),
  ('00000000-0000-0000-0000-000000000ba2', 'x-p12@example.test', 'Xena', 'user', 'ZJ');
\set O '''00000000-0000-0000-0000-000000000ba1'''
\set X '''00000000-0000-0000-0000-000000000ba2'''
\set L '''00000000-0000-0000-0000-000000000bb1'''
insert into app.listings (id, owner_id, jurisdiction_code, status, kind, title, description, rent_minor, currency, rent_period, city, location)
values (:L, :O, 'ZJ', 'draft', 'room', 'Chambre ZJ', 'Chambre calme.', 400000, 'TND', 'month', 'Ville ZJ',
        st_setsrid(st_makepoint(10.1, 36.8), 4326)::geography);
insert into app.listing_media (listing_id, kind, storage_key, mime, bytes, sha256, phash, moderation)
values (:L, 'photo', 'media/listings/zj/1.jpg', 'image/jpeg', 1000, repeat('ab', 32), repeat('01', 32)::bit(64), 'ok');
update app.settings set value = 'true' where key = 'trust.enabled';
update app.settings set value = 'false' where key = 'listing.auto_publish';

create temp table a as select app.listing_submit_job(:O, :L, null) as r;
select is((select r->>'status' from a), '202', 'the trust check becomes a job');
select is((select type || ':' || status || ':' || (input->>'listing_id') from app.jobs where id = (select (r->>'job_id')::uuid from a)),
          'listing_trust:queued:00000000-0000-0000-0000-000000000bb1', 'a queued listing_trust job for the listing');
select is((select app.listing_submit_job(:O, :L, null)->>'job_id'), (select r->>'job_id' from a), 'asking again follows the same job');
select is((select app.listing_submit_job(:O, :L, null)->>'created'), 'false', 'and creates none');
select is((select app.listing_submit_job(:X, :L, null)->>'status'), '404', 'another owner: 404, no job');
select is((select status from app.listings where id = :L), 'draft', 'the listing stays a draft while it is checked');
update app.settings set value = 'false' where key = 'trust.enabled';
update app.jobs set status = 'succeeded' where id = (select (r->>'job_id')::uuid from a);
select is((select app.listing_submit_job(:O, :L, null)->>'status'), '200', 'trust check off: published as in v1');

select * from finish();
rollback;
