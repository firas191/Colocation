-- Migration 0025: messages, blocks, visit slots and visits, applications, reports behind the row-level layer (D-103).
\ir helpers.psql
begin;
select plan(32);

insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, timezone)
values ('ZC', 'ZC', 'pgTAP contact', 'TND', 'fr', 'UTC');
insert into app.users (id, email, display_name, role, jurisdiction_code) values
  ('00000000-0000-0000-0000-0000000002a1', 'seeker-p4@example.test', 'Sami', 'user', 'ZC'),
  ('00000000-0000-0000-0000-0000000002a2', 'owner-p4@example.test', 'Olfa', 'user', 'ZC'),
  ('00000000-0000-0000-0000-0000000002a3', 'third-p4@example.test', 'Tarek', 'user', 'ZC');
insert into app.listings (id, owner_id, jurisdiction_code, status, title, description, published_at) values
  ('00000000-0000-0000-0000-0000000002b1', '00000000-0000-0000-0000-0000000002a2', 'ZC', 'published', 'Chambre Olfa', 'x', now()),
  ('00000000-0000-0000-0000-0000000002b2', '00000000-0000-0000-0000-0000000002a2', 'ZC', 'draft', 'Brouillon', 'x', null);
insert into app.profiles (user_id, jurisdiction_code, declared_preferences, languages, budget_max_minor, currency, budget_period)
values ('00000000-0000-0000-0000-0000000002a1', 'ZC', '{"smoking": "no"}', '{fr}', 400000, 'TND', 'month');

create temp table k (name text primary key, v text);
create or replace function pg_temp.call(p_fn text, p_user text, p jsonb) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  execute 'set local role n8n_worker';
  execute format('select api.%I(%L::uuid, %L::jsonb)', p_fn, p_user, p) into r;
  reset role;
  return r;
end $$;
\set S '''00000000-0000-0000-0000-0000000002a1'''
\set O '''00000000-0000-0000-0000-0000000002a2'''
\set T '''00000000-0000-0000-0000-0000000002a3'''

-- 1. n8n_worker never reaches the tables
select is(pg_temp.as_user('n8n_worker', '', 'select count(*) from social.messages'), 'ERROR 42501', 'n8n_worker: no privilege on messages');
select is(pg_temp.as_user('n8n_worker', '', 'select count(*) from social.applications'), 'ERROR 42501', 'nor on applications');

