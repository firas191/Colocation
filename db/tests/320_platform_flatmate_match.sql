-- Migration 0036: contact requests with mutual consent, explanation facts, the profile agent's state and apply, the living
-- plan facts (D-115, from Yosr's roommate matching).
\ir helpers.psql
begin;
select plan(24);

insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, timezone)
values ('ZM', 'ZM', 'pgTAP flatmate match', 'TND', 'fr', 'UTC');
insert into app.users (id, email, display_name, role, jurisdiction_code) values
  ('00000000-0000-0000-0000-000000000da1', 'a-p12m@example.test', 'Amira', 'user', 'ZM'),
  ('00000000-0000-0000-0000-000000000da2', 'b-p12m@example.test', 'Sarra', 'user', 'ZM'),
  ('00000000-0000-0000-0000-000000000da3', 'c-p12m@example.test', 'Yassine', 'user', 'ZM'),
  ('00000000-0000-0000-0000-000000000da4', 'd-p12m@example.test', 'Dora', 'user', 'ZM');
create or replace function pg_temp.call(p_fn text, p_user text, p jsonb) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  execute 'set local role n8n_worker';
  execute format('select api.%I(%L::uuid, %L::jsonb)', p_fn, p_user, p) into r;
  reset role;
  return r;
end $$;
\set A '''00000000-0000-0000-0000-000000000da1'''
\set B '''00000000-0000-0000-0000-000000000da2'''
\set C '''00000000-0000-0000-0000-000000000da3'''
\set D '''00000000-0000-0000-0000-000000000da4'''
insert into social.flatmate_profiles (user_id, visible, headline) values (:A, true, 'Calme'), (:B, true, 'Étudiante'), (:D, false, 'Cachée');

