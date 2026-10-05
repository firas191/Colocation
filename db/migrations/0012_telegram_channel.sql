-- migrate:up
-- Telegram channel (spec 5.1, 8.4 wf.channel.telegram) and the two API routes it needs from spec 6.2:
-- POST /v1/me/consents and GET /v1/admin/traces/:request_id. docs/DECISIONS.md D-079.

-- 1. Settings ------------------------------------------------------------------
insert into app.settings (key, value, description) values
  ('services.api_url', '"http://proxy:8080"', 'Base URL of the public API as seen from n8n (the Telegram channel calls it like any client)'),
  ('telegram.policy_version', '"telegram-test-2026-10"', 'Policy version recorded with the consents given in the Telegram bot'),
  ('telegram.default_jurisdiction', '"TN"', 'Jurisdiction of a Telegram user until they choose one with /country'),
  ('telegram.job_wait_s', '300', 'How long the bot waits for a listing analysis before telling the user to check later')
on conflict (key) do nothing;

-- 2. Internal API clients: their secret never leaves the database ------------------
-- The Telegram channel runs inside n8n and calls the public API like any client, so the gateway's checks
-- (signature, rate limits, consent) apply to it. Its requests are signed by sec.sign_internal, which only
-- signs for keys marked internal; n8n never sees the secret.
alter table sec.api_clients add column internal boolean not null default false;
insert into sec.api_clients (key_id, name, secret, internal)
values ('telegram', 'Telegram channel (n8n; signed inside the database)',
        convert_to('fss_' || encode(public.gen_random_bytes(32), 'hex'), 'UTF8'), true)
on conflict (key_id) do nothing;

create or replace function sec.sign_internal(p_key_id text, p_method text, p_path text, p_request_id text,
                                             p_user_id text, p_idempotency_key text, p_body text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_secret bytea; v_ts text := floor(extract(epoch from clock_timestamp()))::bigint::text; v_canonical text;
begin
  select c.secret into v_secret from sec.api_clients c
   where c.key_id = p_key_id and c.internal and c.active and c.revoked_at is null;
  if v_secret is null then
    raise exception 'sec.sign_internal: % is not an active internal client', p_key_id using errcode = '42501';
  end if;
  v_canonical := 'FS1-HMAC-SHA256' || E'\n' || v_ts || E'\n' || upper(p_method) || E'\n' || p_path || E'\n' || '' || E'\n' ||
                 p_request_id || E'\n' || coalesce(p_user_id, '') || E'\n' || coalesce(p_idempotency_key, '') || E'\n' ||
                 '' || E'\n' || encode(sha256(convert_to(coalesce(p_body, ''), 'UTF8')), 'hex');
  return jsonb_build_object('timestamp', v_ts,
                            'signature', encode(public.hmac(convert_to(v_canonical, 'UTF8'), v_secret, 'sha256'), 'hex'));
end $$;
alter function sec.sign_internal(text, text, text, text, text, text, text) owner to sec_owner;
revoke all on function sec.sign_internal(text, text, text, text, text, text, text) from public;
grant execute on function sec.sign_internal(text, text, text, text, text, text, text) to n8n_worker;

-- 2b. Telegram updates already handled: the relay may hand the same update over twice (a restart before
--     Telegram saw the confirmation); n8n handles an update_id once per bot. bot is a hash of the token sent by the
--     relay: a new bot's update ids can overlap with the old bot's (F-060). Rows older than two days are trimmed.
create table app.telegram_updates (
  bot         text   not null,
  update_id   bigint not null,
  received_at timestamptz not null default now(),
  primary key (bot, update_id)
);
grant select, insert, delete on app.telegram_updates to n8n_worker;

-- 3. Consents (POST /v1/me/consents, spec 13.4: the latest row per user and purpose wins) -------
create or replace function app.record_consents(p_user uuid, p jsonb) returns jsonb
language plpgsql as $$
declare c jsonb;
begin
  for c in select * from jsonb_array_elements(p->'consents') loop
    insert into app.consents (user_id, purpose, granted, policy_version, source)
    values (p_user, c->>'purpose', (c->>'granted')::boolean, p->>'policy_version', coalesce(p->>'source', 'web'));
  end loop;
  insert into app.audit_log (actor_id, action, entity, entity_id)
  values (p_user, 'consents_recorded', 'user', p_user::text);
  return coalesce((select jsonb_object_agg(x.purpose, jsonb_build_object('granted', x.granted, 'policy_version', x.policy_version,
                                                                         'granted_at', x.granted_at))
                     from (select distinct on (purpose) purpose, granted, policy_version, granted_at
                             from app.consents where user_id = p_user order by purpose, granted_at desc, id desc) x), '{}'::jsonb);
end $$;

-- 4. Trace of one request (GET /v1/admin/traces/:request_id, spec 8.3): executions and their agent steps.
--    Steps hold no raw user text (D-062); the route is for admins only.
create or replace function ai.trace(p_request_id uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object('request_id', p_request_id, 'executions', coalesce(jsonb_agg(jsonb_build_object(
      'workflow', e.workflow, 'channel', e.channel, 'status', e.status, 'started_at', e.started_at,
      'latency_ms', e.latency_ms, 'tokens_in', e.tokens_in, 'tokens_out', e.tokens_out, 'error', e.error,
      'steps', coalesce((select jsonb_agg(jsonb_build_object('index', s.step_index, 'agent', s.agent, 'model', s.model,
                                   'prompt', p.name, 'prompt_version', v.version, 'input', s.input, 'output', s.output,
                                   'latency_ms', s.latency_ms, 'tokens_in', s.tokens_in, 'tokens_out', s.tokens_out,
                                   'error', s.error) order by s.step_index)
                         from ai.agent_steps s left join ai.prompt_versions v on v.id = s.prompt_version_id
                         left join ai.prompts p on p.id = v.prompt_id where s.execution_id = e.id), '[]'::jsonb))
      order by e.started_at), '[]'::jsonb))
  from ai.executions e where e.request_id = p_request_id
$$;

-- 5. Grants (n8n only; PUBLIC loses the default EXECUTE, D-013) ------------------------
revoke execute on function app.record_consents(uuid, jsonb), ai.trace(uuid) from public;
grant execute on function app.record_consents(uuid, jsonb), ai.trace(uuid) to n8n_worker;

-- migrate:down
drop table if exists app.telegram_updates;
drop function if exists ai.trace(uuid);
drop function if exists app.record_consents(uuid, jsonb);
drop function if exists sec.sign_internal(text, text, text, text, text, text, text);
delete from sec.api_clients where key_id = 'telegram';
alter table sec.api_clients drop column if exists internal;
delete from app.settings where key in ('services.api_url', 'telegram.policy_version', 'telegram.default_jurisdiction',
                                       'telegram.job_wait_s');