-- 2. Messages: a conversation about a published listing, seen by its two members only
insert into k select 'c', pg_temp.call('conversation_start', :S, '{"body": {"listing_id": "00000000-0000-0000-0000-0000000002b1", "text": "Bonjour, est-elle libre ?"}}')#>>'{data,conversation,conversation_id}';
select isnt((select v from k where name = 'c'), null, 'the seeker starts a conversation');
select is(pg_temp.call('conversation_start', :S, '{"body": {"listing_id": "00000000-0000-0000-0000-0000000002b2", "text": "x"}}')->>'status', '404', 'not about a draft');
select is(pg_temp.call('conversation_start', :O, '{"body": {"listing_id": "00000000-0000-0000-0000-0000000002b1", "text": "x"}}')#>>'{error,details,0,issue}', 'own_listing', 'not with oneself');
select is(pg_temp.call('conversation_start', :S, '{"body": {"listing_id": "00000000-0000-0000-0000-0000000002b1", "text": "Encore moi"}}')#>>'{data,conversation,conversation_id}',
          (select v from k where name = 'c'), 'the same conversation again');
select is(pg_temp.call('messages_list', :O, jsonb_build_object('params', jsonb_build_object('id', (select v from k where name = 'c'))))#>>'{data,conversation,unread}', '2', 'the owner has 2 unread');
select is(pg_temp.call('messages_list', :T, jsonb_build_object('params', jsonb_build_object('id', (select v from k where name = 'c'))))->>'status', '404', 'a third user: 404');
select is(pg_temp.call('message_send', :T, jsonb_build_object('params', jsonb_build_object('id', (select v from k where name = 'c')), 'body', '{"text": "spam"}'::jsonb))->>'status', '404', 'and cannot write in it');
select is(jsonb_array_length(pg_temp.call('conversations_list', :T, '{}')#>'{data,items}'), 0, 'nor list it');
select is(pg_temp.call('message_send', :O, jsonb_build_object('params', jsonb_build_object('id', (select v from k where name = 'c')), 'body', '{"text": "Oui"}'::jsonb))->>'status', '201', 'the owner answers');
select is(pg_temp.call('conversation_read', :O, jsonb_build_object('params', jsonb_build_object('id', (select v from k where name = 'c'))))#>>'{data,unread}', '0', 'read');
select is((select count(*)::int from notify.notifications where user_id = '00000000-0000-0000-0000-0000000002a2' and type = 'message_received'), 2,
          'the owner was notified of each message');
-- the message limit per minute
update app.settings set value = '2' where key = 'messages.per_minute';
select is(pg_temp.call('message_send', :S, jsonb_build_object('params', jsonb_build_object('id', (select v from k where name = 'c')), 'body', '{"text": "3"}'::jsonb))->>'status', '429', 'the third message in a minute with a limit of 2: 429');
update app.settings set value = '20' where key = 'messages.per_minute';

-- 3. Visits in the owner's slots
insert into k select 's', pg_temp.call('visit_slots_put', :O, jsonb_build_object('params', '{"id": "00000000-0000-0000-0000-0000000002b1"}'::jsonb,
  'body', jsonb_build_object('slots', jsonb_build_array(jsonb_build_object('starts_at', now() + interval '2 days', 'ends_at', now() + interval '2 days 1 hour', 'capacity', 1)))))#>>'{data,items,0,slot_id}';
select isnt((select v from k where name = 's'), null, 'the owner opens a slot');
select is(pg_temp.call('visit_slots_put', :S, '{"params": {"id": "00000000-0000-0000-0000-0000000002b1"}, "body": {"slots": []}}')->>'status', '404', 'nobody else can');
insert into k select 'v', pg_temp.call('visit_request', :S, jsonb_build_object('body', jsonb_build_object('slot_id', (select v from k where name = 's'))))#>>'{data,visit_id}';
select isnt((select v from k where name = 'v'), null, 'the seeker asks for the slot');
select is(pg_temp.call('visit_request', :T, jsonb_build_object('body', jsonb_build_object('slot_id', (select v from k where name = 's'))))#>>'{error,details,0,issue}', 'slot_full',
          'the slot (capacity 1) is full for a third user, who cannot see the first visit');
select is(pg_temp.call('visit_decide', :S, jsonb_build_object('params', jsonb_build_object('id', (select v from k where name = 'v')), 'body', '{"action": "confirm"}'::jsonb))->>'status', '409',
          'the seeker cannot confirm their own request');
select is(pg_temp.call('visit_decide', :T, jsonb_build_object('params', jsonb_build_object('id', (select v from k where name = 'v')), 'body', '{"action": "cancel"}'::jsonb))->>'status', '404',
          'a third user: 404');
select is(pg_temp.call('visit_decide', :O, jsonb_build_object('params', jsonb_build_object('id', (select v from k where name = 'v')), 'body', '{"action": "confirm"}'::jsonb))#>>'{data,status}', 'confirmed',
          'the owner confirms');
select is((select count(*)::int from notify.notifications where user_id = '00000000-0000-0000-0000-0000000002a1' and type = 'visit_confirmed'), 1, 'the seeker is notified');

-- 4. Applications
insert into k select 'a', pg_temp.call('application_create', :S, '{"params": {"id": "00000000-0000-0000-0000-0000000002b1"}, "body": {"message": "Je suis étudiant", "share_profile": true}}')#>>'{data,application_id}';
select is(pg_temp.call('application_create', :S, '{"params": {"id": "00000000-0000-0000-0000-0000000002b1"}, "body": {}}')#>>'{error,details,0,issue}', 'already_applied', 'one open application');
select is(pg_temp.call('applications_owner', :O, '{}')#>'{data,items,0,shared_profile,declared_preferences}', '{"smoking": "no"}', 'the owner sees the shared lifestyle fields');
select is(jsonb_array_length(pg_temp.call('applications_owner', :T, '{}')#>'{data,items}'), 0, 'a third user sees none');
select is(pg_temp.call('application_decide', :S, jsonb_build_object('params', jsonb_build_object('id', (select v from k where name = 'a')), 'body', '{"action": "accept"}'::jsonb))->>'status', '403',
          'the applicant cannot accept: wrong role');
select is(pg_temp.call('application_decide', :O, jsonb_build_object('params', jsonb_build_object('id', (select v from k where name = 'a')), 'body', '{"action": "accept"}'::jsonb))#>>'{data,status}', 'accepted',
          'the owner accepts');

-- 5. Blocks: the owner blocks the seeker; neither can write, a new application is refused
select is(pg_temp.call('block_put', :O, '{"body": {"user_id": "00000000-0000-0000-0000-0000000002a1"}}')#>>'{data,blocked}', 'true', 'the owner blocks the seeker');
select is(pg_temp.call('block_put', :O, '{"body": {"user_id": "00000000-0000-0000-0000-0000000002a3"}}')->>'status', '404', 'not someone unknown to them');
select is(pg_temp.call('message_send', :S, jsonb_build_object('params', jsonb_build_object('id', (select v from k where name = 'c')), 'body', '{"text": "?"}'::jsonb))#>>'{error,details,0,issue}', 'blocked',
          'the blocked seeker cannot write');
select is(pg_temp.call('message_send', :O, jsonb_build_object('params', jsonb_build_object('id', (select v from k where name = 'c')), 'body', '{"text": "?"}'::jsonb))#>>'{error,details,0,issue}', 'blocked',
          'nor the one who blocked');

-- 6. Reports
select is(pg_temp.call('report_create', :T, '{"body": {"target_type": "listing", "target_id": "00000000-0000-0000-0000-0000000002b1", "reason": "scam"}}')->>'status', '201', 'a listing is reported');

select * from finish();
rollback;
