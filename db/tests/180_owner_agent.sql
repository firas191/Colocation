-- Migration 0019: changes to a listing by its owner, proposals of the owner assistant (D-088).
\ir helpers.psql
begin;
select plan(30);

insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, timezone)
values ('ZW', 'ZW', 'pgTAP owner agent', 'TND', 'fr', 'UTC');
insert into app.places (jurisdiction_code, kind, name, place_key, city, location, source)
values ('ZW', 'neighbourhood', 'Quartier Zed', 'zw-zed', 'Zedville', st_setsrid(st_makepoint(10.5, 36.5), 4326)::geography, 'test');
insert into app.place_names (place_id, name) select id, 'Quartier Zed' from app.places where place_key = 'zw-zed';
insert into app.users (id, email, display_name, role, jurisdiction_code) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner-o@example.test', 'Owner', 'owner', 'ZW'),
  ('00000000-0000-0000-0000-0000000000a2', 'other-o@example.test', 'Other', 'owner', 'ZW');
insert into app.listings (id, owner_id, jurisdiction_code, status, title, description, rent_minor, currency, location, city,
                          neighbourhood, published_at, amenities, created_at) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'ZW', 'published', 'Chambre', 'Texte', 350000, 'TND',
   st_setsrid(st_makepoint(10.1, 36.1), 4326)::geography, 'Zedville', null, now(), '{wifi,tv}', now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a1', 'ZW', 'draft', null, 'Brouillon', null, null,
   null, null, null, null, '{}', now() - interval '1 day');
insert into app.listing_media (id, listing_id, kind, storage_key, mime, bytes, sha256, moderation, created_at) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1', 'photo', 'media/b1/1.jpg', 'image/jpeg', 1, 's1', 'ok', now() - interval '3 minutes'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000b1', 'photo', 'media/b1/2.jpg', 'image/jpeg', 1, 's2', 'blurred', now() - interval '2 minutes'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000b1', 'photo', 'media/b1/3.jpg', 'image/jpeg', 1, 's3', 'rejected', now() - interval '1 minute');

-- checks
create temp table t_k as select app.listing_change_check('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1',
  '{"rent": 400, "deposit": 800, "furnished": true, "amenities_add": ["desk"], "amenities_remove": ["tv"], "house_rules": {"smoking": "no"}}') as c;
select is((select (c->>'ok')::boolean from t_k), true, 'a valid change');
select is((select c->'diff'->0 from t_k), '{"field": "rent", "before": 350, "after": 400, "currency": "TND"}'::jsonb, 'rent in main units, before and after');
select is((select c#>'{set,rent_minor}' from t_k), '400000'::jsonb, 'stored in millimes');
select is((select e->'after' from t_k, jsonb_array_elements(c->'diff') e where e->>'field' = 'amenities'), '["desk", "wifi"]'::jsonb, 'amenities added and removed');
select is(app.listing_change_check('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b1', '{"rent": 400}')->'errors'->0->>'issue',
          'not_found', 'another owner''s listing does not exist for him');
select is(app.listing_change_check('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '{"rent": 400000}')->'errors'->0->>'issue',
          'out_of_range', 'a rent in millimes is out of the plausible range (listing.rent_range)');
select is(app.listing_change_check('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '{"rent": 350}')->'errors'->0->>'issue',
          'no_change', 'the same value is no change');
select is(app.listing_change_check('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '{"title": "x"}')->'errors'->0->>'issue',
          'unknown_field', 'only the listed fields');
select is(app.listing_change_check('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '{"amenities_add": ["jacuzzi"]}')->'errors'->0->>'issue',
          'unknown_amenity', 'amenities from the vocabulary');
select is(app.listing_change_check('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '{"remove_photos": [3]}')->'errors'->0->>'issue',
          'no_such_photo', 'a rejected photo is not counted: there is no photo 3');
select is(app.listing_change_check('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '{"place": "Nowhere"}')->'errors'->0->>'issue',
          'place_not_found', 'a place must be found on the map');
select is(app.listing_change_check('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', '{"status": "published"}')->'errors'->0->>'issue',
          'status_not_allowed', 'a draft is not published by a change');
select is(app.listing_change_check('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '{"available_from": "2020-01-01"}')->'errors'->0->>'issue',
          'invalid_date', 'a date in the past');

-- the owner assistant: numbered listings, a proposal, the proposal of a request
create temp table t_l as select app.owner_listings('owner:user:00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1') as r;
select is((select jsonb_path_query_array(r->'listings', '$[*].status') from t_l), '["draft", "published"]'::jsonb, 'most recent first');
select is((select r->'listings'->0->'missing' from t_l), '["rent", "place"]'::jsonb, 'what a draft misses');
select is((select (r->'listings'->1->>'photos')::int from t_l), 2, 'photos counted without the rejected one');
select ok((select not (r::text like '%Texte%' or r::text like '%Chambre%') from t_l), 'no title or description given to the model');
select is(app.owner_change_propose('owner:user:00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-00000000aa01', 2, '{"rent": 400, "remove_photos": [2]}')->>'proposed', 'true', 'proposal for listing 2');
select is(app.owner_change_propose('owner:user:00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-00000000aa01', 5, '{"rent": 400}')->'errors'->0->>'issue', 'no_such_listing', 'no listing 5');
create temp table t_p as select app.owner_change_of_request('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa01') as p;
select is((select (p->>'listing_number')::int from t_p), 2, 'the proposal of the request, with the listing number');
select is((select count(*)::int from app.listings where id = '00000000-0000-0000-0000-0000000000b1' and rent_minor = 350000), 1, 'nothing written yet');

-- confirmation applies it; a second one does not
create temp table t_a as select app.listing_change_confirm('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1',
  (select (p->>'change_id')::uuid from t_p)) as r;
select is((select (r->>'ok')::boolean from t_a), true, 'confirmed');
select is((select rent_minor from app.listings where id = '00000000-0000-0000-0000-0000000000b1'), 400000::bigint, 'rent written');
select is((select r->'deleted_keys' from t_a), '["media/b1/2.jpg"]'::jsonb, 'photo 2 removed, its key returned for storage');
select is((select count(*)::int from app.listing_media where listing_id = '00000000-0000-0000-0000-0000000000b1'), 2, 'one row deleted');
select is(app.listing_change_confirm('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1',
  (select (p->>'change_id')::uuid from t_p))->'errors'->0->>'issue', 'already_applied', 'a proposal is applied once');

-- a place: neighbourhood, city and location from the gazetteer; a published listing is embedded again
create temp table t_g as select app.listing_apply_changes('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1',
  '{"place": "quartier zed"}') as r;
select is((select neighbourhood || '|' || city from app.listings where id = '00000000-0000-0000-0000-0000000000b1'), 'Quartier Zed|Zedville',
          'place from the gazetteer');
select is((select (r->>'reembed')::boolean and r->>'embed_text' like '%Quartier Zed%' from t_g), true, 'embed again with the new place');

-- archived, then published again
select is(app.listing_apply_changes('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '{"status": "archived"}')->>'status',
          'archived', 'archived (rented)');
select is(app.agent_followup('00000000-0000-0000-0000-0000000000a1'), 'owner', 'a listing changed just now: owner follow-up');

select * from finish();
rollback;
