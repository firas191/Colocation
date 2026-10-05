-- Migration 0012: internal signing for the Telegram channel, consents, request traces.
\ir helpers.psql
begin;
select plan(14);

-- internal signing: a request signed by sec.sign_internal passes the gateway's own check
create temp table t_sig as select gen_random_uuid()::text as rid, '{"text":"chambre à Sousse"}'::text as body,
  sec.sign_internal('telegram', 'post', '/v1/assistant/message', null, '00000000-0000-0000-0000-0000000000c1', 'idem-1', '{"text":"chambre à Sousse"}') as s;
update t_sig set s = sec.sign_internal('telegram', 'post', '/v1/assistant/message', rid, '00000000-0000-0000-0000-0000000000c1', 'idem-1', body);
select is((select (sec.verify_request('telegram', s->>'timestamp', 'POST', '/v1/assistant/message', '', rid,
             '00000000-0000-0000-0000-0000000000c1', 'idem-1', '', encode(convert_to(body, 'UTF8'), 'base64'), s->>'signature'))->>'ok'
           from t_sig), 'true', 'a request signed inside the database passes verify_request (UTF-8 body)');
select is((select (sec.verify_request('telegram', s->>'timestamp', 'POST', '/v1/assistant/message', '', gen_random_uuid()::text,
             '00000000-0000-0000-0000-0000000000c1', 'idem-1', '', encode(convert_to(body, 'UTF8'), 'base64'), s->>'signature'))->>'reason'
           from t_sig), 'bad_signature', 'the request id is covered by the signature');
select is((select (sec.verify_request('telegram', s->>'timestamp', 'POST', '/v1/assistant/message', '', rid,
             '00000000-0000-0000-0000-0000000000c2', 'idem-1', '', encode(convert_to(body, 'UTF8'), 'base64'), s->>'signature'))->>'reason'
           from t_sig), 'bad_signature', 'so is the user id');
select throws_ok($$select sec.sign_internal('website', 'GET', '/v1/health', gen_random_uuid()::text, null, null, '')$$, '42501', null,
  'only internal clients can be signed for');
select is((select internal from sec.api_clients where key_id = 'telegram'), true, 'the telegram client is internal');
select is(pg_temp.as_user('api_user', '00000000-0000-0000-0000-0000000000c1',
  $$select sec.sign_internal('telegram', 'GET', '/v1/health', gen_random_uuid()::text, null, null, '')$$), 'ERROR 42501',
  'api_user cannot sign');

-- consents: the latest row per purpose wins
insert into app.users (id, external_auth_id, role) values ('00000000-0000-0000-0000-0000000000c1', 'telegram:111', 'user');
select is(app.record_consents('00000000-0000-0000-0000-0000000000c1',
  '{"consents":[{"purpose":"terms","granted":true},{"purpose":"privacy","granted":true}],"policy_version":"t1","source":"telegram"}')
  #>> '{privacy,granted}', 'true', 'consents recorded');
select is(app.record_consents('00000000-0000-0000-0000-0000000000c1',
  '{"consents":[{"purpose":"privacy","granted":false}],"policy_version":"t2","source":"telegram"}') #>> '{privacy,policy_version}',
  't2', 'a later row replaces the earlier one');
select is((select count(*)::int from app.consents where user_id = '00000000-0000-0000-0000-0000000000c1' and source = 'telegram'), 3,
  'every change is kept as a row (consent log)');
select throws_ok($$select app.record_consents('00000000-0000-0000-0000-0000000000c1',
  '{"consents":[{"purpose":"spam","granted":true}],"policy_version":"t3"}')$$, '23514', null, 'unknown purpose refused by the table');

-- trace
insert into ai.executions (id, request_id, workflow, user_id, channel, status, latency_ms)
values ('00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000d9', 'wf.orchestrator',
        '00000000-0000-0000-0000-0000000000c1', 'api', 'succeeded', 1200);
insert into ai.agent_steps (execution_id, step_index, agent, model, input, output, latency_ms)
values ('00000000-0000-0000-0000-0000000000e9', 1, 'A0_orchestrator', 'm', '{"chars":10}', '{"intent":"search_listings"}', 900),
       ('00000000-0000-0000-0000-0000000000e9', 0, 'A0_text', null, '{"chars":10}', '{"language":"fr"}', 3);
select is((select jsonb_path_query_array(ai.trace('00000000-0000-0000-0000-0000000000d9'), '$.executions[0].steps[*].agent')),
  '["A0_text", "A0_orchestrator"]'::jsonb, 'trace lists the steps in order');
select is(jsonb_array_length(ai.trace(gen_random_uuid())->'executions'), 0, 'unknown request: empty trace');

-- handled update ids are kept per bot (F-060)
insert into app.telegram_updates (bot, update_id) values ('aaaaaaaaaaaaaaaa', 500);
insert into app.telegram_updates (bot, update_id) values ('aaaaaaaaaaaaaaaa', 500) on conflict do nothing;
select is((select count(*)::int from app.telegram_updates where bot = 'aaaaaaaaaaaaaaaa' and update_id = 500), 1,
  'the same update from the same bot is kept once');
insert into app.telegram_updates (bot, update_id) values ('bbbbbbbbbbbbbbbb', 500) on conflict do nothing;
select is((select count(*)::int from app.telegram_updates where update_id = 500), 2, 'the same update id from another bot is new');

select * from finish();
rollback;
