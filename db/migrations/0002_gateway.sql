-- migrate:up
-- Gateway support: API client secrets, replay nonces, idempotency records.
-- See docs/DECISIONS.md D-006 (signature covers method, path, user, key) and D-007 (secrets stay in the database).

create schema if not exists sec;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'sec_owner') then
    create role sec_owner nologin;
  end if;
end $$;
revoke all on schema sec from public;
grant usage on schema sec to sec_owner;

-- One row per calling server (website BFF, test client). The secret string is
-- the HMAC key (its UTF-8 bytes). Nobody except sec_owner can read this table.
create table sec.api_clients (
  key_id     text primary key check (key_id ~ '^[a-z0-9][a-z0-9_-]{2,39}$'),
  name       text not null,
  secret     bytea not null check (length(secret) >= 32),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- Request ids already accepted. Kept a little longer than the timestamp window,
-- so a captured request cannot be replayed while its timestamp is still valid.
create table sec.request_nonces (
  key_id     text not null,
  request_id uuid not null,
  seen_at    timestamptz not null default now(),
  primary key (key_id, request_id)
);
create index request_nonces_seen_at on sec.request_nonces (seen_at);

alter table sec.api_clients owner to sec_owner;
alter table sec.request_nonces owner to sec_owner;

-- Verify a signed request. Returns {"ok":true,...} or {"ok":false,"code":...,"reason":...}.
-- Canonical string (lines joined by \n):
--   FS1-HMAC-SHA256, timestamp, METHOD, path, canonical query, request id,
--   user id, idempotency key, client ip, hex(sha256(raw body))
-- Absent values are empty strings. The comparison uses a second HMAC with a
-- random key so its timing reveals nothing about the expected signature.
create or replace function sec.verify_request(
  p_key_id text, p_timestamp text, p_method text, p_path text, p_query text,
  p_request_id text, p_user_id text, p_idempotency_key text, p_client_ip text,
  p_body_b64 text, p_signature text, p_max_skew_s integer default 300
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_secret    bytea;
  v_ts        bigint;
  v_now       bigint := floor(extract(epoch from clock_timestamp()))::bigint;  -- floor, not round (::bigint rounds)
  v_body      bytea;
  v_body_hash text;
  v_canonical text;
  v_expected  bytea;
  v_k         bytea;
begin
  if p_key_id is null or p_timestamp is null or p_signature is null or p_request_id is null
     or p_method is null or p_path is null then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED', 'reason', 'missing_header');
  end if;

  if concat(p_key_id, p_timestamp, p_method, p_path, p_query, p_request_id, p_user_id,
            p_idempotency_key, p_client_ip, p_signature) ~ '[\r\n]' then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED', 'reason', 'control_character');
  end if;

  select c.secret into v_secret
  from sec.api_clients c
  where c.key_id = p_key_id and c.active and c.revoked_at is null;
  if v_secret is null then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED', 'reason', 'unknown_key');
  end if;

  if p_timestamp !~ '^[0-9]{1,12}$' then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED', 'reason', 'bad_timestamp');
  end if;
  v_ts := p_timestamp::bigint;
  if abs(v_now - v_ts) > p_max_skew_s then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED', 'reason', 'stale_timestamp',
                              'server_time', v_now);
  end if;

  if p_signature !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED', 'reason', 'bad_signature_format');
  end if;
  if p_request_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED', 'reason', 'bad_request_id');
  end if;

  begin
    v_body := decode(coalesce(p_body_b64, ''), 'base64');
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED', 'reason', 'bad_body_encoding');
  end;
  v_body_hash := encode(sha256(v_body), 'hex');

  v_canonical := 'FS1-HMAC-SHA256' || E'\n' || p_timestamp || E'\n' || upper(p_method) || E'\n' ||
                 p_path || E'\n' || coalesce(p_query, '') || E'\n' || p_request_id || E'\n' ||
                 coalesce(p_user_id, '') || E'\n' || coalesce(p_idempotency_key, '') || E'\n' ||
                 coalesce(p_client_ip, '') || E'\n' || v_body_hash;

  v_expected := public.hmac(convert_to(v_canonical, 'UTF8'), v_secret, 'sha256');
  v_k := public.gen_random_bytes(32);
  if public.hmac(v_expected, v_k, 'sha256') <> public.hmac(decode(p_signature, 'hex'), v_k, 'sha256') then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED', 'reason', 'bad_signature');
  end if;

  insert into sec.request_nonces (key_id, request_id) values (p_key_id, p_request_id::uuid)
  on conflict do nothing;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED', 'reason', 'replayed');
  end if;
  delete from sec.request_nonces
  where seen_at < clock_timestamp() - make_interval(secs => 2 * p_max_skew_s + 60);

  return jsonb_build_object('ok', true, 'key_id', p_key_id, 'body_sha256', v_body_hash);
end $$;
alter function sec.verify_request(text,text,text,text,text,text,text,text,text,text,text,integer) owner to sec_owner;

-- Issue a client key. Only the migration owner (superuser) can call it; the
-- secret is returned once and must go into the calling server's environment.
create or replace function sec.create_api_client(p_key_id text, p_name text)
returns table (key_id text, secret text)
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare v_secret text := 'fss_' || encode(public.gen_random_bytes(32), 'hex');
begin
  insert into sec.api_clients (key_id, name, secret) values (p_key_id, p_name, convert_to(v_secret, 'UTF8'));
  return query select p_key_id, v_secret;
end $$;

revoke all on all functions in schema sec from public;
grant usage on schema sec to n8n_worker;
grant execute on function sec.verify_request(text,text,text,text,text,text,text,text,text,text,text,integer) to n8n_worker;

-- ---------------------------------------------------------------------
-- Idempotency: one row per (scope, key). scope = '<key_id>:<user id or anon>'.
-- Stored responses may contain personal data: user_id lets erasure find them,
-- and retention removes rows after 24 hours (phase 7 workflow).
-- ---------------------------------------------------------------------
create table app.idempotency_keys (
  scope           text not null,
  idem_key        text not null check (length(idem_key) between 8 and 128),
  route           text not null,
  body_sha256     text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  state           text not null default 'in_progress' check (state in ('in_progress','completed')),
  response_status smallint,
  response_body   jsonb,
  user_id         uuid,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  primary key (scope, idem_key)
);
create index idempotency_keys_created on app.idempotency_keys (created_at);
create index idempotency_keys_user on app.idempotency_keys (user_id) where user_id is not null;
grant select, insert, update, delete on app.idempotency_keys to n8n_worker;

-- Returns {"state":"new"}            first time: caller runs the handler
--         {"state":"replay",...}     same key, same request, finished: return stored response
--         {"state":"conflict"}       same key, different route or body: 409
--         {"state":"in_progress"}    same key still running: 409
-- An in_progress row older than p_stale_after_s is taken over (the first attempt died).
create or replace function app.idempotency_begin(
  p_scope text, p_key text, p_route text, p_body_sha256 text, p_stale_after_s integer default 300
) returns jsonb
language plpgsql as $$
declare r app.idempotency_keys;
begin
  insert into app.idempotency_keys (scope, idem_key, route, body_sha256)
  values (p_scope, p_key, p_route, p_body_sha256)
  on conflict do nothing;
  if found then
    return jsonb_build_object('state', 'new');
  end if;

  select * into r from app.idempotency_keys where scope = p_scope and idem_key = p_key for update;
  if r.route <> p_route or r.body_sha256 <> p_body_sha256 then
    return jsonb_build_object('state', 'conflict');
  end if;
  if r.state = 'completed' then
    return jsonb_build_object('state', 'replay', 'response_status', r.response_status,
                              'response_body', r.response_body);
  end if;
  if r.created_at < now() - make_interval(secs => p_stale_after_s) then
    update app.idempotency_keys set created_at = now()
    where scope = p_scope and idem_key = p_key;
    return jsonb_build_object('state', 'new', 'took_over', true);
  end if;
  return jsonb_build_object('state', 'in_progress');
end $$;

create or replace function app.idempotency_complete(
  p_scope text, p_key text, p_status integer, p_body jsonb, p_user_id uuid default null
) returns void
language sql as $$
  update app.idempotency_keys
     set state = 'completed', response_status = p_status, response_body = p_body,
         user_id = coalesce(p_user_id, user_id), completed_at = now()
   where scope = p_scope and idem_key = p_key;
$$;

-- A failed handler releases the key so the client can retry with the same key.
create or replace function app.idempotency_release(p_scope text, p_key text) returns void
language sql as $$
  delete from app.idempotency_keys where scope = p_scope and idem_key = p_key and state = 'in_progress';
$$;

revoke all on function app.idempotency_begin(text,text,text,text,integer) from public;
revoke all on function app.idempotency_complete(text,text,integer,jsonb,uuid) from public;
revoke all on function app.idempotency_release(text,text) from public;
grant execute on function app.idempotency_begin(text,text,text,text,integer) to n8n_worker;
grant execute on function app.idempotency_complete(text,text,integer,jsonb,uuid) to n8n_worker;
grant execute on function app.idempotency_release(text,text) to n8n_worker;

-- migrate:down
drop function if exists app.idempotency_release(text,text);
drop function if exists app.idempotency_complete(text,text,integer,jsonb,uuid);
drop function if exists app.idempotency_begin(text,text,text,text,integer);
drop table if exists app.idempotency_keys;
drop schema if exists sec cascade;
