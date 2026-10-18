-- migrate:up
-- Platform phase P6 (docs/PLATFORM_SPEC.md 3.6, 7.2, 7.3, 9 P6; DECISIONS D-105): chores rota, shopping list, house
-- rules, calendar, repairs and issues with photos. Same row-level layer as P5 (schema home, D-096).

create table home.chores (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references home.households(id) on delete cascade,
  title        text not null check (char_length(title) between 1 and 80),
  frequency    text not null check (frequency in ('daily', 'weekly', 'biweekly', 'monthly')),
  rotation     uuid[] not null default '{}',          -- flatmates in turn order
  next_due_on  date not null,
  active       boolean not null default true,
  created_by   uuid references app.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create table home.chore_assignments (
  id        uuid primary key default gen_random_uuid(),
  chore_id  uuid not null references home.chores(id) on delete cascade,
  user_id   uuid references app.users(id) on delete set null,
  due_on    date not null,
  done_at   timestamptz,
  done_by   uuid references app.users(id) on delete set null,
  unique (chore_id, due_on)
);
create table home.shopping_items (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references home.households(id) on delete cascade,
  label        text not null check (char_length(label) between 1 and 80),
  quantity     text check (char_length(quantity) <= 30),
  added_by     uuid references app.users(id) on delete set null,
  done_at      timestamptz,
  done_by      uuid references app.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create table home.house_rules (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references home.households(id) on delete cascade,
  position     smallint not null,
  category     text not null check (category in ('quiet', 'guests', 'cleaning', 'kitchen', 'smoking', 'pets', 'other')),
  text         text not null check (char_length(text) between 1 and 300),
  updated_by   uuid references app.users(id) on delete set null,
  updated_at   timestamptz not null default now()
);
create table home.events (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references home.households(id) on delete cascade,
  title        text not null check (char_length(title) between 1 and 80),
  starts_at    timestamptz not null,
  ends_at      timestamptz,
  all_day      boolean not null default false,
  created_by   uuid references app.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  check (ends_at is null or ends_at >= starts_at)
);
create table home.issues (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references home.households(id) on delete cascade,
  reported_by  uuid references app.users(id) on delete set null,
  title        text not null check (char_length(title) between 1 and 120),
  description  text check (char_length(description) <= 2000),
  category     text not null check (category in ('plumbing', 'electricity', 'heating', 'appliance', 'internet', 'pests', 'structure', 'other')),
  urgency      text not null default 'normal' check (urgency in ('low', 'normal', 'urgent')),
  status       text not null default 'open' check (status in ('open', 'acknowledged', 'in_progress', 'resolved', 'closed')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create table home.issue_events (
  id       bigint generated always as identity primary key,
  issue_id uuid not null references home.issues(id) on delete cascade,
  actor_id uuid references app.users(id) on delete set null,
  status   text,
  comment  text check (char_length(comment) <= 1000),
  at       timestamptz not null default now()
);
-- issue photos: the raw upload (uploads/...) and its processed copy (media/..., EXIF removed, faces and text blurred)
create table home.issue_media (
  id          uuid primary key default gen_random_uuid(),
  issue_id    uuid not null references home.issues(id) on delete cascade,
  raw_key     text not null,
  media_key   text,
  status      text not null default 'pending' check (status in ('pending', 'processed', 'rejected')),
  error_code  text,
  width       int, height int,
  created_by  uuid references app.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['chores', 'chore_assignments', 'shopping_items', 'house_rules', 'events', 'issues', 'issue_events', 'issue_media'] loop
    execute format('alter table home.%I enable row level security', t);
    execute format('alter table home.%I force row level security', t);
  end loop;
end $$;
-- chores and shopping: flatmates only; rules, events, issues: every member (the owner member included, 7.3)
create policy chores_flatmates on home.chores for all
  using (household_id in (select home.my_flatmate_households())) with check (household_id in (select home.my_flatmate_households()));
create policy assignments_flatmates on home.chore_assignments for all
  using (chore_id in (select id from home.chores)) with check (chore_id in (select id from home.chores));
create policy shopping_flatmates on home.shopping_items for all
  using (household_id in (select home.my_flatmate_households())) with check (household_id in (select home.my_flatmate_households()));
create policy rules_members on home.house_rules for all
  using (household_id in (select home.my_households())) with check (household_id in (select home.my_households()));
create policy events_members on home.events for all
  using (household_id in (select home.my_households())) with check (household_id in (select home.my_households()));
create policy issues_members on home.issues for all
  using (household_id in (select home.my_households())) with check (household_id in (select home.my_households()));
create policy issue_events_members on home.issue_events for all
  using (issue_id in (select id from home.issues)) with check (issue_id in (select id from home.issues));
create policy issue_media_members on home.issue_media for all
  using (issue_id in (select id from home.issues)) with check (issue_id in (select id from home.issues));
grant select, insert, update, delete on home.chores, home.chore_assignments, home.shopping_items, home.house_rules, home.events,
  home.issues, home.issue_events, home.issue_media to app_rls;

insert into app.settings (key, value, description) values
  ('issues.max_photos', '6', 'Most photos per repair request')
on conflict (key) do nothing;

-- 1. Chores ---------------------------------------------------------------------------------------------------------------
-- The next person of a chore's rotation: the one after the last assignee, among the flatmates still active, in the
-- rotation's order (a member who left is skipped; PLATFORM_SPEC 9 P6).
create or replace function home.next_in_rotation(p_chore uuid) returns uuid
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  with c as (select * from home.chores where id = p_chore),
  live as (select r.u, r.o from c, unnest(c.rotation) with ordinality r(u, o)
            where exists (select 1 from home.household_members m where m.household_id = c.household_id and m.user_id = r.u
                            and m.role = 'flatmate' and m.status = 'active')),
  last_ as (select a.user_id from home.chore_assignments a where a.chore_id = p_chore order by a.due_on desc limit 1),
  pos as (select coalesce((select o from c, unnest(c.rotation) with ordinality r(u, o) where r.u = (select user_id from last_)), 0) as p)
  select coalesce((select u from live, pos where o > pos.p order by o limit 1), (select u from live order by o limit 1))
$$;

-- superuser-owned like the membership helpers: the daily job (acting for nobody) uses it too; it returns one user id
revoke execute on function home.next_in_rotation(uuid) from public;
grant execute on function home.next_in_rotation(uuid) to app_rls;

create or replace function api._step(p_freq text) returns interval
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case p_freq when 'daily' then interval '1 day' when 'weekly' then interval '7 days' when 'biweekly' then interval '14 days'
                     else interval '1 month' end
$$;

create or replace function api._chore_json(c home.chores) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('chore_id', c.id, 'title', c.title, 'frequency', c.frequency, 'next_due_on', c.next_due_on, 'active', c.active,
    'rotation', coalesce((select jsonb_agg(api._name(u) order by o) from unnest(c.rotation) with ordinality r(u, o)), '[]'),
    'next_person', api._name(home.next_in_rotation(c.id)),
    'assignments', coalesce((select jsonb_agg(jsonb_build_object('assignment_id', a.id, 'user', api._name(a.user_id), 'due_on', a.due_on,
                               'done', a.done_at is not null, 'done_by', api._name(a.done_by), 'mine', a.user_id = app.current_user_id())
                               order by a.due_on desc)
                             from (select * from home.chore_assignments where chore_id = c.id order by due_on desc limit 8) a), '[]'))
$$;

create or replace function api.chores_list(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb;
begin
  perform api._as(p_user);
  e := api._need(v_id, 'flatmate'); if e is not null then return e; end if;
  return api._ok(jsonb_build_object('items', coalesce((select jsonb_agg(api._chore_json(c) order by c.active desc, c.next_due_on, c.title)
                                                         from home.chores c where c.household_id = v_id), '[]')));
end $$;

-- POST /v1/households/{id}/chores {title, frequency, rotation, next_due_on}; rotation: flatmate ids (default: all, join order)
create or replace function api.chore_create(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb; b jsonb := coalesce(p->'body', '{}'); rot uuid[]; c home.chores; h home.households;
begin
  perform api._as(p_user);
  e := api._need(v_id, 'flatmate'); if e is not null then return e; end if;
  h := api._hh(v_id);
  rot := case when jsonb_typeof(b->'rotation') = 'array' and jsonb_array_length(b->'rotation') > 0
              then array(select (x)::uuid from jsonb_array_elements_text(b->'rotation') x) else api._flatmates(v_id) end;
  if exists (select 1 from unnest(rot) u where not u = any(api._flatmates(v_id))) then
    return api._err(422, 'VALIDATION_FAILED', 'Request is invalid', '[{"field": "rotation", "issue": "not_a_flatmate"}]');
  end if;
  insert into home.chores (household_id, title, frequency, rotation, next_due_on, created_by)
  values (v_id, btrim(b->>'title'), coalesce(b->>'frequency', 'weekly'), rot,
          coalesce((b->>'next_due_on')::date, (now() at time zone h.timezone)::date), p_user) returning * into c;
  return api._ok(api._chore_json(c), 201);
end $$;

-- PATCH /v1/households/{id}/chores/{chore_id} {title, frequency, rotation, next_due_on, active}
create or replace function api.chore_update(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb; b jsonb := coalesce(p->'body', '{}'); c home.chores; rot uuid[];
begin
  perform api._as(p_user);
  e := api._need(v_id, 'flatmate'); if e is not null then return e; end if;
  select * into c from home.chores where id = (p#>>'{params,chore_id}')::uuid and household_id = v_id;
  if c.id is null then return api._err(404, 'NOT_FOUND', 'Chore not found'); end if;
  if b ? 'rotation' then
    rot := array(select (x)::uuid from jsonb_array_elements_text(b->'rotation') x);
    if exists (select 1 from unnest(rot) u where not u = any(api._flatmates(v_id))) then
      return api._err(422, 'VALIDATION_FAILED', 'Request is invalid', '[{"field": "rotation", "issue": "not_a_flatmate"}]');
    end if;
  end if;
  update home.chores set title = coalesce(btrim(b->>'title'), title), frequency = coalesce(b->>'frequency', frequency),
         rotation = coalesce(rot, rotation), next_due_on = coalesce((b->>'next_due_on')::date, next_due_on),
         active = coalesce((b->>'active')::boolean, active)
   where id = c.id returning * into c;
  return api._ok(api._chore_json(c));
end $$;

-- POST /v1/chore-assignments/{id}/done: any flatmate marks it done (who did it is recorded)
create or replace function api.chore_done(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare a home.chore_assignments; c home.chores;
begin
  perform api._as(p_user);
  select * into a from home.chore_assignments where id = (p#>>'{params,id}')::uuid;
  if a.id is null then return api._err(404, 'NOT_FOUND', 'Assignment not found'); end if;
  update home.chore_assignments set done_at = coalesce(done_at, now()), done_by = coalesce(done_by, p_user) where id = a.id returning * into a;
  select * into c from home.chores where id = a.chore_id;
  return api._ok(api._chore_json(c));
end $$;

-- The daily part of chores (acts for nobody, 7.1): every active chore due on or before today gets its assignment for
-- that date, to the next person of the rotation, and its next date moves on by its frequency. Once per chore and date.
create or replace function home.daily_chores(p_today date default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare c record; v_today date; v_user uuid; n int := 0; v_override date; guard int;
begin
  v_override := (select nullif(value #>> '{}', '')::date from app.settings where key = 'household.today_override');
  for c in select ch.*, h.timezone from home.chores ch join home.households h on h.id = ch.household_id
            where ch.active and h.status = 'active' loop
    v_today := coalesce(p_today, v_override, (now() at time zone c.timezone)::date);
    guard := 0;
    while c.next_due_on <= v_today and guard < 60 loop
      guard := guard + 1;
      v_user := home.next_in_rotation(c.id);
      exit when v_user is null;
      insert into home.chore_assignments (chore_id, user_id, due_on) values (c.id, v_user, c.next_due_on) on conflict do nothing;
      if found then
        perform api.notify_emit(v_user, 'chore_assigned', jsonb_build_object('title', c.title, 'due_on', c.next_due_on), 'household', c.household_id::text);
        n := n + 1;
      end if;
      c.next_due_on := (c.next_due_on + api._step(c.frequency))::date;
      update home.chores set next_due_on = c.next_due_on where id = c.id;
    end loop;
  end loop;
  return jsonb_build_object('assignments', n);
end $$;
revoke execute on function home.daily_chores(date) from public;
grant execute on function home.daily_chores(date) to n8n_worker;

-- 2. Shopping list ---------------------------------------------------------------------------------------------------------
create or replace function api._shop_json(s home.shopping_items) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('item_id', s.id, 'label', s.label, 'quantity', s.quantity, 'done', s.done_at is not null,
                            'added_by', api._name(s.added_by), 'done_by', api._name(s.done_by), 'created_at', s.created_at)
$$;
create or replace function api.shopping_list(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb;
begin
  perform api._as(p_user);
  e := api._need(v_id, 'flatmate'); if e is not null then return e; end if;
  return api._ok(jsonb_build_object('items', coalesce((select jsonb_agg(api._shop_json(s) order by s.done_at is not null, s.created_at desc)
    from home.shopping_items s where s.household_id = v_id and (s.done_at is null or s.done_at > now() - interval '7 days')), '[]')));
end $$;
create or replace function api.shopping_add(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb; s home.shopping_items;
begin
  perform api._as(p_user);
  e := api._need(v_id, 'flatmate'); if e is not null then return e; end if;
  insert into home.shopping_items (household_id, label, quantity, added_by)
  values (v_id, btrim(p#>>'{body,label}'), nullif(btrim(coalesce(p#>>'{body,quantity}', '')), ''), p_user) returning * into s;
  return api._ok(api._shop_json(s), 201);
end $$;
create or replace function api.shopping_update(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb; b jsonb := coalesce(p->'body', '{}'); s home.shopping_items;
begin
  perform api._as(p_user);
  e := api._need(v_id, 'flatmate'); if e is not null then return e; end if;
  update home.shopping_items set label = coalesce(btrim(b->>'label'), label), quantity = coalesce(b->>'quantity', quantity),
         done_at = case when b ? 'done' then case when (b->>'done')::boolean then coalesce(done_at, now()) end else done_at end,
         done_by = case when b ? 'done' then case when (b->>'done')::boolean then coalesce(done_by, p_user) end else done_by end
   where id = (p#>>'{params,item_id}')::uuid and household_id = v_id returning * into s;
  if s.id is null then return api._err(404, 'NOT_FOUND', 'Item not found'); end if;
  return api._ok(api._shop_json(s));
end $$;

-- 3. House rules --------------------------------------------------------------------------------------------------------------
create or replace function api.rules_get(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb;
begin
  perform api._as(p_user);
  e := api._need(v_id); if e is not null then return e; end if;
  return api._ok(jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('category', r.category, 'text', r.text)
      order by r.position) from home.house_rules r where r.household_id = v_id), '[]'),
    'updated_at', (select max(updated_at) from home.house_rules where household_id = v_id),
    'updated_by', (select api._name(updated_by) from home.house_rules where household_id = v_id order by updated_at desc limit 1)));
end $$;
create or replace function api.rules_put(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb;
begin
  perform api._as(p_user);
  e := api._need(v_id); if e is not null then return e; end if;
  delete from home.house_rules where household_id = v_id;
  insert into home.house_rules (household_id, position, category, text, updated_by)
  select v_id, o, coalesce(x->>'category', 'other'), btrim(x->>'text'), p_user
    from jsonb_array_elements(coalesce(p#>'{body,items}', '[]')) with ordinality r(x, o);
  perform api.notify_emit(m.user_id, 'rules_changed', '{}'::jsonb, 'household', v_id::text)
     from home.household_members m where m.household_id = v_id and m.user_id <> p_user and m.status = 'active';
  return api.rules_get(p_user, p);
end $$;

-- 4. Calendar: the household's own events, plus what is computed (not copied, 7.2): rent and bill due dates, chore
--    assignments (flatmates), move dates of members, the caller's own confirmed visits.
create or replace function api.calendar_get(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb; h home.households; v_from date; v_to date; items jsonb := '[]';
begin
  perform api._as(p_user);
  e := api._need(v_id); if e is not null then return e; end if;
  h := api._hh(v_id);
  v_from := coalesce((p#>>'{query,from}')::date, (now() at time zone h.timezone)::date);
  v_to := coalesce((p#>>'{query,to}')::date, v_from + 30);
  if v_to < v_from or v_to - v_from > 92 then
    return api._err(422, 'VALIDATION_FAILED', 'Request is invalid', '[{"field": "to", "issue": "range_too_long", "max_days": 92}]');
  end if;
  select coalesce(jsonb_agg(x order by x->>'date', x->>'kind'), '[]') into items from (
    select jsonb_build_object('kind', 'event', 'id', ev.id, 'title', ev.title, 'date', (ev.starts_at at time zone h.timezone)::date,
             'starts_at', ev.starts_at, 'ends_at', ev.ends_at, 'all_day', ev.all_day, 'can_delete', ev.created_by = p_user) as x
      from home.events ev where ev.household_id = v_id and (ev.starts_at at time zone h.timezone)::date between v_from and v_to
    union all
    select jsonb_build_object('kind', r.kind, 'id', r.id, 'title', r.label, 'date', d::date)
      from home.recurring_items r, generate_series(date_trunc('month', v_from), v_to, interval '1 month') m(d0),
           lateral (select make_date(extract(year from m.d0)::int, extract(month from m.d0)::int, r.due_day) as d) dd
     where r.household_id = v_id and r.active and dd.d between v_from and v_to
    union all
    select jsonb_build_object('kind', 'chore', 'id', a.id, 'title', c.title, 'date', a.due_on, 'user', api._name(a.user_id), 'done', a.done_at is not null)
      from home.chore_assignments a join home.chores c on c.id = a.chore_id
     where c.household_id = v_id and a.due_on between v_from and v_to
    union all
    select jsonb_build_object('kind', case when m.move_in_on between v_from and v_to then 'move_in' else 'move_out' end, 'id', m.user_id,
             'title', (api._name(m.user_id))->>'display_name', 'date', case when m.move_in_on between v_from and v_to then m.move_in_on else m.move_out_on end)
      from home.household_members m where m.household_id = v_id and m.status <> 'left'
       and (m.move_in_on between v_from and v_to or m.move_out_on between v_from and v_to)
    union all
    select jsonb_build_object('kind', 'visit', 'id', v.id, 'title', (select title from app.listings where id = v.listing_id),
             'date', (v.starts_at at time zone h.timezone)::date, 'starts_at', v.starts_at)
      from social.visits v where v.status = 'confirmed' and (v.starts_at at time zone h.timezone)::date between v_from and v_to
  ) q;
  return api._ok(jsonb_build_object('from', v_from, 'to', v_to, 'timezone', h.timezone, 'items', items));
end $$;

create or replace function api.event_create(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb; b jsonb := coalesce(p->'body', '{}'); ev home.events;
begin
  perform api._as(p_user);
  e := api._need(v_id); if e is not null then return e; end if;
  if (b->>'ends_at') is not null and (b->>'ends_at')::timestamptz < (b->>'starts_at')::timestamptz then
    return api._err(422, 'VALIDATION_FAILED', 'Request is invalid', '[{"field": "ends_at", "issue": "before_start"}]');
  end if;
  insert into home.events (household_id, title, starts_at, ends_at, all_day, created_by)
  values (v_id, btrim(b->>'title'), (b->>'starts_at')::timestamptz, (b->>'ends_at')::timestamptz, coalesce((b->>'all_day')::boolean, false), p_user)
  returning * into ev;
  return api._ok(jsonb_build_object('event_id', ev.id, 'title', ev.title, 'starts_at', ev.starts_at), 201);
end $$;
create or replace function api.event_delete(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb; ev home.events;
begin
  perform api._as(p_user);
  e := api._need(v_id); if e is not null then return e; end if;
  select * into ev from home.events where id = (p#>>'{params,event_id}')::uuid and household_id = v_id;
  if ev.id is null then return api._err(404, 'NOT_FOUND', 'Event not found'); end if;
  if ev.created_by is distinct from p_user then return api._err(403, 'FORBIDDEN', 'Only who added it can delete it'); end if;
  delete from home.events where id = ev.id;
  return api._ok(jsonb_build_object('event_id', ev.id, 'deleted', true));
end $$;

-- 5. Repairs and issues ----------------------------------------------------------------------------------------------------------
create or replace function api._issue_json(i home.issues) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('issue_id', i.id, 'title', i.title, 'description', i.description, 'category', i.category, 'urgency', i.urgency,
    'status', i.status, 'reported_by', api._name(i.reported_by), 'created_at', i.created_at, 'updated_at', i.updated_at,
    'events', coalesce((select jsonb_agg(jsonb_build_object('status', e.status, 'comment', e.comment, 'at', e.at, 'by', api._name(e.actor_id))
                         order by e.id) from home.issue_events e where e.issue_id = i.id), '[]'),
    'photo_keys', coalesce((select jsonb_agg(m.media_key order by m.created_at) from home.issue_media m where m.issue_id = i.id and m.status = 'processed'), '[]'),
    'photos_pending', (select count(*) from home.issue_media m where m.issue_id = i.id and m.status = 'pending'))
$$;

create or replace function api.issues_list(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb;
begin
  perform api._as(p_user);
  e := api._need(v_id); if e is not null then return e; end if;
  return api._ok(jsonb_build_object('items', coalesce((select jsonb_agg(api._issue_json(i) order by i.status in ('resolved', 'closed'), i.updated_at desc)
    from home.issues i where i.household_id = v_id), '[]'), 'my_role', api._my_role(v_id)));
end $$;

create or replace function api.issue_create(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb; b jsonb := coalesce(p->'body', '{}'); i home.issues;
begin
  perform api._as(p_user);
  e := api._need(v_id); if e is not null then return e; end if;
  insert into home.issues (household_id, reported_by, title, description, category, urgency)
  values (v_id, p_user, btrim(b->>'title'), nullif(btrim(coalesce(b->>'description', '')), ''), coalesce(b->>'category', 'other'),
          coalesce(b->>'urgency', 'normal')) returning * into i;
  insert into home.issue_events (issue_id, actor_id, status) values (i.id, p_user, 'open');
  -- the owner member is told first; the other flatmates too
  perform api.notify_emit(m.user_id, case when m.role = 'owner' then 'issue_reported_owner' else 'issue_reported' end,
            jsonb_build_object('title', i.title, 'urgency', i.urgency), 'household', v_id::text)
     from home.household_members m where m.household_id = v_id and m.user_id <> p_user and m.status = 'active';
  return api._ok(api._issue_json(i), 201);
end $$;

-- POST /v1/issues/{id}/updates {status, comment}: the owner member moves it on (acknowledged, in_progress, resolved);
-- the flatmates comment, close it or open it again
create or replace function api.issue_update(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare i home.issues; b jsonb := coalesce(p->'body', '{}'); e jsonb; v_role text; v_st text := b->>'status';
begin
  perform api._as(p_user);
  select * into i from home.issues where id = (p#>>'{params,id}')::uuid;
  if i.id is null then return api._err(404, 'NOT_FOUND', 'Issue not found'); end if;
  e := api._need(i.household_id); if e is not null then return e; end if;
  v_role := api._my_role(i.household_id);
  if v_st is not null and ((v_role = 'owner' and v_st not in ('acknowledged', 'in_progress', 'resolved'))
                            or (v_role = 'flatmate' and v_st not in ('closed', 'open'))) then
    return api._err(403, 'FORBIDDEN', 'Not allowed for your role');
  end if;
  update home.issues set status = coalesce(v_st, status), updated_at = now() where id = i.id returning * into i;
  insert into home.issue_events (issue_id, actor_id, status, comment) values (i.id, p_user, v_st, nullif(btrim(coalesce(b->>'comment', '')), ''));
  perform api.notify_emit(m.user_id, 'issue_updated', jsonb_build_object('title', i.title, 'status', i.status), 'household', i.household_id::text)
     from home.household_members m where m.household_id = i.household_id and m.user_id <> p_user and m.status = 'active';
  return api._ok(api._issue_json(i));
end $$;

-- Photos of an issue: slots for presigned uploads (the workflow signs them), then the processed copies.
create or replace function api.issue_photo_slots(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare i home.issues; e jsonb; n int := coalesce(jsonb_array_length(p#>'{body,files}'), 0); v_max int := api._setting_int('issues.max_photos', 6);
  slots jsonb := '[]'; f jsonb; v_slot uuid;
begin
  perform api._as(p_user);
  select * into i from home.issues where id = (p#>>'{params,id}')::uuid;
  if i.id is null then return api._err(404, 'NOT_FOUND', 'Issue not found'); end if;
  e := api._need(i.household_id); if e is not null then return e; end if;
  if n + (select count(*) from home.issue_media where issue_id = i.id and status <> 'rejected') > v_max then
    return api._err(422, 'VALIDATION_FAILED', 'Request is invalid', jsonb_build_array(jsonb_build_object('field', 'files', 'issue', 'too_many', 'max', v_max)));
  end if;
  for f in select * from jsonb_array_elements(p#>'{body,files}') loop
    v_slot := gen_random_uuid();
    insert into home.issue_media (id, issue_id, raw_key, created_by)
    values (v_slot, i.id, format('uploads/issues/%s/%s', i.id, v_slot), p_user);
    slots := slots || jsonb_build_object('upload_id', v_slot, 'key', format('uploads/issues/%s/%s', i.id, v_slot), 'content_type', f->>'content_type');
  end loop;
  return api._ok(jsonb_build_object('issue_id', i.id, 'slots', slots,
    'media_url', (select value #>> '{}' from app.settings where key = 'services.media_url')));
end $$;

create or replace function api.issue_photos_pending(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare i home.issues; e jsonb;
begin
  perform api._as(p_user);
  select * into i from home.issues where id = (p#>>'{params,id}')::uuid;
  if i.id is null then return api._err(404, 'NOT_FOUND', 'Issue not found'); end if;
  e := api._need(i.household_id); if e is not null then return e; end if;
  return api._ok(jsonb_build_object('issue_id', i.id, 'media_url', (select value #>> '{}' from app.settings where key = 'services.media_url'),
    'pending', coalesce((select jsonb_agg(jsonb_build_object('upload_id', m.id, 'raw_key', m.raw_key,
                           'media_key', format('media/issues/%s/%s.jpg', i.id, m.id)) order by m.created_at)
                         from home.issue_media m where m.issue_id = i.id and m.status = 'pending'), '[]')));
end $$;

-- the Media service's answer for one photo: processed (EXIF removed, faces and text blurred) or rejected
create or replace function api.issue_photo_store(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare r jsonb;
begin
  perform api._as(p_user);
  for r in select * from jsonb_array_elements(coalesce(p->'results', '[]')) loop
    update home.issue_media set status = case when (r->>'ok')::boolean then 'processed' else 'rejected' end,
           media_key = case when (r->>'ok')::boolean then r->>'media_key' end, error_code = r->>'error_code',
           width = (r->>'width')::int, height = (r->>'height')::int
     where id = (r->>'upload_id')::uuid and status = 'pending';
  end loop;
  return api.issue_photos_pending(p_user, p);
end $$;

do $$
declare f text;
  internal text[] := array['api._step(text)', 'api._chore_json(home.chores)', 'api._shop_json(home.shopping_items)',
    'api._issue_json(home.issues)'];
  public_ text[] := array['api.chores_list(uuid, jsonb)', 'api.chore_create(uuid, jsonb)', 'api.chore_update(uuid, jsonb)', 'api.chore_done(uuid, jsonb)',
    'api.shopping_list(uuid, jsonb)', 'api.shopping_add(uuid, jsonb)', 'api.shopping_update(uuid, jsonb)', 'api.rules_get(uuid, jsonb)',
    'api.rules_put(uuid, jsonb)', 'api.calendar_get(uuid, jsonb)', 'api.event_create(uuid, jsonb)', 'api.event_delete(uuid, jsonb)',
    'api.issues_list(uuid, jsonb)', 'api.issue_create(uuid, jsonb)', 'api.issue_update(uuid, jsonb)', 'api.issue_photo_slots(uuid, jsonb)',
    'api.issue_photos_pending(uuid, jsonb)', 'api.issue_photo_store(uuid, jsonb)'];
begin
  foreach f in array internal || public_ loop
    execute format('alter function %s owner to app_rls', f);
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to app_rls', f);
  end loop;
  foreach f in array public_ loop execute format('grant execute on function %s to n8n_worker', f); end loop;
end $$;

-- migrate:down
drop function if exists api.issue_photo_store(uuid, jsonb), api.issue_photos_pending(uuid, jsonb), api.issue_photo_slots(uuid, jsonb),
  api.issue_update(uuid, jsonb), api.issue_create(uuid, jsonb), api.issues_list(uuid, jsonb), api._issue_json(home.issues),
  api.event_delete(uuid, jsonb), api.event_create(uuid, jsonb), api.calendar_get(uuid, jsonb), api.rules_put(uuid, jsonb), api.rules_get(uuid, jsonb),
  api.shopping_update(uuid, jsonb), api.shopping_add(uuid, jsonb), api.shopping_list(uuid, jsonb), api._shop_json(home.shopping_items),
  home.daily_chores(date), api.chore_done(uuid, jsonb), api.chore_update(uuid, jsonb), api.chore_create(uuid, jsonb), api.chores_list(uuid, jsonb),
  api._chore_json(home.chores), api._step(text), home.next_in_rotation(uuid);
drop table if exists home.issue_media, home.issue_events, home.issues, home.events, home.house_rules, home.shopping_items,
  home.chore_assignments, home.chores;
delete from app.settings where key = 'issues.max_photos';
