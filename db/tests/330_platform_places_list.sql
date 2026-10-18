-- Migration 0038: GET /v1/places, the cities of a country for the website's city filter (D-118).
\ir helpers.psql
begin;
select plan(8);

insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, timezone)
values ('ZP', 'ZP', 'pgTAP places', 'TND', 'fr', 'UTC');
insert into app.users (id, email, display_name, role, jurisdiction_code) values
  ('00000000-0000-0000-0000-000000000ea1', 'a-places@example.test', 'Amel', 'user', 'ZP');
insert into app.places (place_key, jurisdiction_code, kind, name, city, location, source, active) values
  ('zp-bizerte', 'ZP', 'city', 'Bizerte', 'Bizerte', st_setsrid(st_makepoint(9.87, 37.27), 4326)::geography, 'test', true),
  ('zp-ariana', 'ZP', 'city', 'Ariana', 'Ariana', st_setsrid(st_makepoint(10.19, 36.86), 4326)::geography, 'test', true),
  ('zp-old', 'ZP', 'city', 'Ancienne', null, st_setsrid(st_makepoint(10, 36), 4326)::geography, 'test', false),
  ('zp-ennasr', 'ZP', 'neighbourhood', 'Ennasr', 'Ariana', st_setsrid(st_makepoint(10.16, 36.86), 4326)::geography, 'test', true);
insert into app.place_names (place_id, name, lang) select id, 'أريانة', 'ar' from app.places where place_key = 'zp-ariana';
create or replace function pg_temp.call(p jsonb) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  execute 'set local role n8n_worker';
  select api.places_list('00000000-0000-0000-0000-000000000ea1'::uuid, p) into r;
  reset role;
  return r;
end $$;

select is((pg_temp.call('{"query": {"jurisdiction": "ZP"}}')->>'status')::int, 200, 'listed');
select is(pg_temp.call('{"query": {"jurisdiction": "ZP"}}')#>'{data,items}',
  '[{"place_key": "zp-ariana", "kind": "city", "name": "Ariana", "city": "Ariana"},
    {"place_key": "zp-bizerte", "kind": "city", "name": "Bizerte", "city": "Bizerte"}]'::jsonb,
  'active cities only, by name');
select is(jsonb_path_query_first(pg_temp.call('{"query": {"jurisdiction": "ZP", "lang": "ar"}}'), '$.data.items[*] ? (@.place_key == "zp-ariana").name') #>> '{}', 'أريانة', 'the name in the reader''s language when there is one');
select is(jsonb_path_query_first(pg_temp.call('{"query": {"jurisdiction": "ZP", "lang": "ar"}}'), '$.data.items[*] ? (@.place_key == "zp-bizerte").name') #>> '{}', 'Bizerte', 'else the gazetteer name');
select is(pg_temp.call('{"query": {"jurisdiction": "ZP", "kind": "neighbourhood"}}')#>>'{data,items,0,place_key}', 'zp-ennasr', 'another kind');
select is(pg_temp.call('{"query": {"jurisdiction": "QQ"}}')#>>'{error,code}', 'VALIDATION_FAILED', 'unknown country');
select is((select pg_get_userbyid(proowner) from pg_proc where oid = 'api.places_list(uuid,jsonb)'::regprocedure), 'app_rls', 'owned by app_rls');
select ok(not has_function_privilege('public', 'app.places_for(text,text,text)', 'execute'), 'the gazetteer reader is not public');

select * from finish();
rollback;
