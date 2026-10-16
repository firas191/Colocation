-- Migration 0022: the row-level layer of the platform (PLATFORM_SPEC 7.1, D-096) and the first api functions.
\ir helpers.psql
begin;
select plan(27);

insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, timezone)
values ('ZP', 'ZP', 'pgTAP platform', 'TND', 'fr', 'UTC');
insert into app.users (id, email, display_name, role, jurisdiction_code) values
  ('00000000-0000-0000-0000-0000000000e1', 'amel@example.test', 'Amel', 'user', 'ZP'),
  ('00000000-0000-0000-0000-0000000000e2', 'bilel@example.test', 'Bilel', 'user', 'ZP');
insert into app.consents (user_id, purpose, granted, policy_version, source) values
  ('00000000-0000-0000-0000-0000000000e1', 'terms', true, 'v1', 'web'),
  ('00000000-0000-0000-0000-0000000000e1', 'privacy', true, 'v1', 'web'),
  ('00000000-0000-0000-0000-0000000000e2', 'terms', true, 'v1', 'web');
insert into app.profiles (user_id, jurisdiction_code, budget_max_minor, currency, budget_period, declared_preferences, languages)
values ('00000000-0000-0000-0000-0000000000e1', 'ZP', 400000, 'TND', 'month', '{"smoking":"no","schedule":"early"}', '{fr,ar}');
insert into app.listings (owner_id, jurisdiction_code, status, description)
values ('00000000-0000-0000-0000-0000000000e2', 'ZP', 'draft', 'Brouillon');

-- 1. n8n_worker cannot reach the platform tables directly, even with BYPASSRLS.
select is(pg_temp.as_user('n8n_worker', '', 'select count(*) from notify.notifications'), 'ERROR 42501',
          'n8n_worker: no privilege on notify tables');
select is(pg_temp.as_user('n8n_worker', '', 'insert into notify.notifications (user_id, type) values (''00000000-0000-0000-0000-0000000000e1'', ''x_y'')'),
          'ERROR 42501', 'n8n_worker: cannot insert either');
select is(pg_temp.as_user('api_user', '00000000-0000-0000-0000-0000000000e1', 'select count(*) from notify.notifications'), 'ERROR 42501',
          'api_user: no privilege on notify tables');
select is(pg_temp.as_user('n8n_worker', '', 'select api._as(''00000000-0000-0000-0000-0000000000e1'')::text'), 'ERROR 42501',
          'n8n_worker cannot call api._as on its own');
select is((select rolbypassrls from pg_roles where rolname = 'app_rls'), false, 'app_rls does not bypass RLS');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'api' and p.proname not in ('_ok', '_err') and pg_get_userbyid(p.proowner) <> 'app_rls'), 0,
          'every api function is owned by app_rls');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'api' and has_function_privilege('public', p.oid, 'execute')), 0,
          'no api function is executable by PUBLIC');

-- 2. Notifications: a user sees only their own, through the functions, whatever the function is asked.
select is(pg_temp.as_user('n8n_worker', '', 'select api.notify_emit(''00000000-0000-0000-0000-0000000000e1'', ''welcome'', ''{"n": 1}'')::text'),
          'true', 'a workflow notifies Amel');
select is(pg_temp.as_user('n8n_worker', '', 'select api.notify_emit(''00000000-0000-0000-0000-0000000000e1'', ''visit_requested'', ''{}'', ''visit'', ''v1'')::text'),
          'true', 'and again');
select is(pg_temp.as_user('n8n_worker', '', 'select api.notify_emit(''00000000-0000-0000-0000-0000000000e2'', ''welcome'')::text'),
          'true', 'and Bilel once');
select is(pg_temp.as_user('n8n_worker', '', 'select api.notify_emit(''00000000-0000-0000-0000-00000000dead'', ''welcome'')::text'),
          'false', 'an unknown user gets nothing');
