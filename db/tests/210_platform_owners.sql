-- Migration 0024: what a draft needs before publication, submit, the owner's listings, and a new analysis that
-- keeps the owner's corrections (D-077, D-102).
\ir helpers.psql
begin;
select plan(34);
-- P3 behaviour: submit publishes directly. From P8 the trust check runs first (260_platform_trust.sql, D-107).
update app.settings set value = 'false' where key = 'trust.enabled';

insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, timezone)
values ('ZO', 'ZO', 'pgTAP owners', 'TND', 'fr', 'UTC');
insert into app.places (jurisdiction_code, kind, name, place_key, city, location, source)
values ('ZO', 'neighbourhood', 'Quartier Olive', 'zo-olive', 'Oliveville', st_setsrid(st_makepoint(10.2, 36.2), 4326)::geography, 'test');
insert into app.place_names (place_id, name) select id, 'Quartier Olive' from app.places where place_key = 'zo-olive';
insert into app.users (id, email, display_name, role, jurisdiction_code) values
  ('00000000-0000-0000-0000-0000000001a1', 'owner-p3@example.test', 'Owner', 'user', 'ZO'),
  ('00000000-0000-0000-0000-0000000001a2', 'other-p3@example.test', 'Other', 'user', 'ZO');
-- d1: a draft with no rent, a place and a photo; d2: a complete draft; pub: published; arc: archived; rej: rejected
insert into app.listings (id, owner_id, jurisdiction_code, status, title, description, rent_minor, currency, city, neighbourhood,
                          extraction, published_at, created_at) values
  ('00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000001a1', 'ZO', 'draft', null, E'Chambre lumineuse\nprès du parc',
   null, null, 'Oliveville', 'Quartier Olive', '{"issues": ["rent_missing", "contact_details_in_text"]}', null, now() - interval '1 minute'),
  ('00000000-0000-0000-0000-0000000001b2', '00000000-0000-0000-0000-0000000001a1', 'ZO', 'draft', null, 'Studio complet', 420000, 'TND',
   null, 'Quartier Olive', '{"issues": ["rent_scope_whole_flat"]}', null, now() - interval '2 minutes'),
  ('00000000-0000-0000-0000-0000000001b3', '00000000-0000-0000-0000-0000000001a1', 'ZO', 'published', 'Publiée', 'x', 300000, 'TND',
   'Oliveville', null, '{}', now() - interval '1 day', now() - interval '3 minutes'),
  ('00000000-0000-0000-0000-0000000001b4', '00000000-0000-0000-0000-0000000001a1', 'ZO', 'archived', 'Archivée', 'x', 300000, 'TND',
   'Oliveville', null, '{}', now() - interval '2 days', now() - interval '4 minutes'),
  ('00000000-0000-0000-0000-0000000001b5', '00000000-0000-0000-0000-0000000001a1', 'ZO', 'rejected', 'Refusée', 'x', null, null,
   null, null, '{}', null, now() - interval '5 minutes'),
  ('00000000-0000-0000-0000-0000000001b9', '00000000-0000-0000-0000-0000000001a2', 'ZO', 'draft', null, 'Autre', 400000, 'TND',
   null, 'Quartier Olive', '{}', null, now());
insert into app.listing_media (listing_id, kind, storage_key, mime, bytes, sha256, moderation) values
  ('00000000-0000-0000-0000-0000000001b1', 'photo', 'media/b1/1.jpg', 'image/jpeg', 1, 'p31', 'ok'),
  ('00000000-0000-0000-0000-0000000001b2', 'photo', 'media/b2/1.jpg', 'image/jpeg', 1, 'p32', 'blurred'),
  ('00000000-0000-0000-0000-0000000001b2', 'photo', 'media/b2/2.jpg', 'image/jpeg', 1, 'p33', 'rejected'),
  ('00000000-0000-0000-0000-0000000001b9', 'photo', 'media/b9/1.jpg', 'image/jpeg', 1, 'p39', 'ok');

-- 1. Readiness -------------------------------------------------------------------------------------------------------
select is(app.listing_readiness('00000000-0000-0000-0000-0000000001b1')->'missing', '[{"field": "rent", "issue": "required"}]',
          'd1: only the rent is missing (the place is found, one photo)');
select is(app.listing_readiness('00000000-0000-0000-0000-0000000001b1')->'issues', '["rent_missing", "contact_details_in_text"]',
          'd1: the analysis issues still apply');
select is(app.listing_readiness('00000000-0000-0000-0000-0000000001b2')->>'ready', 'true', 'd2 is ready (a rejected photo does not count, the other does)');
select is(app.listing_readiness('00000000-0000-0000-0000-0000000001b5')->'missing',
          '[{"field": "rent", "issue": "required"}, {"field": "place", "issue": "required"}, {"field": "photos", "issue": "required"}]',
          'nothing at all: rent, place and photos');
update app.listings set city = 'Nulle part' where id = '00000000-0000-0000-0000-0000000001b5';
select is(app.listing_readiness('00000000-0000-0000-0000-0000000001b5')->'missing'->1, '{"field": "place", "issue": "place_not_found"}',
          'a place that is not on the map');

-- 2. Submit ------------------------------------------------------------------------------------------------------------
select is(pg_temp.as_user('n8n_worker', '', 'select app.listing_submit(''00000000-0000-0000-0000-0000000001a2'', ''00000000-0000-0000-0000-0000000001b2'')->>''status'''),
          '404', 'another owner''s listing: 404');
select is(pg_temp.as_user('n8n_worker', '', 'select app.listing_submit(''00000000-0000-0000-0000-0000000001a1'', ''00000000-0000-0000-0000-0000000001b9'')->>''status'''),
          '404', 'nor the other way round');
