-- Migration 0023: favourites behind the row-level layer, search v2, the public listing view, cancelling a proposal.
\ir helpers.psql
begin;
select plan(22);

insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, timezone)
values ('ZQ', 'ZQ', 'pgTAP platform P2', 'TND', 'fr', 'UTC');
insert into app.users (id, email, display_name, role, jurisdiction_code) values
  ('00000000-0000-0000-0000-0000000000f1', 'amel2@example.test', 'Amel', 'user', 'ZQ'),
  ('00000000-0000-0000-0000-0000000000f2', 'bilel2@example.test', 'Bilel', 'user', 'ZQ');
insert into app.listings (id, owner_id, jurisdiction_code, status, title, description, rent_minor, currency, furnished, kind,
                          amenities, house_rules, location, published_at) values
  ('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-0000000000f2', 'ZQ', 'published', 'Chambre wifi', 'wifi',
   400000, 'TND', true, 'room', '{wifi,desk}', '{"smoking": "no"}', st_setsrid(st_makepoint(10.0, 36.0), 4326)::geography, now()),
  ('00000000-0000-0000-0000-00000000fa02', '00000000-0000-0000-0000-0000000000f2', 'ZQ', 'published', 'Coloc jardin', 'jardin',
   700000, 'TND', false, 'shared_flat', '{parking}', '{}', st_setsrid(st_makepoint(10.3, 36.3), 4326)::geography, now() - interval '1 day'),
  ('00000000-0000-0000-0000-00000000fa03', '00000000-0000-0000-0000-0000000000f2', 'ZQ', 'draft', 'Brouillon', 'x',
   100000, 'TND', true, 'room', '{wifi}', '{}', st_setsrid(st_makepoint(10.0, 36.0), 4326)::geography, null);

-- 1. Favourites: n8n_worker never reaches the table; through the functions each user sees only their own rows.
select is(pg_temp.as_user('n8n_worker', '', 'select count(*) from social.favourites'), 'ERROR 42501',
          'n8n_worker: no privilege on social.favourites');
select is(pg_temp.as_user('n8n_worker', '', 'select api.favourite_put(''00000000-0000-0000-0000-0000000000f1'', ''{"params": {"listing_id": "00000000-0000-0000-0000-00000000fa01"}}'')#>>''{data,favourite}'''),
          'true', 'Amel saves a published listing');
select is(pg_temp.as_user('n8n_worker', '', 'select api.favourite_put(''00000000-0000-0000-0000-0000000000f1'', ''{"params": {"listing_id": "00000000-0000-0000-0000-00000000fa01"}}'')#>>''{status}'''),
          '200', 'saving again is fine');
select is(pg_temp.as_user('n8n_worker', '', 'select api.favourite_put(''00000000-0000-0000-0000-0000000000f1'', ''{"params": {"listing_id": "00000000-0000-0000-0000-00000000fa03"}}'')#>>''{status}'''),
          '404', 'someone else''s draft cannot be saved');
select is(pg_temp.as_user('n8n_worker', '', 'select api.favourite_put(''00000000-0000-0000-0000-0000000000f2'', ''{"params": {"listing_id": "00000000-0000-0000-0000-00000000fa03"}}'')#>>''{status}'''),
          '404', 'not even one''s own draft (only published listings)');
select is(pg_temp.as_user('n8n_worker', '', 'select api.favourite_put(''00000000-0000-0000-0000-0000000000f2'', ''{"params": {"listing_id": "00000000-0000-0000-0000-00000000fa02"}}'')#>>''{status}'''),
          '200', 'Bilel saves another one');
select is((select count(*)::int from social.favourites), 2, 'two rows in all');
select is(pg_temp.as_user('n8n_worker', '', 'select api.favourites_list(''00000000-0000-0000-0000-0000000000f1'', ''{}'')#>>''{data,total}'''),
          '1', 'Amel lists only hers');
