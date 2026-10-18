-- migrate:up
-- Platform phase P11 (docs/PLATFORM_SPEC.md 3.11, 3.12, 9 P11; DECISIONS D-110): e-mail and Telegram delivery of
-- notifications with each person's preferences, Telegram linking by a one-time code, and the admin endpoints
-- (settings on an allowlist, staff roles, prompts, evaluation runs, knowledge-base sources).

insert into app.settings (key, value, description) values
  ('notify.web_origin', '"http://localhost:3000"', 'Address of the website, for the links in e-mails and Telegram messages'),
  ('notify.max_attempts', '5', 'Delivery attempts per notification and channel before it is marked failed'),
  ('notify.max_age_hours', '24', 'Notifications older than this are not sent by e-mail or Telegram any more (in-app only)'),
  ('telegram.link_code_minutes', '15', 'How long a Telegram link code works'),
  ('notify.mail_from', '"no-reply@coloc.local"', 'Sender address of notification e-mails (the SMTP account itself is in .env, SMTP_*)')
on conflict (key) do nothing;

create table notify.preferences (
  user_id    uuid primary key references app.users(id) on delete cascade,
  email      boolean not null default true,
  telegram   boolean not null default true,
  muted      text[] not null default '{}',        -- notification types sent in the app only
  updated_at timestamptz not null default now()
);
create table notify.deliveries (
  id              bigint generated always as identity primary key,
  notification_id bigint not null references notify.notifications(id) on delete cascade,
  user_id         uuid not null references app.users(id) on delete cascade,
  channel         text not null check (channel in ('email', 'telegram')),
  status          text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  sent_at         timestamptz,
  created_at      timestamptz not null default now(),
  unique (notification_id, channel)
);
create index deliveries_due on notify.deliveries (next_attempt_at) where status = 'queued';
create table app.telegram_link_codes (
  code_hash  bytea primary key,
  user_id    uuid not null references app.users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at    timestamptz
);
alter table notify.preferences enable row level security;  alter table notify.preferences force row level security;
alter table notify.deliveries enable row level security;   alter table notify.deliveries force row level security;
alter table app.telegram_link_codes enable row level security; alter table app.telegram_link_codes force row level security;
create policy prefs_own on notify.preferences for all using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy deliveries_own on notify.deliveries for select using (user_id = app.current_user_id());
create policy tglink_own on app.telegram_link_codes for all using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
grant select, insert, update on notify.preferences to app_rls;
grant select on notify.deliveries to app_rls;
grant select, insert, delete on app.telegram_link_codes to app_rls;

-- 1. Preferences: GET / PUT /v1/me/notification-preferences
create or replace function api.notify_prefs_get(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare r notify.preferences;
begin
  perform api._as(p_user);
  select * into r from notify.preferences where user_id = p_user;
  return api._ok(jsonb_build_object('email', coalesce(r.email, true), 'telegram', coalesce(r.telegram, true), 'muted', to_jsonb(coalesce(r.muted, '{}')),
    'email_address', (select email is not null from app.users where id = p_user),
    'telegram_linked', (select telegram_chat_id is not null from app.users where id = p_user),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('channel', d.channel, 'status', d.status, 'attempts', d.attempts, 'sent_at', d.sent_at,
                          'type', n.type) order by d.id desc)
                        from (select * from notify.deliveries where user_id = p_user order by id desc limit 10) d
                        join notify.notifications n on n.id = d.notification_id), '[]')));
