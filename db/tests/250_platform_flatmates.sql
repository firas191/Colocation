-- Migration 0028: flatmate profiles, compatibility, saved searches and their daily alert (D-106).
\ir helpers.psql
begin;
select plan(25);

insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, timezone)
values ('ZF', 'ZF', 'pgTAP flatmates', 'TND', 'fr', 'UTC');
insert into app.users (id, email, display_name, role, jurisdiction_code) values
  ('00000000-0000-0000-0000-0000000005a1', 'a-p7@example.test', 'Amel', 'user', 'ZF'),
  ('00000000-0000-0000-0000-0000000005a2', 'b-p7@example.test', 'Bilel', 'user', 'ZF'),
  ('00000000-0000-0000-0000-0000000005a3', 'c-p7@example.test', 'Chiraz', 'user', 'ZF'),
  ('00000000-0000-0000-0000-0000000005a4', 'o-p7@example.test', 'Omar', 'user', 'ZF');
insert into app.profiles (user_id, jurisdiction_code, declared_preferences, languages, budget_min_minor, budget_max_minor, currency, budget_period, move_in_from) values
  ('00000000-0000-0000-0000-0000000005a1', 'ZF', '{"smoking": "no", "pets": "ok", "schedule": "early"}', '{fr,ar}', 300000, 500000, 'TND', 'month', '2027-01-01'),
  ('00000000-0000-0000-0000-0000000005a2', 'ZF', '{"smoking": "no", "pets": "no"}', '{en}', 400000, 700000, 'TND', 'month', '2027-01-20'),
  ('00000000-0000-0000-0000-0000000005a3', 'ZF', '{}', '{}', null, null, null, null, null);
create or replace function pg_temp.call(p_fn text, p_user text, p jsonb) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  execute 'set local role n8n_worker';
  execute format('select api.%I(%L::uuid, %L::jsonb)', p_fn, p_user, p) into r;
  reset role;
  return r;
end $$;
\set A '''00000000-0000-0000-0000-0000000005a1'''
\set B '''00000000-0000-0000-0000-0000000005a2'''
\set C '''00000000-0000-0000-0000-0000000005a3'''
\set O '''00000000-0000-0000-0000-0000000005a4'''

-- 1. Compatibility: factor states, the score over known factors only
create temp table cmp as select social.compatibility(:A, :B) as r;
select is((select x->>'state' from cmp, jsonb_array_elements(r->'factors') x where x->>'factor' = 'smoking'), 'match', 'both non-smokers: match');
select is((select x->>'state' from cmp, jsonb_array_elements(r->'factors') x where x->>'factor' = 'pets'), 'differs', 'pets: differs');
select is((select x->>'state' from cmp, jsonb_array_elements(r->'factors') x where x->>'factor' = 'schedule'), 'unknown', 'Bilel did not say: unknown');
select is((select x->>'state' from cmp, jsonb_array_elements(r->'factors') x where x->>'factor' = 'budget'), 'match', 'budgets overlap');
select is((select x->>'state' from cmp, jsonb_array_elements(r->'factors') x where x->>'factor' = 'move_in'), 'match', '19 days apart: match');
-- known: smoking 15, pets 10, languages 10, budget 10, move_in 5 = 50; matched: 15 + 10 + 5 = 30 -> 60
select is((select (r->>'score')::int from cmp), 60, 'score = matched weight / known weight');
select is(social.compatibility(:A, :C)->>'score', null, 'nothing known about Chiraz: no score, not zero');
select ok(not exists (select 1 from jsonb_array_elements(social.compatibility(:A, :C)->'factors') x where x->>'state' = 'differs'),
          'unknown is never a mismatch');
select is(social.compatibility(:A, :B)->'score', social.compatibility(:B, :A)->'score', 'the same both ways');

-- 2. Invariance: columns outside the allowlist do not move the score (rule 2.6)
create temp table before as select social.compatibility(:A, :B) as r;
update app.users set display_name = 'Zeynep', email = 'z-p7@example.test', locale = 'ar', verified_level = 2 where id = :B;
update app.profiles set raw_text = 'je suis croyante, 52 ans, née à Sfax', unparsed = '{religion,age}', anchor_label = 'mosquée'
 where user_id = :B;
