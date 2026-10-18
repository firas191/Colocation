-- Migration 0032: notification preferences and deliveries, Telegram link codes, admin settings and roles (D-110).
\ir helpers.psql
begin;
select plan(20);

insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, timezone)
values ('ZN', 'ZN', 'pgTAP channels', 'TND', 'fr', 'UTC');
insert into app.users (id, email, display_name, role, jurisdiction_code, telegram_chat_id) values
  ('00000000-0000-0000-0000-0000000009a1', 'a-p11@example.test', 'Amel', 'user', 'ZN', null),
  ('00000000-0000-0000-0000-0000000009a2', 'b-p11@example.test', 'Bilel', 'user', 'ZN', 5551),
  ('00000000-0000-0000-0000-0000000009a3', 'm-p11@example.test', 'Mehdi', 'moderator', 'ZN', null),
  ('00000000-0000-0000-0000-0000000009a4', 'z-p11@example.test', 'Zied', 'admin', 'ZN', null);
create or replace function pg_temp.call(p_fn text, p_user text, p jsonb) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  execute 'set local role n8n_worker';
  execute format('select api.%I(%L::uuid, %L::jsonb)', p_fn, p_user, p) into r;
  reset role;
  return r;
end $$;
\set A '''00000000-0000-0000-0000-0000000009a1'''
\set B '''00000000-0000-0000-0000-0000000009a2'''
\set M '''00000000-0000-0000-0000-0000000009a3'''
\set Z '''00000000-0000-0000-0000-0000000009a4'''
update notify.deliveries set status = 'sent' where status in ('queued', 'sending');   -- other tests' rows stay out of the way

-- 1. Preferences
select is(pg_temp.call('notify_prefs_get', :A, '{}')#>>'{data,email}', 'true', 'e-mail on by default');
select is(pg_temp.call('notify_prefs_put', :A, '{"body": {"email": true, "telegram": true, "muted": ["message_received"]}}')#>>'{data,muted,0}',
          'message_received', 'a type muted');

-- 2. Deliveries follow the preferences and the channels each person has
create temp table emitted as select api.notify_emit(:A, 'message_received', '{"from": "X"}') union all
  select api.notify_emit(:A, 'listing_published', '{"title": "T"}') union all select api.notify_emit(:B, 'listing_published', '{"title": "T"}');
create temp table t as select app.deliveries_take(50) as r;
select is((select count(*)::int from t, jsonb_array_elements(r->'deliveries') d where d->>'type' = 'message_received'), 0, 'a muted type is not sent');
select is((select string_agg(d->>'channel', ',' order by d->>'channel') from t, jsonb_array_elements(r->'deliveries') d
            where d->>'email' = 'a-p11@example.test'), 'email', 'Amel: e-mail only (no Telegram linked)');
select is((select string_agg(d->>'channel', ',' order by d->>'channel') from t, jsonb_array_elements(r->'deliveries') d
            where d->>'email' = 'b-p11@example.test'), 'email,telegram', 'Bilel: e-mail and Telegram');
select is((select jsonb_array_length(app.deliveries_take(50)->'deliveries')), 0, 'each delivery is handed out once');

-- 3. Retries: after 1, 2, 4, 8 minutes, failed after the fifth attempt
create temp table ids as select (d->>'delivery_id')::bigint as id, d->>'channel' as ch, d->>'email' as em from t, jsonb_array_elements(r->'deliveries') d;
create temp table d1 as select app.deliveries_done((select jsonb_agg(jsonb_build_object('delivery_id', id, 'ok', ch = 'email', 'error', 'chat not found')) from ids));
select is((select status from notify.deliveries where id = (select id from ids where ch = 'telegram')), 'queued', 'a failure goes back to the queue');
select ok((select next_attempt_at > now() + interval '50 seconds' from notify.deliveries where id = (select id from ids where ch = 'telegram')), 'one minute later');
select is((select count(*)::int from notify.deliveries where id in (select id from ids where ch = 'email') and status = 'sent'), 2, 'e-mails sent');
update notify.deliveries set attempts = 5, status = 'sending' where id = (select id from ids where ch = 'telegram');
create temp table d2 as select app.deliveries_done((select jsonb_agg(jsonb_build_object('delivery_id', id, 'ok', false, 'error', 'chat not found')) from ids where ch = 'telegram'));
select is((select status || ':' || last_error from notify.deliveries where id = (select id from ids where ch = 'telegram')), 'failed:chat not found',
          'the fifth failure is final, with its reason');

-- 4. Telegram link codes: once, before they expire
create temp table c as select pg_temp.call('telegram_link_create', :A, '{}') as r;
select is(app.telegram_link_redeem('WRONG', 42)->>'error_code', 'unknown_code', 'an unknown code');
select is(app.telegram_link_redeem(lower((select r#>>'{data,code}' from c)), 4242)->>'ok', 'true', 'the code links the chat (case does not matter)');
select is((select telegram_chat_id from app.users where id = :A), 4242::bigint, 'Amel is linked');
select is(app.telegram_link_redeem((select r#>>'{data,code}' from c), 4242)->>'error_code', 'used', 'used once');
select is(pg_temp.call('telegram_unlink', :A, '{}')#>>'{data,telegram_linked}', 'false', 'and unlinked');

-- 5. Admin: the settings allowlist with types, roles, the audit log
select is(app.admin_settings_list(:M, '{}')->>'status', '403', 'a moderator does not change settings');
select is(app.admin_setting_put(:Z, '{"params": {"key": "llm.default_model"}, "body": {"value": "x"}}')#>>'{error,details,0,issue}', 'not_on_allowlist',
          'a key outside the allowlist is refused');
select is(app.admin_setting_put(:Z, '{"params": {"key": "reports.per_hour"}, "body": {"value": 5000}}')#>>'{error,details,0,issue}', 'invalid_for_type',
          'a value outside the range is refused');
select is(app.admin_setting_put(:Z, '{"params": {"key": "trust.agent_enabled"}, "body": {"value": false}}')#>>'{data,value}', 'false', 'an allowed change');
select is(app.admin_user_role(:Z, jsonb_build_object('params', jsonb_build_object('id', :Z), 'body', '{"role": "user"}'::jsonb))->>'status', '409',
          'an admin cannot change their own role');

select * from finish();
rollback;