select is(pg_temp.as_user('n8n_worker', '', 'select api.favourites_list(''00000000-0000-0000-0000-0000000000f1'', ''{}'')#>>''{data,items,0,listing_id}'''),
          '00000000-0000-0000-0000-00000000fa01', 'the right one');
select is(pg_temp.as_user('n8n_worker', '', 'select api.favourite_flags(''00000000-0000-0000-0000-0000000000f1'', ''["00000000-0000-0000-0000-00000000fa01", "00000000-0000-0000-0000-00000000fa02"]'')::text'),
          '["00000000-0000-0000-0000-00000000fa01"]', 'flags: only her own favourites among the ids');
select is(pg_temp.as_user('n8n_worker', '', 'select api.favourite_delete(''00000000-0000-0000-0000-0000000000f1'', ''{"params": {"listing_id": "00000000-0000-0000-0000-00000000fa02"}}'')#>>''{data,removed}'''),
          'false', 'Amel cannot remove Bilel''s favourite');
select is((select count(*)::int from social.favourites where user_id = '00000000-0000-0000-0000-0000000000f2'), 1, 'his row is still there');
select is(pg_temp.as_user('n8n_worker', '', 'select api.favourite_delete(''00000000-0000-0000-0000-0000000000f1'', ''{"params": {"listing_id": "00000000-0000-0000-0000-00000000fa01"}}'')#>>''{data,removed}'''),
          'true', 'she removes her own');
update app.users set deleted_at = now() where id = '00000000-0000-0000-0000-0000000000f2';
select is((select count(*)::int from social.favourites where user_id = '00000000-0000-0000-0000-0000000000f2'), 0,
          'erasing a user deletes their favourites');
update app.users set deleted_at = null where id = '00000000-0000-0000-0000-0000000000f2';

-- 2. Search v2 and the public view (n8n_worker, published data only).
select is(pg_temp.as_user('n8n_worker', '', 'select app.search_public_v2(''{"jurisdiction": "ZQ"}'')->>''total_matching_filters'''),
          '2', 'drafts are never searched');
select is(pg_temp.as_user('n8n_worker', '', 'select app.search_public_v2(''{"jurisdiction": "ZQ", "furnished": true, "amenities": ["wifi", "desk"], "house_rules": {"smoking": "no"}}'')#>>''{results,0,id}'''),
          '00000000-0000-0000-0000-00000000fa01', 'filters combine');
select is(pg_temp.as_user('n8n_worker', '', 'select app.search_public_v2(''{"jurisdiction": "ZQ", "bbox": [10.2, 36.2, 10.4, 36.4]}'')#>>''{results,0,id}'''),
          '00000000-0000-0000-0000-00000000fa02', 'map area');
select is(pg_temp.as_user('n8n_worker', '', 'select app.search_public_v2(''{"jurisdiction": "ZQ", "limit": 1}'')->>''next_offset'''),
          '1', 'a next page');
select ok(pg_temp.as_user('n8n_worker', '', 'select app.search_public_v2(''{"jurisdiction": "ZQ"}'')::text') !~ '"location"',
          'no exact location in search results');
select is(pg_temp.as_user('n8n_worker', '', 'select app.listing_public_view(''00000000-0000-0000-0000-00000000fa03'', ''00000000-0000-0000-0000-0000000000f1'')->>''found'''),
          'false', 'a draft is not public');
select is(pg_temp.as_user('n8n_worker', '', 'select app.listing_public_view(''00000000-0000-0000-0000-00000000fa03'', ''00000000-0000-0000-0000-0000000000f2'')#>>''{listing,is_own}'''),
          'true', 'its owner sees a preview');

-- 3. Cancelling a proposal: only the proposer's, only while pending.
insert into ai.listing_changes (id, user_id, listing_id, changes, diff) values
  ('00000000-0000-0000-0000-00000000fc01', '00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-00000000fa01', '{"rent": 1}', '[]');
select is(app.listing_change_cancel_request('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000fc01')->>'found',
          'false', 'someone else''s proposal is not found');

select * from finish();
rollback;