select is(app.listing_submit('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000001b1')->>'status', '422', 'd1 has no rent: 422');
select is(app.listing_submit('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000001b1')#>'{error,details}',
          '[{"field": "rent", "issue": "required"}]', 'with the missing field');
select is(app.listing_submit('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000001b4')#>'{error,details,0}',
          '{"field": "status", "issue": "status_not_allowed", "current": "archived"}', 'archived: 409 (PATCH status publishes it again)');
insert into app.jobs (type, status, input) values ('listing_analyze', 'running', '{"listing_id": "00000000-0000-0000-0000-0000000001b2"}');
select is(app.listing_submit('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000001b2')#>>'{error,details,0,issue}',
          'running', 'an analysis still running: 409');
update app.jobs set status = 'succeeded', finished_at = now() where input->>'listing_id' = '00000000-0000-0000-0000-0000000001b2';
create temp table t_s as select app.listing_submit('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000001b2') as r;
select is((select r->>'status' from t_s), '200', 'd2 is published');
select is((select r#>>'{data,status}' from t_s), 'published', 'status published');
select is((select r#>>'{data,title}' from t_s), 'Studio complet', 'title from the first line of the text');
select is((select r#>>'{data,place}' from t_s), 'Quartier Olive', 'the place found on the map');
select is((select r#>>'{data,checked}' from t_s), 'false', 'not trust-checked yet (P8)');
select isnt((select r->>'embed_text' from t_s), null, 'the workflow gets the text to embed');
select ok((select location is not null and public_location is not null and published_at is not null from app.listings
            where id = '00000000-0000-0000-0000-0000000001b2'), 'exact and public points set, published_at set');
select is((select count(*)::int from notify.notifications where user_id = '00000000-0000-0000-0000-0000000001a1' and type = 'listing_published'),
          1, 'the owner is notified');
select is(app.listing_submit('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000001b2')->'data',
          (select r->'data' from t_s), 'submitting again: the same answer');
select is((select count(*)::int from app.audit_log where action = 'listing_submitted' and entity_id = '00000000-0000-0000-0000-0000000001b2'),
          1, 'one audit row: the second submit changed nothing');

-- 3. The owner's listings -------------------------------------------------------------------------------------------
create temp table t_m as select app.me_listings('00000000-0000-0000-0000-0000000001a1', '{}') as r;
select is((select jsonb_array_length(r#>'{data,items}') from t_m), 5, 'five listings, not the other owner''s');
select is((select jsonb_path_query_array(r, '$.data.items[*].number') from t_m), '[1, 2, 3, 4, null]',
          'numbered as the owner assistant numbers them (rejected left out)');
select is((select r#>'{data,counts}' from t_m), '{"all": 5, "draft": 1, "archived": 1, "published": 2}', 'counts by status');
select is((select r#>'{data,items,0,actions}' from t_m),
          '{"edit": true, "view": false, "submit": false, "analyze": true, "archive": true, "republish": false}', 'd1: edit, not submit');
select is((select r#>'{data,items,3,actions,republish}' from t_m), 'true', 'archived and published before: republish');
select is((select r#>>'{data,items,0,display_title}' from t_m), 'Chambre lumineuse', 'display title: the first line');
select is((select r#>>'{data,items,0,cover_key}' from t_m), 'media/b1/1.jpg', 'cover key for the workflow');
create temp table t_p as select app.me_listings('00000000-0000-0000-0000-0000000001a1', '{"query": {"limit": 2}}') as r;
select is((select jsonb_array_length(r#>'{data,items}') from t_p), 2, 'first page of two');
select is((select jsonb_path_query_array(r, '$.data.items[*].listing_id') from (select app.me_listings('00000000-0000-0000-0000-0000000001a1',
             jsonb_build_object('query', jsonb_build_object('limit', 2, 'cursor', (select r#>>'{meta,next_cursor}' from t_p)))) as r) x),
          '["00000000-0000-0000-0000-0000000001b3", "00000000-0000-0000-0000-0000000001b4"]', 'the cursor gives the next two');
select is((select r#>>'{data,items,0,status}' from (select app.me_listings('00000000-0000-0000-0000-0000000001a1', '{"query": {"status": "archived"}}') as r) x),
          'archived', 'filter by status');

-- 4. A new analysis keeps the owner's corrections (D-077) -------------------------------------------------------------
select app.listing_apply_changes('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000001b1', '{"rent": 380, "furnished": true}');
select app.store_listing_extraction('00000000-0000-0000-0000-0000000001b1', '{"fields": {"rent_minor": 999000, "currency": "TND",
  "rent_scope": "whole_flat", "furnished": false, "bedrooms": 2, "city": "Ailleurs", "amenities": ["wifi"]},
  "extraction": {"issues": ["rent_scope_whole_flat"]}}');
select is((select jsonb_build_object('rent', rent_minor, 'furnished', furnished, 'bedrooms', bedrooms, 'city', city, 'amenities', amenities)
             from app.listings where id = '00000000-0000-0000-0000-0000000001b1'),
          '{"city": "Ailleurs", "rent": 380000, "bedrooms": 2, "amenities": ["wifi"], "furnished": true}',
          'rent and furnished stay as the owner set them; the other fields come from the new analysis');
select is((select jsonb_array_length(extraction->'owner_changes') from app.listings where id = '00000000-0000-0000-0000-0000000001b1'), 1,
          'the owner''s change history is kept');
select is(app.listing_readiness('00000000-0000-0000-0000-0000000001b1')->'issues', '[]',
          'the rent scope issue no longer applies: the owner set the rent');

select * from finish();
rollback;