select is(pg_temp.as_user('n8n_worker', '', 'select api.notify_emit(''00000000-0000-0000-0000-0000000000e1'', ''Bad Type'')::text'),
          'ERROR 23514', 'type must be a code');
select is(pg_temp.as_user('n8n_worker', '', 'select api.notifications_list(''00000000-0000-0000-0000-0000000000e1'', ''{}'')#>>''{data,unread}'''),
          '2', 'Amel: two unread');
select is(pg_temp.as_user('n8n_worker', '', 'select jsonb_array_length(api.notifications_list(''00000000-0000-0000-0000-0000000000e2'', ''{}'')#>''{data,items}'')::text'),
          '1', 'Bilel: only his own');
select is(pg_temp.as_user('n8n_worker', '', 'select api.notifications_list(''00000000-0000-0000-0000-0000000000e1'', ''{"query": {"limit": 1}}'')#>>''{data,items,0,type}'''),
          'visit_requested', 'newest first');
select isnt(pg_temp.as_user('n8n_worker', '', 'select api.notifications_list(''00000000-0000-0000-0000-0000000000e1'', ''{"query": {"limit": 1}}'')#>>''{data,next_before}'''),
          null, 'a next page when there are more');
-- Bilel tries to mark Amel's notifications as read by id: nothing changes.
select is(pg_temp.as_user('n8n_worker', '', format('select api.notifications_read(%L, %L)#>>''{data,updated}''',
            '00000000-0000-0000-0000-0000000000e2',
            (select jsonb_build_object('body', jsonb_build_object('ids', jsonb_agg(id))) from notify.notifications where user_id = '00000000-0000-0000-0000-0000000000e1'))),
          '0', 'another user''s ids are not touched');
select is((select count(*)::int from notify.notifications where user_id = '00000000-0000-0000-0000-0000000000e1' and read_at is null), 2,
          'Amel still has two unread');
select is(pg_temp.as_user('n8n_worker', '', 'select api.notifications_read(''00000000-0000-0000-0000-0000000000e1'', ''{"body": {"all": true}}'')#>>''{data,updated}'''),
          '2', 'Amel marks all as read');
select is((select count(*)::int from notify.notifications where user_id = '00000000-0000-0000-0000-0000000000e2' and read_at is null), 1,
          'Bilel''s stays unread');

-- 3. GET /v1/me and GET /v1/profiles/me
select is(pg_temp.as_user('n8n_worker', '', 'select api.me(''00000000-0000-0000-0000-0000000000e2'')#>>''{data,consent_required}'''),
          '["privacy"]', 'Bilel: privacy still required');
select is(pg_temp.as_user('n8n_worker', '', 'select api.me(''00000000-0000-0000-0000-0000000000e2'')#>>''{data,flags,has_listings}'''),
          'true', 'Bilel has a draft listing');
select is(pg_temp.as_user('n8n_worker', '', 'select api.me(''00000000-0000-0000-0000-0000000000e1'')#>>''{data,flags,has_listings}'''),
          'false', 'Amel has none: Bilel''s draft is not counted for her');
select is(pg_temp.as_user('n8n_worker', '', 'select api.me(''00000000-0000-0000-0000-00000000dead'')->>''status'''),
          '404', 'unknown user');
select is(pg_temp.as_user('n8n_worker', '', 'select api.profile_get(''00000000-0000-0000-0000-0000000000e1'')#>>''{data,profile,declared_preferences,schedule}'''),
          'early', 'Amel reads her profile');
select is(pg_temp.as_user('n8n_worker', '', 'select api.profile_get(''00000000-0000-0000-0000-0000000000e2'')#>''{data,profile}'''),
          'null', 'Bilel has none, and does not get Amel''s');

-- 4. Erasure removes the notifications.
select app.erase_user('00000000-0000-0000-0000-0000000000e1');
select is((select count(*)::int from notify.notifications where user_id = '00000000-0000-0000-0000-0000000000e1'), 0,
          'erased user: notifications deleted');

select * from finish();
rollback;
