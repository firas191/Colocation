-- app.settings and app.gateway_context (migration 0004).
\ir helpers.psql
begin;
select plan(11);

insert into app.users(id,email,role) values ('00000000-0000-0000-0000-00000000000a','a@example.com','owner');
insert into app.consents(user_id,purpose,granted,policy_version,granted_at) values
 ('00000000-0000-0000-0000-00000000000a','terms',true,'t1', now() - interval '2 days'),
 ('00000000-0000-0000-0000-00000000000a','cloud_llm_processing',true,'c1', now() - interval '2 days'),
 ('00000000-0000-0000-0000-00000000000a','cloud_llm_processing',false,'c1', now() - interval '1 day');

select is(app.gateway_context(null)->'user', 'null'::jsonb, 'no user id: user is null');
select is(app.gateway_context('not-a-uuid')->'user', 'null'::jsonb, 'malformed user id: null, no exception');
select is(app.gateway_context('00000000-0000-0000-0000-0000000000ff')->'user', 'null'::jsonb, 'unknown user id: null');
select is(app.gateway_context('00000000-0000-0000-0000-00000000000a')->'user'->>'role', 'owner', 'known user: role returned');
select is(app.gateway_context('00000000-0000-0000-0000-00000000000a')->'consents',
          '{"terms": true, "cloud_llm_processing": false}'::jsonb, 'latest consent row per purpose wins (withdrawal respected)');
select is(app.gateway_context(null)->'settings'->>'gateway.max_skew_s', '300', 'gateway settings included');
select is((select count(*)::int from jsonb_object_keys(app.gateway_context(null)->'settings') k where k not like 'gateway.%'), 0, 'only gateway.* settings exposed to the gateway');
update app.users set deleted_at = now() where id = '00000000-0000-0000-0000-00000000000a';
select is(app.gateway_context('00000000-0000-0000-0000-00000000000a')->'user'->>'deleted', 'true', 'erased user flagged as deleted');
select throws_ok($$ insert into app.settings(key,value) values ('NoDots','1') $$, '23514', null, 'settings keys must be dotted lowercase');
select is(pg_temp.as_user('api_user', '', 'select count(*)::text from app.settings'), 'ERROR 42501', 'api_user cannot read settings');
select is(pg_temp.as_user('n8n_worker', '', $$select (app.gateway_context(null)->'settings'->>'gateway.rate_limit_user_per_min')$$), '60', 'n8n_worker can call gateway_context');

select * from finish();
rollback;
