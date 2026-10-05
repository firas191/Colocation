-- Migration 0014: automatic publication for tests and demonstrations (D-083).
\ir helpers.psql
begin;
select plan(11);

insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, timezone)
values ('ZP', 'ZP', 'pgTAP publish', 'TND', 'fr', 'UTC');
insert into app.places (place_key, jurisdiction_code, kind, name, city, location, source) values
  ('zp-sahloul-test', 'ZP', 'neighbourhood', 'Sahloul Test', 'Sousse', st_setsrid(st_makepoint(10.60, 35.83), 4326)::geography, 'test');
insert into app.place_names (place_id, name) select id, 'Sahloul Test' from app.places where place_key = 'zp-sahloul-test';
insert into app.users (id, email, display_name, role) values
  ('00000000-0000-0000-0000-0000000000f1', 'owner-p@example.test', 'Owner', 'owner');
create temp table t_l as select (app.listing_create('00000000-0000-0000-0000-0000000000f1',
  '{"jurisdiction_code":"ZP","text":"Chambre meublée à Sahloul Test, 350 DT"}')->>'listing_id')::uuid as id;
select app.store_listing_extraction((select id from t_l), '{"fields": {"kind": "room", "rent_minor": 350000, "currency": "TND",
  "rent_period": "month", "rent_scope": "per_room", "neighbourhood": "Sahloul Test", "city": null, "amenities": [], "house_rules": {}},
  "extraction": {"issues": []}}'::jsonb);

select is(app.listing_auto_publish((select id from t_l))->>'reason', 'auto_publish_off', 'off by default: nothing happens');
select is((select status from app.listings where id = (select id from t_l)), 'draft', 'still a draft');

update app.settings set value = 'true' where key = 'listing.auto_publish';
create temp table t_r as select app.listing_auto_publish((select id from t_l)) as r;
select is((select r->>'published' from t_r), 'true', 'published when the setting is on');
select ok((select status = 'published' and published_at is not null and location is not null and public_location is not null
             and not st_equals(location::geometry, public_location::geometry)
           from app.listings where id = (select id from t_l)), 'status, date, exact point and a different public point');
select is((select title from app.listings where id = (select id from t_l)), 'Chambre meublée à Sahloul Test, 350 DT', 'title from the text');
select is((select extraction#>>'{publication,checked}' from app.listings where id = (select id from t_l)), 'false', 'marked not checked');
select ok((select r->>'embed_text' like 'Chambre meublée%' from t_r), 'text to embed returned');
select is(app.listing_auto_publish((select id from t_l))->>'reason', 'not_a_draft', 'a published listing is left alone');

create temp table t_l2 as select (app.listing_create('00000000-0000-0000-0000-0000000000f1',
  '{"jurisdiction_code":"ZP","text":"Chambre quelque part"}')->>'listing_id')::uuid as id;
select is(app.listing_auto_publish((select id from t_l2))->'missing', '["rent", "place"]'::jsonb, 'without rent and place: stays a draft');
select is((select status || ' ' || (extraction#>>'{publication,missing}') from app.listings where id = (select id from t_l2)),
  'draft ["rent", "place"]', 'what is missing is stored for the owner');
set local role api_user;
select throws_ok($$select app.listing_auto_publish(gen_random_uuid())$$, '42501', null, 'api_user cannot publish');
reset role;

select * from finish();
rollback;
