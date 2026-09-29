-- Tests for sec.verify_request and the idempotency functions (migration 0002).
-- The signature is recomputed here in SQL from the documented canonical form.
-- The contract tests (tests/contract) check the same thing from a Python client.
\ir helpers.psql
begin;
select plan(41);

create temp table t_client as select * from sec.create_api_client('test-client', 'pgTAP client');
select ok((select secret like 'fss_%' and length(secret) = 68 from t_client), 'create_api_client returns a fss_ secret of 64 hex chars');

create or replace function pg_temp.sign(p_secret text, p_ts text, p_method text, p_path text, p_query text,
  p_rid text, p_uid text, p_idem text, p_ip text, p_body text) returns text language sql as $$
  select encode(hmac(convert_to(
    'FS1-HMAC-SHA256' || E'\n' || p_ts || E'\n' || upper(p_method) || E'\n' || p_path || E'\n' || p_query || E'\n' ||
    p_rid || E'\n' || p_uid || E'\n' || p_idem || E'\n' || p_ip || E'\n' ||
    encode(sha256(convert_to(p_body, 'UTF8')), 'hex'), 'UTF8'), convert_to(p_secret, 'UTF8'), 'sha256'), 'hex')
$$;

-- a reusable valid request
create temp table r as select
  (select secret from t_client) as secret,
  floor(extract(epoch from now()))::bigint::text as ts,
  'POST'::text as method, '/v1/users/sync'::text as path, ''::text as query,
  '3f1c0000-0000-4000-8000-000000000001'::text as rid, ''::text as uid, 'idem-0001-abcdef'::text as idem,
  '203.0.113.7'::text as ip, '{"external_auth_id":"auth0|1"}'::text as body;

create or replace function pg_temp.v(p_key text, p_ts text, p_method text, p_path text, p_query text, p_rid text,
  p_uid text, p_idem text, p_ip text, p_body text, p_sig text) returns jsonb language sql as $$
  select sec.verify_request(p_key, p_ts, p_method, p_path, p_query, p_rid, p_uid, p_idem, p_ip,
                            encode(convert_to(p_body, 'UTF8'), 'base64'), p_sig)
$$;

select is((select pg_temp.v('test-client', ts, method, path, query, rid, uid, idem, ip, body,
            pg_temp.sign(secret, ts, method, path, query, rid, uid, idem, ip, body)) ->> 'ok' from r),
          'true', 'valid signed request accepted');
select is((select pg_temp.v('test-client', ts, method, path, query, rid, uid, idem, ip, body,
            pg_temp.sign(secret, ts, method, path, query, rid, uid, idem, ip, body)) ->> 'reason' from r),
          'replayed', 'same request id again is rejected as a replay');

-- every signed field is covered: change one, keep the old signature
select is((select pg_temp.v('test-client', ts, method, path, query, '3f1c0000-0000-4000-8000-000000000002', uid, idem, ip, body || ' ',
            pg_temp.sign(secret, ts, method, path, query, '3f1c0000-0000-4000-8000-000000000002', uid, idem, ip, body)) ->> 'reason' from r),
          'bad_signature', 'altered body rejected');
select is((select pg_temp.v('test-client', ts, method, '/v1/me', query, '3f1c0000-0000-4000-8000-000000000003', uid, idem, ip, body,
            pg_temp.sign(secret, ts, method, path, query, '3f1c0000-0000-4000-8000-000000000003', uid, idem, ip, body)) ->> 'reason' from r),
          'bad_signature', 'altered path rejected');
select is((select pg_temp.v('test-client', ts, 'DELETE', path, query, '3f1c0000-0000-4000-8000-000000000004', uid, idem, ip, body,
            pg_temp.sign(secret, ts, method, path, query, '3f1c0000-0000-4000-8000-000000000004', uid, idem, ip, body)) ->> 'reason' from r),
          'bad_signature', 'altered method rejected');