insert into social.flatmate_profiles (user_id, visible, headline, bio) values (:B, true, 'Étudiante', 'Je prie cinq fois par jour.');
select is(social.compatibility(:A, :B), (select r from before), 'name, e-mail, language, free text and bio change nothing');

-- 3. Profile and browsing
select is(pg_temp.call('flatmate_profile_put', :A, '{"body": {"visible": true, "headline": "Calme, tôt levée", "seeking": "room", "areas": ["Lac 2"]}}')#>>'{data,profile,headline}',
          'Calme, tôt levée', 'Amel writes her profile');
select is(pg_temp.call('flatmate_profile_get', :A, '{}')#>>'{data,profile,visible}', 'true', 'and reads it back');
select is((select string_agg(x#>>'{user,display_name}', ',') from jsonb_array_elements(pg_temp.call('flatmates_list', :O, '{}')#>'{data,items}') x),
          'Amel,Zeynep', 'Omar sees both visible profiles (no lifestyle answers, so newest first)');
select is(pg_temp.call('flatmate_get', :O, '{"params": {"user_id": "00000000-0000-0000-0000-0000000005a3"}}')->>'status', '404', 'a hidden profile: 404');
insert into social.blocks (blocker_id, blocked_id) values (:A, :O);
select is((select count(*)::int from jsonb_array_elements(pg_temp.call('flatmates_list', :O, '{}')#>'{data,items}') x
            where x#>>'{user,user_id}' = '00000000-0000-0000-0000-0000000005a1'), 0, 'Amel blocked Omar: he no longer sees her');
select is(pg_temp.call('flatmate_get', :O, '{"params": {"user_id": "00000000-0000-0000-0000-0000000005a1"}}')->>'status', '404', 'nor by her id');
select is((select count(*)::int from jsonb_array_elements(pg_temp.call('flatmates_list', :A, '{}')#>'{data,items}') x
            where x#>>'{user,user_id}' = '00000000-0000-0000-0000-0000000005a4'), 0, 'and she does not see him');

-- 4. A room posted by a household: a draft linked to it, once
insert into home.households (id, name, jurisdiction_code, currency, timezone, created_by)
values ('00000000-0000-0000-0000-0000000005c1', 'Maison ZF', 'ZF', 'TND', 'UTC', :A);
insert into home.household_members (household_id, user_id, role) values ('00000000-0000-0000-0000-0000000005c1', :A, 'flatmate');
select is(home.room_post(:A, '{"params": {"id": "00000000-0000-0000-0000-0000000005c1"}, "body": {"title": "Chambre libre"}}')#>>'{data,status}',
          'draft', 'Amel posts the free room: a draft');
select is(home.room_post(:A, '{"params": {"id": "00000000-0000-0000-0000-0000000005c1"}, "body": {}}')->>'status', '409', 'only one at a time');
select is(home.room_post(:O, '{"params": {"id": "00000000-0000-0000-0000-0000000005c1"}, "body": {}}')->>'status', '404', 'not a member: 404');

-- 5. Saved searches: each new listing is sent once
create temp table s as select pg_temp.call('saved_search_create', :C, '{"body": {"name": "ZF", "query": {"jurisdiction": "ZF"}, "params": {"jurisdiction": "ZF"}}}') as r;
select is((select r->>'status' from s), '201', 'Chiraz saves a search');
update social.saved_searches set created_at = now() - interval '1 day', last_seen_published_at = now() - interval '1 day';
insert into app.listings (id, owner_id, jurisdiction_code, status, title, description, published_at) values
  ('00000000-0000-0000-0000-0000000005b1', :O, 'ZF', 'published', 'Chambre ZF', 'x', now());
select is(social.daily_alerts()->>'listings', '1', 'the new listing is sent');
update social.saved_searches set last_alert_at = now() - interval '1 day', last_seen_published_at = now() - interval '1 day';
select is(social.daily_alerts()->>'listings', '0', 'not twice, even when the run starts over');
select is((select count(*)::int from notify.notifications where type = 'saved_search_match' and user_id = :C), 1, 'one notification');
select is(pg_temp.call('saved_search_delete', :A, jsonb_build_object('params', jsonb_build_object('id', (select r#>>'{data,saved_search_id}' from s))))->>'status',
          '404', 'another user cannot delete it');

select * from finish();
rollback;
