-- app.rate_hit and app.gateway_check (migration 0005).
\ir helpers.psql
begin;
select plan(12);

select is(app.rate_hit('t:a'), 1, 'first hit in a window is 1');
select is(app.rate_hit('t:a'), 2, 'second hit is 2');
select is(app.rate_hit('t:b'), 1, 'keys are independent');
insert into app.rate_counters values ('t:old:1', 5, now() - interval '1 hour');
select is((select count(*)::int from app.rate_counters where bucket like 't:a:%' and expires_at > now() + interval '100 seconds'), 1, 'bucket expires after two windows');

create temp table t_client as select * from sec.create_api_client('gw-client', 'gateway_check test');
insert into app.users(id,email) values ('00000000-0000-0000-0000-00000000000a','a@example.com');

create or replace function pg_temp.req(p_rid text, p_uid text, p_sig_ok boolean) returns jsonb language sql as $$
  with c as (select secret from t_client), t as (select floor(extract(epoch from now()))::bigint::text ts)
  select app.gateway_check(jsonb_build_object(
    'key_id','gw-client','timestamp',t.ts,'method','GET','path','/v1/health','query','',
    'request_id',p_rid,'user_id',p_uid,'idempotency_key','','body_b64','',
    'client_ip','','network_ip','198.51.100.9',
    'signature', case when p_sig_ok then encode(hmac(convert_to('FS1-HMAC-SHA256'||E'\n'||t.ts||E'\nGET\n/v1/health\n\n'||p_rid||E'\n'||p_uid||E'\n\n\n'||
                   encode(sha256(''::bytea),'hex'),'UTF8'), convert_to(c.secret,'UTF8'),'sha256'),'hex') else repeat('0',64) end))
  from c, t
$$;

select is(pg_temp.req('3f1c0000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-00000000000a', true)->'verify'->>'ok', 'true', 'gateway_check verifies a good signature');
select is(pg_temp.req('3f1c0000-0000-4000-8000-0000000000a2', '00000000-0000-0000-0000-00000000000a', true)->'rate'->>'user', '2', 'user counter counts verified requests');
select is(pg_temp.req('3f1c0000-0000-4000-8000-0000000000a3', '00000000-0000-0000-0000-00000000000a', false)->'rate'->>'user', null, 'user counter ignores failed signatures');
select is(pg_temp.req('3f1c0000-0000-4000-8000-0000000000a4', '00000000-0000-0000-0000-00000000000a', false)->'rate'->>'ip', '4', 'ip counter counts every request, including failed ones');
select is(pg_temp.req('3f1c0000-0000-4000-8000-0000000000a5', '00000000-0000-0000-0000-00000000000a', true)->'context'->'user'->>'id',
          '00000000-0000-0000-0000-00000000000a', 'user context returned with the check');
-- an unsigned X-Client-Ip must not choose the rate-limit bucket
select is((select app.gateway_check(jsonb_build_object('key_id','gw-client','timestamp',floor(extract(epoch from now()))::bigint::text,
            'method','GET','path','/v1/health','query','','request_id','3f1c0000-0000-4000-8000-0000000000a6','user_id','',
            'idempotency_key','','client_ip','192.0.2.44','network_ip','198.51.100.9','body_b64','','signature',repeat('0',64)))->'rate'->>'ip'),
          '6', 'failed signature: counted on the network IP bucket');
select is((select count(*)::int from app.rate_counters where bucket like 'ip:192.0.2.44:%'), 0, 'failed signature: spoofed X-Client-Ip bucket untouched');
select is(pg_temp.as_user('api_user', '', $$select app.gateway_check('{}')::text$$), 'ERROR 42501', 'api_user cannot call gateway_check');

select * from finish();
rollback;