-- 1. Contact requests
create temp table r1 as select pg_temp.call('contact_request_create', :A, jsonb_build_object('params', jsonb_build_object('user_id', :B), 'body', '{"note": "Bonjour Sarra"}'::jsonb)) as r;
select is((select r->>'status' from r1), '201', 'a request to a visible profile');
select is((select r#>>'{data,direction}' from r1), 'sent', 'the sender sees it as sent');
select is(pg_temp.call('contact_request_create', :B, jsonb_build_object('params', jsonb_build_object('user_id', :A)))#>>'{error,details,0,issue}',
          'already_requested', 'one open request per pair, either direction');
select is(pg_temp.call('contact_request_create', :A, jsonb_build_object('params', jsonb_build_object('user_id', :D)))->>'status', '404',
          'a hidden profile cannot be asked');
select is(pg_temp.call('contact_request_create', :A, jsonb_build_object('params', jsonb_build_object('user_id', :A)))->>'status', '404',
          'not oneself');
select is((select count(*)::int from notify.notifications where user_id = :B and type = 'contact_request_received'), 1, 'Sarra is told');
select is(pg_temp.call('contact_requests_list', :B, '{"query": {"direction": "received"}}')#>>'{data,items,0,actions,accept}', 'true',
          'Sarra may accept');
select is(pg_temp.call('contact_requests_list', :C, '{}')#>>'{data,items}', '[]', 'nobody else sees the request');
select is(pg_temp.call('contact_request_decide', :A, jsonb_build_object('params', jsonb_build_object('id', (select r#>>'{data,request_id}' from r1)),
          'body', '{"action": "accept"}'::jsonb))->>'status', '403', 'the sender cannot accept their own request');
select is(pg_temp.call('contact_request_decide', :C, jsonb_build_object('params', jsonb_build_object('id', (select r#>>'{data,request_id}' from r1)),
          'body', '{"action": "accept"}'::jsonb))->>'status', '404', 'a third person does not see it');
create temp table r2 as select pg_temp.call('contact_request_decide', :B, jsonb_build_object('params', jsonb_build_object('id', (select r#>>'{data,request_id}' from r1)),
          'body', '{"action": "accept"}'::jsonb)) as r;
select is((select r#>>'{data,status}' from r2), 'accepted', 'accepted');
select is((select string_agg(user_id::text, ',' order by user_id) from social.conversation_members where conversation_id = (select (r#>>'{data,conversation_id}')::uuid from r2)),
          '00000000-0000-0000-0000-000000000da1,00000000-0000-0000-0000-000000000da2', 'a direct conversation between the two');
select is((select sender_id::text || ':' || body from social.messages where conversation_id = (select (r#>>'{data,conversation_id}')::uuid from r2)),
          '00000000-0000-0000-0000-000000000da1:Bonjour Sarra', 'the note is its first message, from the person who asked');
select is((select link_kind from notify.notifications where user_id = :A and type = 'contact_request_accepted'), 'conversation', 'Amira is told, with the conversation');
select is(pg_temp.call('contact_request_decide', :B, jsonb_build_object('params', jsonb_build_object('id', (select r#>>'{data,request_id}' from r1)),
          'body', '{"action": "refuse"}'::jsonb))#>>'{error,details,0,issue}', 'not_pending', 'a closed request stays closed');
insert into social.blocks (blocker_id, blocked_id) values (:C, :A);
select is(pg_temp.call('contact_request_create', :A, jsonb_build_object('params', jsonb_build_object('user_id', :C)))->>'status', '404',
          'blocked people cannot ask each other');

-- 2. Explanation facts: the factor states, never the other person's answers
insert into app.profiles (user_id, jurisdiction_code, declared_preferences) values
  (:A, 'ZM', '{"smoking": "no", "pets": "no", "schedule": "early"}'), (:B, 'ZM', '{"smoking": "no", "pets": "yes"}');
select is(pg_temp.call('flatmate_explain_facts', :A, jsonb_build_object('params', jsonb_build_object('user_id', :B)))#>>'{data,compatibility,score}',
          '60', 'the score of P7 (smoking matches, pets differ: 15 of 25)');
select ok(pg_temp.call('flatmate_explain_facts', :A, jsonb_build_object('params', jsonb_build_object('user_id', :B)))::text not like '%"yes"%',
          'no answer of the other person is given');

-- 3. The profile agent: what is missing, and applying what the person confirmed
select ok(app.flatmate_onboarding_state(:C)->'missing' @> '["schedule", "budget", "areas"]', 'a new person: everything is missing');
create temp table ap as select app.flatmate_onboarding_apply(:C, '{"lifestyle": {"schedule": "late", "smoking": "yes", "invented": "x"}, "budget_max": 350, "areas": ["Ariana"], "visible": true}') as r;
select ok((select declared_preferences = '{"schedule": "late", "smoking": "yes"}'::jsonb from app.profiles where user_id = :C), 'known answers only');
select is((select budget_max_minor from app.profiles where user_id = :C), 350000::bigint, 'the budget in minor units of the country (TND, 3)');
select is((select array_to_string(areas, ',') || ':' || visible from social.flatmate_profiles where user_id = :C), 'Ariana:true', 'the flatmate profile');

-- 4. Living plan facts: agreed, to discuss, not said; never who said what
insert into home.households (id, name, jurisdiction_code, currency, timezone, created_by)
values ('00000000-0000-0000-0000-000000000de1', 'Dar ZM', 'ZM', 'TND', 'UTC', :A);
insert into home.household_members (household_id, user_id, role, status) values
  ('00000000-0000-0000-0000-000000000de1', :A, 'flatmate', 'active'), ('00000000-0000-0000-0000-000000000de1', :B, 'flatmate', 'active');
select is((select string_agg(x->>'agreement', ' | ' order by ord) from jsonb_array_elements(home.living_plan_habits('00000000-0000-0000-0000-000000000de1', 'en'))
          with ordinality t(x, ord) where ord in (1, 3, 4)), 'Not said by everyone yet | Agreed: no | To discuss: the answers differ',
          'schedule not said by Sarra, both non-smokers, pets differ');
select is((select count(*)::int from jsonb_array_elements(home.living_plan_habits('00000000-0000-0000-0000-000000000de1', 'fr'))), 6, 'six topics');

select * from finish();
rollback;