select is((select pg_temp.v('test-client', ts, method, path, query, '3f1c0000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-00000000000b', idem, ip, body,
            pg_temp.sign(secret, ts, method, path, query, '3f1c0000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-00000000000a', idem, ip, body)) ->> 'reason' from r),
          'bad_signature', 'altered X-User-Id rejected');
select is((select pg_temp.v('test-client', ts, method, path, query, '3f1c0000-0000-4000-8000-000000000006', uid, 'idem-other-key1', ip, body,
            pg_temp.sign(secret, ts, method, path, query, '3f1c0000-0000-4000-8000-000000000006', uid, idem, ip, body)) ->> 'reason' from r),
          'bad_signature', 'altered idempotency key rejected');
select is((select pg_temp.v('test-client', ts, method, path, 'a=1', '3f1c0000-0000-4000-8000-000000000007', uid, idem, ip, body,
            pg_temp.sign(secret, ts, method, path, query, '3f1c0000-0000-4000-8000-000000000007', uid, idem, ip, body)) ->> 'reason' from r),
          'bad_signature', 'altered query rejected');
select is((select pg_temp.v('test-client', ts, method, path, query, '3f1c0000-0000-4000-8000-000000000008', uid, idem, '198.51.100.1', body,
            pg_temp.sign(secret, ts, method, path, query, '3f1c0000-0000-4000-8000-000000000008', uid, idem, ip, body)) ->> 'reason' from r),
          'bad_signature', 'altered client ip rejected');
select is((select pg_temp.v('test-client', ts, method, path, query, '3f1c0000-0000-4000-8000-000000000009', uid, idem, ip, body,
            pg_temp.sign('fss_wrong', ts, method, path, query, '3f1c0000-0000-4000-8000-000000000009', uid, idem, ip, body)) ->> 'reason' from r),
          'bad_signature', 'signature made with another secret rejected');
select is((select pg_temp.v('test-client', ts, method, path, query, '3f1c0000-0000-4000-8000-00000000000a', uid, idem, ip, body,
            upper(pg_temp.sign(secret, ts, method, path, query, '3f1c0000-0000-4000-8000-00000000000a', uid, idem, ip, body))) ->> 'reason' from r),
          'bad_signature_format', 'uppercase hex signature rejected (format is lowercase hex)');

-- timestamps
select is((select pg_temp.v('test-client', (ts::bigint - 301)::text, method, path, query, '3f1c0000-0000-4000-8000-00000000000b', uid, idem, ip, body,
            pg_temp.sign(secret, (ts::bigint - 301)::text, method, path, query, '3f1c0000-0000-4000-8000-00000000000b', uid, idem, ip, body)) ->> 'reason' from r),
          'stale_timestamp', 'correctly signed but 301 s old: rejected');
select is((select pg_temp.v('test-client', (ts::bigint + 301)::text, method, path, query, '3f1c0000-0000-4000-8000-00000000000c', uid, idem, ip, body,
            pg_temp.sign(secret, (ts::bigint + 301)::text, method, path, query, '3f1c0000-0000-4000-8000-00000000000c', uid, idem, ip, body)) ->> 'reason' from r),
          'stale_timestamp', 'correctly signed but 301 s in the future: rejected');
select is((select pg_temp.v('test-client', (ts::bigint - 290)::text, method, path, query, '3f1c0000-0000-4000-8000-00000000000d', uid, idem, ip, body,
            pg_temp.sign(secret, (ts::bigint - 290)::text, method, path, query, '3f1c0000-0000-4000-8000-00000000000d', uid, idem, ip, body)) ->> 'ok' from r),
          'true', '290 s old: still inside the window');
select is((select pg_temp.v('test-client', '1e9', method, path, query, '3f1c0000-0000-4000-8000-00000000000e', uid, idem, ip, body, repeat('0',64)) ->> 'reason' from r),
          'bad_timestamp', 'non-numeric timestamp rejected');

