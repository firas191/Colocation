-- migrate:up
-- Rate-limit counters in PostgreSQL instead of Redis (docs/DECISIONS.md D-016):
-- the n8n Redis node retries a lost connection for minutes, so a Redis outage
-- made every request hang (reports/phase1/redis_node_outage_spike.log).
-- Fixed one-minute windows. Unlogged: counters are lost on a crash, which is acceptable.
create unlogged table app.rate_counters (
  bucket     text primary key,
  n          integer not null,
  expires_at timestamptz not null
);
create index rate_counters_expires on app.rate_counters (expires_at);
grant select, insert, update, delete on app.rate_counters to n8n_worker;

create or replace function app.rate_hit(p_key text, p_window_s integer default 60) returns integer
language plpgsql as $$
declare
  v_bucket text := p_key || ':' || (extract(epoch from clock_timestamp())::bigint / p_window_s);
  v_n integer;
begin
  insert into app.rate_counters as r (bucket, n, expires_at)
  values (v_bucket, 1, clock_timestamp() + make_interval(secs => 2 * p_window_s))
  on conflict (bucket) do update set n = r.n + 1
  returning r.n into v_n;
  if random() < 0.01 then
    delete from app.rate_counters where expires_at < clock_timestamp();
  end if;
  return v_n;
end $$;

-- One round trip for the gateway: signature check, user context, rate counters.
-- The IP counter counts every request, including failed signatures (slows guessing).
-- Which IP: the signed X-Client-Ip (the end user's IP, sent by the website server)
-- only when the signature is valid; otherwise the network address seen by the
-- proxy, because an unsigned header could be set to anything to dodge the limit.
-- The user counter counts only verified requests with a user id.
-- Decisions (which error to return) are taken in the n8n workflow, not here.
create or replace function app.gateway_check(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_verify  jsonb;
  v_ctx     jsonb;
  v_ip_n    integer;
  v_user_n  integer;
begin
  v_verify := sec.verify_request(
    p->>'key_id', p->>'timestamp', p->>'method', p->>'path', p->>'query',
    p->>'request_id', p->>'user_id', p->>'idempotency_key', p->>'client_ip',
    p->>'body_b64', p->>'signature',
    coalesce((select (value #>> '{}')::int from app.settings where key = 'gateway.max_skew_s'), 300));
  v_ctx := app.gateway_context(p->>'user_id');
  v_ip_n := app.rate_hit('ip:' || coalesce(
    case when (v_verify->>'ok')::boolean then nullif(p->>'client_ip', '') end,
    nullif(p->>'network_ip', ''), 'unknown'));
  if (v_verify->>'ok')::boolean and coalesce(p->>'user_id', '') <> '' then
    v_user_n := app.rate_hit('user:' || (p->>'user_id'));
  end if;
  return jsonb_build_object('verify', v_verify, 'context', v_ctx,
                            'rate', jsonb_build_object('ip', v_ip_n, 'user', v_user_n));
end $$;

revoke all on function app.rate_hit(text, integer) from public;
revoke all on function app.gateway_check(jsonb) from public;
grant execute on function app.rate_hit(text, integer) to n8n_worker;
grant execute on function app.gateway_check(jsonb) to n8n_worker;

-- migrate:down
drop function if exists app.gateway_check(jsonb);
drop function if exists app.rate_hit(text, integer);
drop table if exists app.rate_counters;
