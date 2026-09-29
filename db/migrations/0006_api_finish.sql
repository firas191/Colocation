-- migrate:up
-- Last database call of every API request: record the request in ai.executions
-- and finish (or release) its idempotency record. One round trip.
create or replace function app.api_finish(p jsonb) returns void
language plpgsql as $$
declare
  v_status integer := (p->>'status_code')::int;
  v_scope  text := p#>>'{idempotency,scope}';
  v_key    text := p#>>'{idempotency,key}';
begin
  insert into ai.executions (request_id, workflow, n8n_execution_id, user_id, channel, status,
                             started_at, finished_at, latency_ms, error)
  values ((p->>'request_id')::uuid, p->>'workflow', p->>'n8n_execution_id',
          (select u.id from app.users u where u.id = app.try_uuid(p->>'user_id')),
          coalesce(p->>'channel', 'api'),
          case when v_status >= 500 then 'failed' else 'succeeded' end,
          clock_timestamp() - make_interval(secs => coalesce((p->>'latency_ms')::numeric, 0) / 1000.0),
          clock_timestamp(), (p->>'latency_ms')::int,
          nullif(concat_ws(' | ', p->>'error_code', nullif(p->>'error_detail', '')), ''));

  if v_scope is not null and v_key is not null and coalesce((p->>'idempotency_replay')::boolean, false) = false then
    if v_status >= 500 then
      perform app.idempotency_release(v_scope, v_key);
    else
      perform app.idempotency_complete(v_scope, v_key, v_status, p->'response_body',
                                       app.try_uuid(p->>'result_user_id'));
    end if;
  end if;
end $$;
revoke all on function app.api_finish(jsonb) from public;
grant execute on function app.api_finish(jsonb) to n8n_worker;

-- The health endpoint reports the applied migration version.
grant select on public.schema_migrations to n8n_worker;

-- migrate:down
revoke select on public.schema_migrations from n8n_worker;
drop function if exists app.api_finish(jsonb);