-- keys, headers, encoding
select is((select pg_temp.v('nobody', ts, method, path, query, '3f1c0000-0000-4000-8000-000000000010', uid, idem, ip, body, repeat('0',64)) ->> 'reason' from r),
          'unknown_key', 'unknown key id rejected');
update sec.api_clients set active = false where key_id = 'test-client';
select is((select pg_temp.v('test-client', ts, method, path, query, '3f1c0000-0000-4000-8000-000000000011', uid, idem, ip, body,
            pg_temp.sign(secret, ts, method, path, query, '3f1c0000-0000-4000-8000-000000000011', uid, idem, ip, body)) ->> 'reason' from r),
          'unknown_key', 'deactivated key rejected even with a correct signature');
update sec.api_clients set active = true where key_id = 'test-client';
select is((select pg_temp.v('test-client', ts, method, E'/v1/users/sync\nX', query, '3f1c0000-0000-4000-8000-000000000012', uid, idem, ip, body, repeat('0',64)) ->> 'reason' from r),
          'control_character', 'newline in a signed field rejected');
select is((select pg_temp.v('test-client', ts, method, path, query, 'not-a-uuid', uid, idem, ip, body, repeat('0',64)) ->> 'reason' from r),
          'bad_request_id', 'request id must be a uuid');
select is((select sec.verify_request('test-client', ts, method, path, query, '3f1c0000-0000-4000-8000-000000000013', uid, idem, ip, '***', repeat('0',64)) ->> 'reason' from r),
          'bad_body_encoding', 'body that is not base64 rejected');
select is((select sec.verify_request('test-client', ts, method, path, query, '3f1c0000-0000-4000-8000-000000000014', uid, idem, ip, '', null) ->> 'reason' from r),
          'missing_header', 'missing signature rejected');
select is((select pg_temp.v('test-client', ts, 'GET', '/v1/health', '', '3f1c0000-0000-4000-8000-000000000015', '', '', '', '',
            pg_temp.sign(secret, ts, 'GET', '/v1/health', '', '3f1c0000-0000-4000-8000-000000000015', '', '', '', '')) ->> 'ok' from r),
          'true', 'GET with empty body and no optional headers accepted');

-- nonce cleanup
insert into sec.request_nonces(key_id, request_id, seen_at) values ('test-client', gen_random_uuid(), now() - interval '1 hour');
select is((select pg_temp.v('test-client', ts, 'GET', '/v1/health', '', '3f1c0000-0000-4000-8000-000000000016', '', '', '', '',
            pg_temp.sign(secret, ts, 'GET', '/v1/health', '', '3f1c0000-0000-4000-8000-000000000016', '', '', '', '')) ->> 'ok' from r),
          'true', 'another valid request');
select is((select count(*)::int from sec.request_nonces where seen_at < now() - interval '30 minutes'), 0, 'old nonces are purged');

-- privileges
select is(pg_temp.as_user('api_user', '', $$select sec.verify_request('a','1','GET','/','','x','','','','','x')::text$$), 'ERROR 42501', 'api_user cannot call verify_request');
select is(pg_temp.as_user('n8n_worker', '', 'select count(*)::text from sec.api_clients'), 'ERROR 42501', 'n8n_worker cannot read client secrets');
select is(pg_temp.as_user('n8n_worker', '', $$select sec.create_api_client('x-client','x')::text$$), 'ERROR 42501', 'n8n_worker cannot issue keys');
select is(pg_temp.as_user('n8n_worker', '', $$select (sec.verify_request('nobody','1','GET','/','','3f1c0000-0000-4000-8000-000000000099','','','','',repeat('0',64))->>'reason')$$),
          'unknown_key', 'n8n_worker can call verify_request');

-- shared signing vectors (tests/vectors/signing.json): the database agrees with the Python and JS clients
insert into sec.api_clients(key_id,name,secret) values ('vector-client','vectors',convert_to('fss_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef','UTF8'));
select is(sec.verify_request('vector-client','1790000000','GET','/v1/health','','3f1c0000-0000-4000-8000-000000000001','','','',
          encode(convert_to('','UTF8'),'base64'),'f0ec8772a5ce1e845c4725885b647a86e1ab39a90ce592d898abbcee7a6d1115', 1000000000)->>'ok', 'true', 'vector get_no_body verifies');
