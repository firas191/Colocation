-- migrate:up
-- Platform phase P1 (docs/PLATFORM_SPEC.md 7.1, DECISIONS D-096): the layer that makes row-level rules bind
-- n8n's queries too, and the first platform tables and functions.
--
-- n8n connects as n8n_worker, which has BYPASSRLS (spec 5.4). For the platform's private data (households,
-- messages, applications, notifications) that is not good enough, so:
--   * the tables live in schemas social, home and notify, where n8n_worker has no privilege at all;
--   * n8n calls functions in schema api; they are SECURITY DEFINER, owned by app_rls, a role without BYPASSRLS;
--   * each function first sets app.user_id to the caller given by the gateway (api._as), so the RLS policies,
--     which use app.current_user_id(), filter every row the function touches.
-- A bug in a function's WHERE clause therefore still cannot return another user's rows.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_rls') then
    create role app_rls nologin nobypassrls;
  end if;
end $$;

create schema if not exists api;
create schema if not exists social;
create schema if not exists home;
create schema if not exists notify;
revoke all on schema api, social, home, notify from public;
grant usage on schema social, home, notify, api to app_rls;
grant usage on schema api to n8n_worker;
grant usage on schema app to app_rls;
-- New functions in api are not executable by everyone (PostgreSQL's default), only by the roles granted below.
alter default privileges in schema api revoke execute on functions from public;

-- What the api functions read from schema app. RLS policies of app tables apply to app_rls (no BYPASSRLS):
-- app.profiles, app.consents and app.listings show only the caller's rows (or published listings).
grant execute on function app.current_user_id() to app_rls;
grant select (id, email, display_name, role, locale, jurisdiction_code, verified_level, telegram_chat_id, created_at, deleted_at)
  on app.users to app_rls;
grant select on app.consents, app.profiles, app.jurisdictions, app.currencies, app.settings to app_rls;
grant select (id, owner_id, status) on app.listings to app_rls;

-- Sets the caller for the rest of the transaction (one n8n query = one transaction). Every api function calls it
-- first. Owned by app_rls like the others; not callable by n8n_worker on its own.
create or replace function api._as(p_user uuid) returns void
language sql security definer set search_path = pg_catalog, pg_temp as $$
  select set_config('app.user_id', coalesce(p_user::text, ''), true);
$$;

-- Envelope helpers: every api function returns {status, data} or {status, error:{code, message, details}}.
create or replace function api._ok(p_data jsonb, p_status int default 200) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('status', p_status, 'data', coalesce(p_data, '{}'::jsonb));
$$;
create or replace function api._err(p_status int, p_code text, p_message text, p_details jsonb default '[]') returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('status', p_status, 'error',
    jsonb_build_object('code', p_code, 'message', p_message, 'details', coalesce(p_details, '[]'::jsonb)));
$$;

insert into app.settings (key, value, description) values
  ('platform.jurisdictions', '["TN", "FR", "GB"]', 'Countries the website offers (GET /v1/me jurisdictions); test jurisdictions stay out')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- notify.notifications: in-app notifications. Stored as a type code and parameters; the website writes the text
-- in the reader's language (PLATFORM_SPEC rule 2.4).
create table notify.notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references app.users(id) on delete cascade,
  type       text not null check (type ~ '^[a-z][a-z0-9_]{2,60}$'),
  params     jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
  link_kind  text check (link_kind ~ '^[a-z][a-z0-9_]{1,40}$'),
  link_id    text check (length(link_id) <= 80),
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index notifications_user_idx on notify.notifications (user_id, id desc);
create index notifications_unread_idx on notify.notifications (user_id) where read_at is null;
alter table notify.notifications enable row level security;
alter table notify.notifications force row level security;
-- Read and mark as read: own rows only. Insert: any recipient, because the action of one user notifies another;
-- who is notified is decided by the function that inserts.
create policy notifications_own on notify.notifications for select using (user_id = app.current_user_id());
create policy notifications_own_update on notify.notifications for update
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy notifications_insert on notify.notifications for insert with check (true);
grant select, insert on notify.notifications to app_rls;
grant update (read_at) on notify.notifications to app_rls;

-- ---------------------------------------------------------------------------------------------------------------
-- GET /v1/me
create or replace function api.me(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare u record; consents jsonb; required text[];
begin
  perform api._as(p_user);
  select id, email, display_name, role, locale, jurisdiction_code, verified_level, telegram_chat_id, created_at
    into u from app.users where id = p_user and deleted_at is null;
  if not found then return api._err(404, 'NOT_FOUND', 'User not found'); end if;
  select coalesce(jsonb_object_agg(c.purpose, jsonb_build_object('granted', c.granted, 'policy_version', c.policy_version,
           'granted_at', c.granted_at)), '{}'::jsonb)
    into consents
    from (select distinct on (purpose) purpose, granted, policy_version, granted_at
            from app.consents order by purpose, granted_at desc, id desc) c;   -- RLS: the caller's rows only
  required := array(select p from unnest(array['terms', 'privacy']) p
                     where coalesce((consents->p->>'granted')::boolean, false) = false);
  return api._ok(jsonb_build_object(
    'user_id', u.id, 'email', u.email, 'display_name', u.display_name, 'role', u.role, 'locale', u.locale,
    'jurisdiction_code', u.jurisdiction_code, 'created_at', u.created_at,
    'consents', consents, 'consent_required', to_jsonb(required),
    'flags', jsonb_build_object(
      'has_profile', exists (select 1 from app.profiles),                       -- RLS: own profile
      'has_listings', exists (select 1 from app.listings where owner_id = p_user and status <> 'rejected'),
      'is_staff', u.role in ('moderator', 'admin'),
      'telegram_linked', u.telegram_chat_id is not null),
    'counts', jsonb_build_object(
      'unread_notifications', (select count(*) from notify.notifications where read_at is null),
      'listings', (select count(*) from app.listings where owner_id = p_user and status not in ('rejected', 'archived'))),
    'badges', '[]'::jsonb,
    -- countries the platform knows, with the currency exponent clients need to show and enter amounts
    'jurisdictions', (select coalesce(jsonb_agg(jsonb_build_object('code', j.code, 'name', j.name, 'currency', j.default_currency,
                        'exponent', c.exponent, 'languages', to_jsonb(j.languages), 'timezone', j.timezone) order by j.code), '[]'::jsonb)
                      from app.jurisdictions j join app.currencies c on c.code = j.default_currency
                     where j.code in (select jsonb_array_elements_text(value) from app.settings where key = 'platform.jurisdictions')
                        or j.code = u.jurisdiction_code)));
end $$;

-- GET /v1/profiles/me: the saved search and lifestyle profile, or null.
create or replace function api.profile_get(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare r record;
begin
  perform api._as(p_user);
  select * into r from app.profiles;                                             -- RLS: own row only
  if not found then return api._ok(jsonb_build_object('profile', null)); end if;
  return api._ok(jsonb_build_object('profile', jsonb_build_object(
    'id', r.id, 'profile_version', r.profile_version, 'jurisdiction_code', r.jurisdiction_code,
    'budget_min_minor', r.budget_min_minor, 'budget_max_minor', r.budget_max_minor, 'currency', r.currency,
    'budget_period', r.budget_period, 'anchor_label', r.anchor_label,
    'anchor', case when r.anchor_point is null then null else
       jsonb_build_object('lat', round(st_y(r.anchor_point::geometry)::numeric, 5),
                          'lng', round(st_x(r.anchor_point::geometry)::numeric, 5)) end,
    'max_commute_min', r.max_commute_min, 'search_radius_m', r.search_radius_m,
    'move_in_from', r.move_in_from, 'min_stay_months', r.min_stay_months,
    'declared_preferences', r.declared_preferences, 'languages', to_jsonb(r.languages),
    'unparsed', to_jsonb(r.unparsed), 'updated_at', r.updated_at)));
end $$;

-- Every api function with input gets p = {params, query, body, lang} from the workflow's Validate node.
-- GET /v1/me/notifications: newest first; query = {before (id), limit 1..50, unread_only}
create or replace function api.notifications_list(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare q jsonb := coalesce(p->'query', '{}'::jsonb); lim int := coalesce((q->>'limit')::int, 20); items jsonb;
begin
  perform api._as(p_user);
  select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'type', n.type, 'params', n.params, 'link_kind', n.link_kind,
           'link_id', n.link_id, 'created_at', n.created_at, 'read_at', n.read_at) order by n.id desc), '[]'::jsonb)
    into items
    from (select * from notify.notifications
           where (q->>'before' is null or id < (q->>'before')::bigint)
             and (coalesce((q->>'unread_only')::boolean, false) = false or read_at is null)
           order by id desc limit lim + 1) n;
  return api._ok(jsonb_build_object(
    'items', case when jsonb_array_length(items) > lim then items - lim else items end,
    'next_before', case when jsonb_array_length(items) > lim then items->(lim - 1)->'id' else 'null'::jsonb end,
    'unread', (select count(*) from notify.notifications where read_at is null)));
end $$;

-- POST /v1/me/notifications/read: body = {ids: [..]} or {all: true}
create or replace function api.notifications_read(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare b jsonb := coalesce(p->'body', '{}'::jsonb); n int;
begin
  perform api._as(p_user);
  update notify.notifications set read_at = now()
   where read_at is null
     and (coalesce((b->>'all')::boolean, false)
          or id in (select (x #>> '{}')::bigint from jsonb_array_elements(coalesce(b->'ids', '[]'::jsonb)) x));
  get diagnostics n = row_count;
  return api._ok(jsonb_build_object('updated', n,
    'unread', (select count(*) from notify.notifications where read_at is null)));
end $$;

-- Used by workflows to notify a user (wf.notify.emit and the platform workflows). True when a row was written.
-- No RETURNING: the new row belongs to another user, and RETURNING would have to pass the select policy.
create or replace function api.notify_emit(p_user uuid, p_type text, p_params jsonb default '{}',
                                            p_link_kind text default null, p_link_id text default null) returns boolean
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare n int;
begin
  insert into notify.notifications (user_id, type, params, link_kind, link_id)
  select p_user, p_type, coalesce(p_params, '{}'::jsonb), p_link_kind, p_link_id
  where exists (select 1 from app.users where id = p_user and deleted_at is null);
  get diagnostics n = row_count;
  return n > 0;
end $$;

alter function api._as(uuid) owner to app_rls;
alter function api.me(uuid) owner to app_rls;
alter function api.profile_get(uuid) owner to app_rls;
alter function api.notifications_list(uuid, jsonb) owner to app_rls;
alter function api.notifications_read(uuid, jsonb) owner to app_rls;
alter function api.notify_emit(uuid, text, jsonb, text, text) owner to app_rls;
revoke execute on all functions in schema api from public;
grant execute on function api._as(uuid), api._ok(jsonb, int), api._err(int, text, text, jsonb) to app_rls;
grant execute on function api.me(uuid), api.profile_get(uuid), api.notifications_list(uuid, jsonb),
  api.notifications_read(uuid, jsonb), api.notify_emit(uuid, text, jsonb, text, text) to n8n_worker;
-- PostGIS functions used by api.profile_get (st_x, st_y) live in public; app_rls needs to reach them.
grant usage on schema public to app_rls;

-- Erasure (spec 13.6) also removes the user's notifications: the foreign key cascades on delete, but erase_user
-- keeps the users row (anonymised), so they are deleted explicitly by a trigger on the anonymisation.
create or replace function app.platform_on_user_erased() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    delete from notify.notifications where user_id = new.id;
  end if;
  return new;
end $$;
revoke execute on function app.platform_on_user_erased() from public;
create trigger users_platform_erase after update of deleted_at on app.users
  for each row execute function app.platform_on_user_erased();

-- migrate:down
delete from app.settings where key = 'platform.jurisdictions';
drop trigger if exists users_platform_erase on app.users;
drop function if exists app.platform_on_user_erased();
drop schema if exists api cascade;
drop schema if exists notify cascade;
drop schema if exists home cascade;
drop schema if exists social cascade;
revoke all on app.users, app.consents, app.profiles, app.jurisdictions, app.currencies, app.settings, app.listings from app_rls;
revoke usage on schema app, public from app_rls;
revoke execute on function app.current_user_id() from app_rls;
-- app_rls is kept: roles belong to the whole server, and other databases (flatshare_test) may still use it.
