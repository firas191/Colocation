-- Migration 0027: chores rota, shopping list, house rules, calendar, issues (D-105).
\ir helpers.psql
begin;
select plan(20);

insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, timezone)
values ('ZL', 'ZL', 'pgTAP household life', 'TND', 'fr', 'UTC');
insert into app.users (id, email, display_name, role, jurisdiction_code) values
  ('00000000-0000-0000-0000-0000000004a1', 'a-p6@example.test', 'Amel', 'user', 'ZL'),
  ('00000000-0000-0000-0000-0000000004a2', 'b-p6@example.test', 'Bilel', 'user', 'ZL'),
  ('00000000-0000-0000-0000-0000000004a3', 'c-p6@example.test', 'Chiraz', 'user', 'ZL'),
  ('00000000-0000-0000-0000-0000000004a4', 'o-p6@example.test', 'Omar', 'user', 'ZL'),
  ('00000000-0000-0000-0000-0000000004a9', 'x-p6@example.test', 'Xavier', 'user', 'ZL');
insert into home.households (id, name, jurisdiction_code, currency, timezone, created_by)
values ('00000000-0000-0000-0000-0000000004b1', 'Maison ZL', 'ZL', 'TND', 'UTC', '00000000-0000-0000-0000-0000000004a1');
insert into home.household_members (household_id, user_id, role, joined_at) values
  ('00000000-0000-0000-0000-0000000004b1', '00000000-0000-0000-0000-0000000004a1', 'flatmate', now() - interval '3 days'),
  ('00000000-0000-0000-0000-0000000004b1', '00000000-0000-0000-0000-0000000004a2', 'flatmate', now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000004b1', '00000000-0000-0000-0000-0000000004a3', 'flatmate', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000004b1', '00000000-0000-0000-0000-0000000004a4', 'owner', now());
create or replace function pg_temp.call(p_fn text, p_user text, p jsonb) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  execute 'set local role n8n_worker';
  execute format('select api.%I(%L::uuid, %L::jsonb)', p_fn, p_user, p) into r;
  reset role;
  return r;
end $$;
\set A '''00000000-0000-0000-0000-0000000004a1'''
\set B '''00000000-0000-0000-0000-0000000004a2'''
\set C '''00000000-0000-0000-0000-0000000004a3'''
\set O '''00000000-0000-0000-0000-0000000004a4'''
\set X '''00000000-0000-0000-0000-0000000004a9'''
\set H '''{"params": {"id": "00000000-0000-0000-0000-0000000004b1"}}'''

-- 1. Rotation order over several cycles, then a member leaving the rotation
create temp table k (name text primary key, v text);
insert into k select 'ch', pg_temp.call('chore_create', :A, (:H)::jsonb || '{"body": {"title": "Poubelles", "frequency": "daily", "next_due_on": "2026-11-01"}}')#>>'{data,chore_id}';
select isnt((select v from k where name = 'ch'), null, 'a daily chore over the three flatmates');
select is(home.daily_chores('2026-11-06')->>'assignments', '6', 'six days: six assignments');
select is((select string_agg(u.display_name, ',' order by a.due_on) from home.chore_assignments a join app.users u on u.id = a.user_id
            where a.chore_id = (select v from k where name = 'ch')::uuid),
          'Amel,Bilel,Chiraz,Amel,Bilel,Chiraz', 'in rotation order, two full cycles');
select is(home.daily_chores('2026-11-06')->>'assignments', '0', 'not twice for the same days');
update home.household_members set status = 'left' where user_id = '00000000-0000-0000-0000-0000000004a2';
select is(home.daily_chores('2026-11-09')->>'assignments', '3', 'three more days');
select is((select string_agg(u.display_name, ',' order by a.due_on) from home.chore_assignments a join app.users u on u.id = a.user_id
            where a.chore_id = (select v from k where name = 'ch')::uuid and a.due_on > '2026-11-06'),
          'Amel,Chiraz,Amel', 'Bilel left: he is skipped');
select is((select count(*)::int from notify.notifications where type = 'chore_assigned' and user_id = '00000000-0000-0000-0000-0000000004a1'), 4,
          'Amel was told of each of her four turns');
select is(pg_temp.call('chores_list', :O, :H)->>'status', '403', 'the owner member does not see the chores (7.3)');
select is(pg_temp.call('chores_list', :X, :H)->>'status', '404', 'an outsider: 404');

-- 2. Shopping list: flatmates only
select is(pg_temp.call('shopping_add', :A, (:H)::jsonb || '{"body": {"label": "Lait", "quantity": "2 L"}}')->>'status', '201', 'Amel adds milk');
select is(pg_temp.call('shopping_list', :O, :H)->>'status', '403', 'the owner member does not see the shopping list');
select is(jsonb_array_length(pg_temp.call('shopping_list', :C, :H)#>'{data,items}'), 1, 'Chiraz sees it');

-- 3. Rules and calendar: every member
select is(pg_temp.call('rules_put', :O, (:H)::jsonb || '{"body": {"items": [{"category": "quiet", "text": "Calme après 22 h"}]}}')#>>'{data,items,0,text}',
          'Calme après 22 h', 'the owner member writes a house rule');
select is(pg_temp.call('event_create', :A, (:H)::jsonb || '{"body": {"title": "Dîner", "starts_at": "2026-11-20T19:00:00Z"}}')->>'status', '201', 'an event');
select is((select count(*)::int from jsonb_array_elements(pg_temp.call('calendar_get', :A, (:H)::jsonb || '{"query": {"from": "2026-11-06", "to": "2026-11-30"}}')#>'{data,items}') x
            where x->>'kind' in ('event', 'chore')), 5, 'the calendar has the event and the four chores in range');
select is(pg_temp.call('calendar_get', :A, (:H)::jsonb || '{"query": {"from": "2026-01-01", "to": "2026-12-31"}}')#>>'{error,details,0,issue}',
          'range_too_long', 'at most 92 days at once');

-- 4. Issues: reported by a flatmate, seen and moved on by the owner member
create temp table i as select pg_temp.call('issue_create', :C, (:H)::jsonb || '{"body": {"title": "Fuite sous l''évier", "category": "plumbing", "urgency": "urgent"}}') as r;
select is((select count(*)::int from notify.notifications where type = 'issue_reported_owner' and user_id = '00000000-0000-0000-0000-0000000004a4'), 1,
          'the owner member is told');
select is(pg_temp.call('issue_update', :O, jsonb_build_object('params', jsonb_build_object('id', (select r#>>'{data,issue_id}' from i)),
            'body', '{"status": "in_progress", "comment": "Le plombier vient mardi"}'::jsonb))#>>'{data,status}', 'in_progress', 'the owner moves it on');
select is(pg_temp.call('issue_update', :C, jsonb_build_object('params', jsonb_build_object('id', (select r#>>'{data,issue_id}' from i)),
            'body', '{"status": "resolved"}'::jsonb))->>'status', '403', 'a flatmate cannot mark it resolved');
select is(pg_temp.call('issue_update', :X, jsonb_build_object('params', jsonb_build_object('id', (select r#>>'{data,issue_id}' from i)),
            'body', '{"comment": "x"}'::jsonb))->>'status', '404', 'an outsider: 404');

select * from finish();
rollback;