select is(sec.verify_request('vector-client','1790000000','POST','/v1/users/sync','','3f1c0000-0000-4000-8000-000000000002','','idem-0001-abcdef','203.0.113.7',
          encode(convert_to('{"external_auth_id":"auth0|1","display_name":"فراس"}','UTF8'),'base64'),'87feb7ac821459042fcd96b3ba5675e8be1844d797628a834f29cb75e07b05f7', 1000000000)->>'ok', 'true', 'vector post_json_unicode verifies');
select is(sec.verify_request('vector-client','1790000000','GET','/v1/search','a=x%20y%26z%3D%C3%A9&a=2&b=*()!''~&z=1','3f1c0000-0000-4000-8000-000000000003','00000000-0000-0000-0000-00000000000a','','',
          encode(convert_to('','UTF8'),'base64'),'10bdca8bbac0702c3d3020b5e762a68663c79d71403259d6b4c15bc0f91cf328', 1000000000)->>'ok', 'true', 'vector query_repeated_reserved verifies');
select is(sec.verify_request('vector-client','1790000000','PATCH','/v1/listings/10000000-0000-0000-0000-000000000001','','3f1c0000-0000-4000-8000-000000000004','00000000-0000-0000-0000-00000000000a','patch:0001-x','',
          encode(convert_to('{"title":"a"}','UTF8'),'base64'),'cc647784861807e1d4a8588661b8fe12cdb3a0e454b2d616a4975b314e3b9681', 1000000000)->>'ok', 'true', 'vector path_param verifies');

-- idempotency
select is(app.idempotency_begin('k:anon', 'idem-0001-abcdef', 'POST /v1/users/sync', repeat('a',64)) ->> 'state', 'new', 'idempotency: first use is new');
select is(app.idempotency_begin('k:anon', 'idem-0001-abcdef', 'POST /v1/users/sync', repeat('a',64)) ->> 'state', 'in_progress', 'idempotency: concurrent retry sees in_progress');
select is(app.idempotency_begin('k:anon', 'idem-0001-abcdef', 'POST /v1/users/sync', repeat('b',64)) ->> 'state', 'conflict', 'idempotency: same key, different body is a conflict');
do $$ begin perform app.idempotency_complete('k:anon', 'idem-0001-abcdef', 200, '{"request_id":"x","data":{"user_id":"u1"}}', null); end $$;
select is(app.idempotency_begin('k:anon', 'idem-0001-abcdef', 'POST /v1/users/sync', repeat('a',64)),
          '{"state":"replay","response_status":200,"response_body":{"request_id":"x","data":{"user_id":"u1"}}}'::jsonb,
          'idempotency: finished request replays the stored response');
select is(app.idempotency_begin('k:anon', 'idem-0001-abcdef', 'POST /v1/me/consents', repeat('a',64)) ->> 'state', 'conflict', 'idempotency: same key on another route is a conflict');
select is(app.idempotency_begin('k:other', 'idem-0001-abcdef', 'POST /v1/users/sync', repeat('a',64)) ->> 'state', 'new', 'idempotency: keys are scoped per client and user');
update app.idempotency_keys set created_at = now() - interval '10 minutes' where scope = 'k:other';
select is(app.idempotency_begin('k:other', 'idem-0001-abcdef', 'POST /v1/users/sync', repeat('a',64)) ->> 'took_over', 'true', 'idempotency: stale in_progress row is taken over');
do $$ begin perform app.idempotency_release('k:other', 'idem-0001-abcdef'); end $$;
select is(app.idempotency_begin('k:other', 'idem-0001-abcdef', 'POST /v1/users/sync', repeat('a',64)) ->> 'state', 'new', 'idempotency: released key can be reused');

select * from finish();
rollback;
