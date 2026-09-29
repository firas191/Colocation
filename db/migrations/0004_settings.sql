-- migrate:up
-- Runtime configuration for workflows. n8n 2.x blocks environment variables in
-- expressions and Code nodes by default (N8N_BLOCK_ENV_ACCESS_IN_NODE=true), so
-- non-secret settings live here. Secrets never go in this table.
create table app.settings (
  key         text primary key check (key ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$'),
  value       jsonb not null,
  description text,
  updated_at  timestamptz not null default now()
);
create trigger trg_settings_touch before update on app.settings
  for each row execute function app.touch_updated_at();

insert into app.settings (key, value, description) values
  ('gateway.max_skew_s',              '300',  'Accepted clock difference for X-Timestamp, seconds'),
  ('gateway.rate_limit_user_per_min', '60',   'Requests per user per minute'),
  ('gateway.rate_limit_ip_per_min',   '120',  'Requests per client IP per minute'),
  ('gateway.idempotency_stale_s',     '300',  'An unfinished idempotent request older than this may be retried'),
  ('ollama.base_url',                 '"http://ollama:11434"', 'Ollama API base URL (bootstrap overwrites from OLLAMA_BASE_URL)'),
  ('ollama.embed_model',              '"bge-m3"', 'Default embedding model'),
  ('s3.health_url',                   '"http://garage:3903/health"', 'Object storage health endpoint'),
  ('health.timeout_ms',               '3000', 'Timeout for each dependency check'),
  ('legal.notice_version',            '"legal-notice-v1"', 'Version id of the general-information notice');

-- NULL for anything that is not a canonical uuid string (no exception).
create or replace function app.try_uuid(p text) returns uuid
language sql immutable as $$
  select case when p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p::uuid end
$$;
revoke all on function app.try_uuid(text) from public;
grant execute on function app.try_uuid(text) to n8n_worker;

-- Everything the gateway needs to know about a (signed) user id, in one call.
-- Returns {"user": null} when the id is absent, malformed or unknown.
create or replace function app.gateway_context(p_user_id text) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'user', (select jsonb_build_object('id', u.id, 'role', u.role, 'deleted', u.deleted_at is not null,
                                       'locale', u.locale, 'jurisdiction_code', u.jurisdiction_code)
             from app.users u
             where u.id = app.try_uuid(p_user_id)),
    'consents', coalesce((select jsonb_object_agg(c.purpose, c.granted)
                          from (select distinct on (purpose) purpose, granted
                                from app.consents
                                where user_id = app.try_uuid(p_user_id)
                                order by purpose, granted_at desc, id desc) c), '{}'::jsonb),
    'settings', coalesce((select jsonb_object_agg(s.key, s.value) from app.settings s where s.key like 'gateway.%'), '{}'::jsonb)
  )
$$;
revoke all on function app.gateway_context(text) from public;
grant execute on function app.gateway_context(text) to n8n_worker;

-- migrate:down
drop function if exists app.gateway_context(text);
drop function if exists app.try_uuid(text);
drop table if exists app.settings;