end $$;
create or replace function api.notify_prefs_put(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare b jsonb := coalesce(p->'body', '{}');
begin
  perform api._as(p_user);
  insert into notify.preferences (user_id, email, telegram, muted, updated_at)
  values (p_user, coalesce((b->>'email')::boolean, true), coalesce((b->>'telegram')::boolean, true),
          coalesce(array(select jsonb_array_elements_text(b->'muted')), '{}'), now())
  on conflict (user_id) do update set email = excluded.email, telegram = excluded.telegram, muted = excluded.muted, updated_at = now();
  return api.notify_prefs_get(p_user, p);
end $$;

-- 2. Telegram linking: the website shows a one-time code, the person sends it to the bot, the bot's workflow calls
--    app.telegram_link_redeem(code, chat_id). Only the code's hash is stored.
create or replace function api.telegram_link_create(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_code text := upper(substr(encode(gen_random_bytes(8), 'hex'), 1, 8)); v_min int := api._setting_int('telegram.link_code_minutes', 15);
begin
  perform api._as(p_user);
  delete from app.telegram_link_codes where user_id = p_user;
  insert into app.telegram_link_codes (code_hash, user_id, expires_at) values (digest(v_code, 'sha256'), p_user, now() + make_interval(mins => v_min));
  return api._ok(jsonb_build_object('code', v_code, 'expires_at', now() + make_interval(mins => v_min), 'command', '/lier ' || v_code), 201);
end $$;
create or replace function api.telegram_unlink(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform api._as(p_user);
  perform app._telegram_unlink(p_user);
  return api._ok(jsonb_build_object('telegram_linked', false));
end $$;
create or replace function app._telegram_unlink(p_user uuid) returns void
language sql security definer set search_path = pg_catalog, pg_temp as $$
  update app.users set telegram_chat_id = null where id = p_user
$$;
create or replace function app.telegram_link_redeem(p_code text, p_chat_id bigint) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare c app.telegram_link_codes;
begin
  select * into c from app.telegram_link_codes where code_hash = digest(upper(btrim(coalesce(p_code, ''))), 'sha256') for update;
  if c.user_id is null or c.used_at is not null or c.expires_at < now() then
    return jsonb_build_object('ok', false, 'error_code', case when c.user_id is null then 'unknown_code' when c.used_at is not null then 'used' else 'expired' end);
  end if;
  update app.users set telegram_chat_id = null where telegram_chat_id = p_chat_id and id <> c.user_id;   -- one account per chat
  update app.users set telegram_chat_id = p_chat_id where id = c.user_id;
  update app.telegram_link_codes set used_at = now() where code_hash = c.code_hash;
  insert into app.audit_log (actor_id, action, entity, entity_id) values (c.user_id, 'telegram_linked', 'user', c.user_id::text);
  return jsonb_build_object('ok', true, 'user_id', c.user_id, 'display_name', (select display_name from app.users where id = c.user_id));
end $$;

-- 3. Delivery (wf.notify.dispatch, every minute): new notifications get one delivery per channel the person allows;
--    due deliveries are handed out with what the message needs; results come back with app.deliveries_done.
create or replace function app.deliveries_take(p_limit int default 50) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_age int := coalesce((select (value #>> '{}')::int from app.settings where key = 'notify.max_age_hours'), 24); out jsonb;
begin
  insert into notify.deliveries (notification_id, user_id, channel)
  select n.id, n.user_id, ch.c
    from notify.notifications n
    join app.users u on u.id = n.user_id and u.deleted_at is null
    left join notify.preferences pr on pr.user_id = n.user_id
    cross join (values ('email'), ('telegram')) ch(c)
   where n.created_at > now() - make_interval(hours => v_age)
     and not (n.type = any(coalesce(pr.muted, '{}')))
     and ((ch.c = 'email' and coalesce(pr.email, true) and u.email is not null)
       or (ch.c = 'telegram' and coalesce(pr.telegram, true) and u.telegram_chat_id is not null))
  on conflict (notification_id, channel) do nothing;
  with due as (
    update notify.deliveries d set status = 'sending', attempts = attempts + 1
     where d.id in (select id from notify.deliveries where status = 'queued' and next_attempt_at <= now() order by next_attempt_at limit p_limit
                    for update skip locked)
    returning d.*)
  select coalesce(jsonb_agg(jsonb_build_object('delivery_id', due.id, 'channel', due.channel, 'type', n.type, 'params', n.params,
           'link_kind', n.link_kind, 'link_id', n.link_id, 'locale', coalesce(u.locale, 'fr'), 'email', u.email, 'chat_id', u.telegram_chat_id,
           'name', u.display_name)), '[]')
    into out
    from due join notify.notifications n on n.id = due.notification_id join app.users u on u.id = due.user_id;
  return jsonb_build_object('deliveries', out,
    'web_origin', coalesce((select value #>> '{}' from app.settings where key = 'notify.web_origin'), 'http://localhost:3000'),
    'mail_from', coalesce((select value #>> '{}' from app.settings where key = 'notify.mail_from'), 'no-reply@coloc.local'));
end $$;
create or replace function app.deliveries_done(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare x jsonb; v_max int := coalesce((select (value #>> '{}')::int from app.settings where key = 'notify.max_attempts'), 5); n int := 0;
begin
  for x in select * from jsonb_array_elements(coalesce(p, '[]')) loop
    update notify.deliveries d
       set status = case when (x->>'ok')::boolean then 'sent' when d.attempts >= v_max then 'failed' else 'queued' end,
           sent_at = case when (x->>'ok')::boolean then now() end,
           last_error = case when (x->>'ok')::boolean then null else left(coalesce(x->>'error', 'unknown'), 200) end,
           -- retry after 1, 2, 4, 8 minutes
           next_attempt_at = case when (x->>'ok')::boolean then d.next_attempt_at else now() + make_interval(mins => power(2, d.attempts - 1)::int) end
     where d.id = (x->>'delivery_id')::bigint and d.status = 'sending';
    n := n + 1;
  end loop;
  -- deliveries left "sending" by a stopped run go back to the queue after 10 minutes
  update notify.deliveries set status = 'queued' where status = 'sending' and next_attempt_at < now() - interval '10 minutes';
  return jsonb_build_object('done', n);
end $$;

-- 4. Admin (3.12). Settings: only the keys of this allowlist, each with its type; the change and its author are logged.
create or replace function app._admin_settings_allowlist() returns jsonb
language sql immutable as $$
  select '{"trust.enabled": "bool", "trust.agent_enabled": "bool", "listing.auto_publish": "bool", "vision.enabled": "bool",
    "match.agent_enabled": "bool", "legal.agent_enabled": "bool", "owner.agent_enabled": "bool", "documents.agent_enabled": "bool",
    "reports.per_hour": "int:1:1000", "messages.per_minute": "int:1:1000", "saved_searches.max": "int:1:100", "documents.per_day": "int:1:1000",
    "gateway.rate_limit_user_per_min": "int:10:10000", "retention.drafts_days": "int:1:365", "retention.notifications_days": "int:7:3650",
    "retention.search_hits_days": "int:7:3650", "notify.max_attempts": "int:1:20", "notify.max_age_hours": "int:1:720",
    "notify.web_origin": "url", "trust.benchmark_min": "int:1:1000"}'::jsonb
$$;
create or replace function app._is_staff(p_user uuid, p_admin boolean default false) returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select exists (select 1 from app.users where id = p_user and deleted_at is null and role in ('admin', case when p_admin then 'admin' else 'moderator' end))
$$;
create or replace function app.admin_settings_list(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare a jsonb := app._admin_settings_allowlist();
begin
  if not app._is_staff(p_user, true) then
    return jsonb_build_object('status', 403, 'error', jsonb_build_object('code', 'FORBIDDEN', 'message', 'Admins only', 'details', '[]'::jsonb));
  end if;
  return jsonb_build_object('status', 200, 'data', jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('key', s.key,
    'value', s.value, 'type', a->>s.key, 'description', s.description) order by s.key) from app.settings s where a ? s.key), '[]')));
end $$;
create or replace function app.admin_setting_put(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare k text := p#>>'{params,key}'; v jsonb := p#>'{body,value}'; t text := app._admin_settings_allowlist()->>(p#>>'{params,key}'); old jsonb; ok boolean;
begin
  if not app._is_staff(p_user, true) then
    return jsonb_build_object('status', 403, 'error', jsonb_build_object('code', 'FORBIDDEN', 'message', 'Admins only', 'details', '[]'::jsonb));
  end if;
  if t is null then
    return jsonb_build_object('status', 422, 'error', jsonb_build_object('code', 'VALIDATION_FAILED', 'message', 'Request is invalid',
      'details', '[{"field": "key", "issue": "not_on_allowlist"}]'::jsonb));
  end if;
  ok := case
    when t = 'bool' then jsonb_typeof(v) = 'boolean'
    when t like 'int:%' then jsonb_typeof(v) = 'number' and (v #>> '{}') ~ '^-?\d+$'
         and (v #>> '{}')::bigint between split_part(t, ':', 2)::bigint and split_part(t, ':', 3)::bigint
    when t = 'url' then jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^https?://[A-Za-z0-9.-]+(:\d{1,5})?$'
    else false end;
  if not coalesce(ok, false) then
    return jsonb_build_object('status', 422, 'error', jsonb_build_object('code', 'VALIDATION_FAILED', 'message', 'Request is invalid',
      'details', jsonb_build_array(jsonb_build_object('field', 'value', 'issue', 'invalid_for_type', 'type', t))));
  end if;
  select value into old from app.settings where key = k;
  update app.settings set value = v where key = k;
  insert into app.audit_log (actor_id, action, entity, entity_id, detail)
  values (p_user, 'setting_changed', 'setting', k, jsonb_build_object('from', old, 'to', v));
  return jsonb_build_object('status', 200, 'data', jsonb_build_object('key', k, 'value', v, 'type', t, 'previous', old));
end $$;

-- staff roles: admins only; an admin cannot change their own role (there is always one left); logged
create or replace function app.admin_users_list(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare q text := nullif(btrim(coalesce(p#>>'{query,q}', '')), '');
begin
  if not app._is_staff(p_user, true) then
    return jsonb_build_object('status', 403, 'error', jsonb_build_object('code', 'FORBIDDEN', 'message', 'Admins only', 'details', '[]'::jsonb));
  end if;
  return jsonb_build_object('status', 200, 'data', jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('user_id', u.id,
    'email', u.email, 'display_name', u.display_name, 'role', u.role, 'created_at', u.created_at) order by u.role <> 'admin', u.role <> 'moderator', u.created_at)
    from (select * from app.users where deleted_at is null and (q is null and role in ('admin', 'moderator')
           or q is not null and (email ilike '%' || q || '%' or display_name ilike '%' || q || '%')) order by created_at limit 50) u), '[]')));
end $$;
create or replace function app.admin_user_role(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; v_role text := p#>>'{body,role}'; old text;
begin
  if not app._is_staff(p_user, true) then
    return jsonb_build_object('status', 403, 'error', jsonb_build_object('code', 'FORBIDDEN', 'message', 'Admins only', 'details', '[]'::jsonb));
  end if;
  if v_id = p_user then
    return jsonb_build_object('status', 409, 'error', jsonb_build_object('code', 'CONFLICT', 'message', 'You cannot change your own role',
      'details', '[{"field": "id", "issue": "self"}]'::jsonb));
  end if;
  select role into old from app.users where id = v_id and deleted_at is null for update;
  if old is null then
    return jsonb_build_object('status', 404, 'error', jsonb_build_object('code', 'NOT_FOUND', 'message', 'User not found', 'details', '[]'::jsonb));
  end if;
  update app.users set role = v_role where id = v_id;
  insert into app.audit_log (actor_id, action, entity, entity_id, detail)
  values (p_user, 'role_changed', 'user', v_id::text, jsonb_build_object('from', old, 'to', v_role));
  return jsonb_build_object('status', 200, 'data', jsonb_build_object('user_id', v_id, 'role', v_role, 'previous', old));
end $$;

-- read-only views for the admin pages: prompts (activation stays a file change, spec 9.5), evaluation runs, sources
create or replace function app.admin_prompts(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  if not app._is_staff(p_user) then
    return jsonb_build_object('status', 403, 'error', jsonb_build_object('code', 'FORBIDDEN', 'message', 'Staff only', 'details', '[]'::jsonb));
  end if;
  return jsonb_build_object('status', 200, 'data', jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('name', pr.name, 'agent', pr.agent,
    'role', pr.role, 'versions', (select jsonb_agg(jsonb_build_object('version', v.version, 'status', v.status, 'techniques', to_jsonb(v.techniques),
      'model', v.model, 'changelog', v.changelog, 'created_at', v.created_at) order by v.version) from ai.prompt_versions v where v.prompt_id = pr.id))
    order by pr.name) from ai.prompts pr), '[]')));
end $$;
create or replace function app.admin_eval_runs(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  if not app._is_staff(p_user) then
    return jsonb_build_object('status', 403, 'error', jsonb_build_object('code', 'FORBIDDEN', 'message', 'Staff only', 'details', '[]'::jsonb));
  end if;
  return jsonb_build_object('status', 200, 'data', jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('run_id', r.id,
    'dataset', (select to_jsonb(d) - 'description' from eval.datasets d where d.id = r.dataset_id), 'config', r.config, 'git_sha', r.git_sha,
    'started_at', r.started_at, 'finished_at', r.finished_at, 'results', (select count(*) from eval.results x where x.run_id = r.id))
    order by r.started_at desc) from (select * from eval.runs order by started_at desc limit 100) r), '[]')));
end $$;
create or replace function app.admin_kb_sources(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  if not app._is_staff(p_user) then
    return jsonb_build_object('status', 403, 'error', jsonb_build_object('code', 'FORBIDDEN', 'message', 'Staff only', 'details', '[]'::jsonb));
  end if;
  return jsonb_build_object('status', 200, 'data', jsonb_build_object('items', coalesce((select jsonb_agg(to_jsonb(s) || jsonb_build_object(
    'last_step', (select jsonb_build_object('step', l.step, 'status', l.status, 'at', l.created_at) from kb.ingest_log l
                   where l.source_id = s.id order by l.id desc limit 1)) order by s.jurisdiction_code nulls first, s.title)
    from kb.sources s where p#>>'{query,jurisdiction}' is null or s.jurisdiction_code = p#>>'{query,jurisdiction}'), '[]')));
end $$;

do $$
declare f text;
  public_ text[] := array['api.notify_prefs_get(uuid, jsonb)', 'api.notify_prefs_put(uuid, jsonb)', 'api.telegram_link_create(uuid, jsonb)',
    'api.telegram_unlink(uuid, jsonb)'];
begin
  foreach f in array public_ loop
    execute format('alter function %s owner to app_rls', f);
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to app_rls, n8n_worker', f);
  end loop;
end $$;
revoke execute on function app._telegram_unlink(uuid), app.telegram_link_redeem(text, bigint), app.deliveries_take(int), app.deliveries_done(jsonb),
  app.admin_settings_list(uuid, jsonb), app.admin_setting_put(uuid, jsonb), app.admin_users_list(uuid, jsonb), app.admin_user_role(uuid, jsonb),
  app.admin_prompts(uuid, jsonb), app.admin_eval_runs(uuid, jsonb), app.admin_kb_sources(uuid, jsonb), app._is_staff(uuid, boolean),
  app._admin_settings_allowlist() from public;
grant execute on function app._telegram_unlink(uuid) to app_rls;
grant execute on function app.telegram_link_redeem(text, bigint), app.deliveries_take(int), app.deliveries_done(jsonb),
  app.admin_settings_list(uuid, jsonb), app.admin_setting_put(uuid, jsonb), app.admin_users_list(uuid, jsonb), app.admin_user_role(uuid, jsonb),
  app.admin_prompts(uuid, jsonb), app.admin_eval_runs(uuid, jsonb), app.admin_kb_sources(uuid, jsonb) to n8n_worker;

-- erasure: preferences, deliveries and link codes go with the account (7.4)
create or replace function app.platform_channels_on_user_erased() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    delete from notify.preferences where user_id = new.id;
    delete from notify.deliveries where user_id = new.id;
    delete from app.telegram_link_codes where user_id = new.id;
  end if;
  return new;
end $$;
create trigger trg_platform_channels_erased after update of deleted_at on app.users
  for each row execute function app.platform_channels_on_user_erased();
revoke execute on function app.platform_channels_on_user_erased() from public;

-- migrate:down
drop trigger if exists trg_platform_channels_erased on app.users;
drop function if exists app.platform_channels_on_user_erased();
drop function if exists app.admin_kb_sources(uuid, jsonb), app.admin_eval_runs(uuid, jsonb), app.admin_prompts(uuid, jsonb), app.admin_user_role(uuid, jsonb),
  app.admin_users_list(uuid, jsonb), app.admin_setting_put(uuid, jsonb), app.admin_settings_list(uuid, jsonb), app._is_staff(uuid, boolean),
  app._admin_settings_allowlist(), app.deliveries_done(jsonb), app.deliveries_take(int), app.telegram_link_redeem(text, bigint),
  api.telegram_unlink(uuid, jsonb), app._telegram_unlink(uuid), api.telegram_link_create(uuid, jsonb), api.notify_prefs_put(uuid, jsonb),
  api.notify_prefs_get(uuid, jsonb);
drop table if exists app.telegram_link_codes, notify.deliveries, notify.preferences;
delete from app.settings where key in ('notify.web_origin', 'notify.max_attempts', 'notify.max_age_hours', 'telegram.link_code_minutes',
  'notify.mail_from');
