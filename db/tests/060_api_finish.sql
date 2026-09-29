-- app.api_finish (migration 0006).
\ir helpers.psql
begin;
select plan(8);

insert into app.users(id,email) values ('00000000-0000-0000-0000-00000000000a','a@example.com');
select app.idempotency_begin('k:anon','idem-finish-01','POST /v1/users/sync',repeat('a',64)) is not null as began \gset
select app.idempotency_begin('k:anon','idem-finish-02','POST /v1/users/sync',repeat('a',64)) is not null as began \gset

select lives_ok($$ select app.api_finish('{"request_id":"3f1c0000-0000-4000-8000-000000000101","workflow":"wf.api.users_sync","status_code":201,"latency_ms":42,
  "idempotency":{"scope":"k:anon","key":"idem-finish-01"},"response_body":{"data":{"user_id":"00000000-0000-0000-0000-00000000000a"}},
  "result_user_id":"00000000-0000-0000-0000-00000000000a","user_id":""}') $$, 'finish a 201 request');
select is((select state from app.idempotency_keys where idem_key = 'idem-finish-01'), 'completed', '2xx completes the idempotency record');
select is((select user_id::text from app.idempotency_keys where idem_key = 'idem-finish-01'), '00000000-0000-0000-0000-00000000000a', 'result user id stored for erasure');
select is((select status || ' ' || latency_ms from ai.executions where request_id = '3f1c0000-0000-4000-8000-000000000101'), 'succeeded 42', 'execution row written');

select lives_ok($$ select app.api_finish('{"request_id":"3f1c0000-0000-4000-8000-000000000102","workflow":"wf.api.users_sync","status_code":503,"latency_ms":5,
  "error_code":"UPSTREAM_UNAVAILABLE","idempotency":{"scope":"k:anon","key":"idem-finish-02"},"user_id":"not-a-uuid"}') $$, 'finish a 503 request with a malformed user id');
select is((select count(*)::int from app.idempotency_keys where idem_key = 'idem-finish-02'), 0, '5xx releases the key so the client can retry');
select is((select status || ' ' || error from ai.executions where request_id = '3f1c0000-0000-4000-8000-000000000102'), 'failed UPSTREAM_UNAVAILABLE', '5xx logged as failed with the error code');
select is(pg_temp.as_user('n8n_worker', '', 'select count(*)::text from public.schema_migrations'), (select count(*)::text from public.schema_migrations), 'n8n_worker can read the migration version');

select * from finish();
rollback;
