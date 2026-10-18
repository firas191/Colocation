-- migrate:up
-- Platform phase P5 (docs/PLATFORM_SPEC.md 3.6, 7.2, 7.3, 9 P5; DECISIONS D-104): households, invites, members,
-- shared expenses with three split modes, balances and suggested settlements, settlements, recurring rent and bills
-- with a daily reminder, rent payments confirmed by the owner member, announcements. Every table is behind the
-- row-level layer (D-096): schema home, RLS forced, functions as app_rls with the caller set first.
-- Money is in minor units with the household's currency (exponent from app.currencies).

insert into app.settings (key, value, description) values
  ('household.invite_days', '7', 'How long a household invite code is valid'),
  ('household.today_override', 'null', 'Tests only: the date the daily household workflow takes as today (null: the real date)')
on conflict (key) do nothing;

-- 1. Tables ---------------------------------------------------------------------------------------------------------
create table home.households (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (char_length(name) between 1 and 80),
  jurisdiction_code text not null references app.jurisdictions(code),
  currency          char(3) not null references app.currencies(code),
  timezone          text not null,
  listing_id        uuid references app.listings(id) on delete set null,
  address_text      text check (char_length(address_text) <= 300),       -- members only
  status            text not null default 'active' check (status in ('active', 'closed')),
  created_by        uuid references app.users(id) on delete set null,
  created_at        timestamptz not null default now()
);
create table home.household_members (
  household_id uuid not null references home.households(id) on delete cascade,
  user_id      uuid not null references app.users(id) on delete cascade,
  role         text not null default 'flatmate' check (role in ('flatmate', 'owner')),
  status       text not null default 'active' check (status in ('active', 'leaving', 'left')),
  joined_at    timestamptz not null default now(),
  move_in_on   date,
  move_out_on  date,
  primary key (household_id, user_id)
);
create index household_members_user on home.household_members (user_id);
create table home.household_invites (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references home.households(id) on delete cascade,
  code_hash    bytea unique,                         -- sha256 of the code, shown once; null for a personal invite
  for_user     uuid references app.users(id) on delete cascade,  -- personal invite (an accepted application)
  role         text not null default 'flatmate' check (role in ('flatmate', 'owner')),
  expires_at   timestamptz not null,
  used_by      uuid references app.users(id) on delete set null,
  used_at      timestamptz,
  created_by   uuid references app.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  check (code_hash is not null or for_user is not null)
);
create table home.expenses (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references home.households(id) on delete cascade,
  paid_by      uuid references app.users(id) on delete set null,
  amount_minor bigint not null check (amount_minor > 0),
  currency     char(3) not null references app.currencies(code),
  category     text not null check (category in ('rent', 'utilities', 'internet', 'groceries', 'household', 'other')),
  label        text not null check (char_length(label) between 1 and 120),
  spent_on     date not null,
  split_mode   text not null check (split_mode in ('equal', 'shares', 'exact')),
  created_by   uuid references app.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
create index expenses_household on home.expenses (household_id, spent_on desc);
create table home.expense_shares (
  expense_id  uuid not null references home.expenses(id) on delete cascade,
  user_id     uuid not null references app.users(id) on delete cascade,
  share_minor bigint not null check (share_minor >= 0),
  primary key (expense_id, user_id)
);
create table home.settlements (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references home.households(id) on delete cascade,
  from_user    uuid references app.users(id) on delete set null,
  to_user      uuid references app.users(id) on delete set null,
  amount_minor bigint not null check (amount_minor > 0),
  settled_on   date not null,
  confirmed_at timestamptz,
  created_by   uuid references app.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  check (from_user is distinct from to_user)
);
create table home.recurring_items (
  id                 uuid primary key default gen_random_uuid(),
  household_id       uuid not null references home.households(id) on delete cascade,
  kind               text not null check (kind in ('rent', 'bill')),
  label              text not null check (char_length(label) between 1 and 80),
  amount_minor       bigint check (amount_minor > 0),
  due_day            smallint not null check (due_day between 1 and 28),
  remind_days_before smallint not null default 3 check (remind_days_before between 0 and 14),
  active             boolean not null default true,
  created_at         timestamptz not null default now()
);
create table home.rent_payments (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references home.households(id) on delete cascade,
  user_id      uuid references app.users(id) on delete set null,
  period       char(7) not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  amount_minor bigint not null check (amount_minor > 0),
  paid_on      date not null,
  confirmed_by uuid references app.users(id) on delete set null,
  confirmed_at timestamptz,
  created_at   timestamptz not null default now()
);
create table home.announcements (
  id           bigint generated always as identity primary key,
  household_id uuid not null references home.households(id) on delete cascade,
  author_id    uuid references app.users(id) on delete set null,
  body         text not null check (char_length(body) between 1 and 2000),
  pinned       boolean not null default false,
  created_at   timestamptz not null default now()
);
-- what the daily workflow already sent (one reminder per item and due date)
create table home.reminder_log (
  item_id  uuid not null references home.recurring_items(id) on delete cascade,
  due_on   date not null,
  sent_at  timestamptz not null default now(),
  primary key (item_id, due_on)
);

-- 2. Row-level rules (PLATFORM_SPEC 7.3) ------------------------------------------------------------------------------
-- Helpers owned by the migration's superuser: they answer only about the caller (7.1 point 5).
create or replace function home.my_households() returns setof uuid
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select household_id from home.household_members where user_id = app.current_user_id() and status in ('active', 'leaving')
$$;
create or replace function home.my_flatmate_households() returns setof uuid
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select household_id from home.household_members
   where user_id = app.current_user_id() and status in ('active', 'leaving') and role = 'flatmate'
$$;
create or replace function home.household_creator(p_id uuid) returns uuid
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select created_by from home.households where id = p_id
$$;
-- An invite by its code or its id, for the user redeeming it, who is not a member yet: checks it and adds the member.
-- Returns {household_id, role} or {error: not_found | expired | used | already_member}.
create or replace function home.redeem_invite(p_hash bytea, p_invite uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare i home.household_invites; v_user uuid := app.current_user_id(); h home.households;
begin
  if v_user is null then return jsonb_build_object('error', 'not_found'); end if;
  select * into i from home.household_invites
   where (p_hash is not null and code_hash = p_hash) or (p_invite is not null and id = p_invite and for_user = v_user) for update;
  if i.id is null then return jsonb_build_object('error', 'not_found'); end if;
  select * into h from home.households where id = i.household_id;
  if h.status <> 'active' then return jsonb_build_object('error', 'not_found'); end if;
  if i.used_at is not null then return jsonb_build_object('error', 'used'); end if;
  if i.expires_at < now() then return jsonb_build_object('error', 'expired'); end if;
  if exists (select 1 from home.household_members where household_id = i.household_id and user_id = v_user and status <> 'left') then
    return jsonb_build_object('error', 'already_member');
  end if;
  insert into home.household_members (household_id, user_id, role, status, joined_at, move_out_on)
  values (i.household_id, v_user, i.role, 'active', now(), null)
  on conflict (household_id, user_id) do update set status = 'active', role = excluded.role, joined_at = now(), move_out_on = null;
  update home.household_invites set used_by = v_user, used_at = now() where id = i.id;
  return jsonb_build_object('household_id', i.household_id, 'role', i.role);
end $$;
revoke execute on function home.my_households(), home.my_flatmate_households(), home.household_creator(uuid),
  home.redeem_invite(bytea, uuid) from public;
grant execute on function home.my_households(), home.my_flatmate_households(), home.household_creator(uuid),
  home.redeem_invite(bytea, uuid) to app_rls;

do $$
declare t text;
begin
  foreach t in array array['households', 'household_members', 'household_invites', 'expenses', 'expense_shares', 'settlements',
                           'recurring_items', 'rent_payments', 'announcements', 'reminder_log'] loop
    execute format('alter table home.%I enable row level security', t);
    execute format('alter table home.%I force row level security', t);
  end loop;
end $$;

create policy households_member on home.households for select using (id in (select home.my_households()));
create policy households_create on home.households for insert with check (created_by = app.current_user_id());
create policy members_read on home.household_members for select using (household_id in (select home.my_households()));
create policy members_first on home.household_members for insert
  with check (user_id = app.current_user_id() and home.household_creator(household_id) = app.current_user_id());
create policy members_self on home.household_members for update
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy invites_read on home.household_invites for select
  using (household_id in (select home.my_households()) or for_user = app.current_user_id());
create policy invites_create on home.household_invites for insert
  with check (created_by = app.current_user_id() and household_id in (select home.my_households()));
-- money and the shopping-type data: flatmates only (the owner member does not see them, 7.3)
create policy expenses_flatmates on home.expenses for select using (household_id in (select home.my_flatmate_households()));
create policy expenses_add on home.expenses for insert
  with check (created_by = app.current_user_id() and household_id in (select home.my_flatmate_households()));
create policy expenses_delete_own on home.expenses for update
  using (created_by = app.current_user_id() and household_id in (select home.my_flatmate_households()))
  with check (created_by = app.current_user_id());
create policy shares_flatmates on home.expense_shares for select using (expense_id in (select id from home.expenses));
create policy shares_add on home.expense_shares for insert with check (expense_id in (select id from home.expenses));
create policy settlements_flatmates on home.settlements for select using (household_id in (select home.my_flatmate_households()));
create policy settlements_add on home.settlements for insert
  with check (created_by = app.current_user_id() and household_id in (select home.my_flatmate_households()));
-- rent and bills, rent payments, announcements: every member, the owner member included
create policy recurring_members on home.recurring_items for select using (household_id in (select home.my_households()));
create policy recurring_write on home.recurring_items for all
  using (household_id in (select home.my_households())) with check (household_id in (select home.my_households()));
create policy rent_members on home.rent_payments for select using (household_id in (select home.my_households()));
create policy rent_add on home.rent_payments for insert
  with check (user_id = app.current_user_id() and household_id in (select home.my_households()));
create policy rent_confirm on home.rent_payments for update
  using (household_id in (select home.my_households())) with check (household_id in (select home.my_households()));
create policy announcements_members on home.announcements for select using (household_id in (select home.my_households()));
create policy announcements_add on home.announcements for insert
  with check (author_id = app.current_user_id() and household_id in (select home.my_households()));
-- reminder_log: only the daily function (superuser-owned) writes it; no policy for app_rls

grant usage on schema home to app_rls;
grant select, insert on home.households, home.household_invites, home.expense_shares, home.settlements, home.announcements to app_rls;
grant select, insert, update on home.household_members, home.expenses, home.rent_payments to app_rls;
grant select, insert, update, delete on home.recurring_items to app_rls;
grant select (code, default_currency, timezone) on app.jurisdictions to app_rls;

-- 3. Helpers --------------------------------------------------------------------------------------------------------------
create or replace function api._hh(p_id uuid) returns home.households
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select * from home.households where id = p_id
$$;
create or replace function api._my_role(p_id uuid) returns text
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select role from home.household_members where household_id = p_id and user_id = app.current_user_id() and status in ('active', 'leaving')
$$;
create or replace function api._exp(p_currency text) returns int
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce((select exponent from app.currencies where code = p_currency), 2)
$$;
create or replace function api._money(p_minor bigint, p_currency text) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('amount_minor', p_minor, 'currency', p_currency, 'exponent', api._exp(p_currency))
$$;
-- 404 unless the caller is an active member (with the given role, when one is required)
create or replace function api._need(p_id uuid, p_role text default null) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select case when api._my_role(p_id) is null then api._err(404, 'NOT_FOUND', 'Household not found')
              when p_role is not null and api._my_role(p_id) <> p_role then api._err(403, 'FORBIDDEN', 'Not allowed for your role') end
$$;
-- the active flatmates in join order (the order leftover minor units are given in, 7.2)
create or replace function api._flatmates(p_id uuid) returns uuid[]
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce(array_agg(user_id order by joined_at, user_id), '{}') from home.household_members
   where household_id = p_id and role = 'flatmate' and status in ('active', 'leaving')
$$;

-- 4. Split arithmetic (pure: no table read). PLATFORM_SPEC 7.2: the shares always sum to the amount.
--    equal: each gets the integer part; the leftover minor units go one by one in the order given (join order).
--    shares: weights; each gets floor(amount * w / total); the leftover goes one by one in the order given.
--    exact: the amounts given, which must sum to the amount.
create or replace function api.split(p_amount bigint, p_mode text, p_users uuid[], p_values bigint[]) returns jsonb
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare n int := coalesce(array_length(p_users, 1), 0); s bigint[]; tot bigint; left_ bigint; i int;
begin
  if n = 0 then return jsonb_build_object('error', 'no_participant'); end if;
  if p_mode = 'equal' then
    s := array_fill(p_amount / n, array[n]);
  elsif p_mode = 'shares' then
    if p_values is null or array_length(p_values, 1) <> n or exists (select 1 from unnest(p_values) v where v < 0) then
      return jsonb_build_object('error', 'invalid_shares'); end if;
    tot := (select sum(v) from unnest(p_values) v);
    if tot is null or tot = 0 then return jsonb_build_object('error', 'invalid_shares'); end if;
    s := array(select (p_amount * v) / tot from unnest(p_values) with ordinality u(v, o) order by o);
  elsif p_mode = 'exact' then
    if p_values is null or array_length(p_values, 1) <> n or exists (select 1 from unnest(p_values) v where v < 0) then
      return jsonb_build_object('error', 'invalid_amounts'); end if;
    if (select sum(v) from unnest(p_values) v) <> p_amount then
      return jsonb_build_object('error', 'sum_differs', 'sum', (select sum(v) from unnest(p_values) v), 'amount', p_amount);
    end if;
    s := p_values;
  else
    return jsonb_build_object('error', 'invalid_mode');
  end if;
  left_ := p_amount - (select sum(v) from unnest(s) v);
  i := 1;
  while left_ > 0 loop
    -- shares mode: a zero weight never receives leftover units
    if p_mode <> 'shares' or p_values[i] > 0 then s[i] := s[i] + 1; left_ := left_ - 1; end if;
    i := i % n + 1;
  end loop;
  return jsonb_build_object('shares', (select jsonb_agg(jsonb_build_object('user_id', p_users[o], 'share_minor', s[o]) order by o)
                                         from generate_subscripts(s, 1) o));
end $$;

-- Balances (pure over the given rows): paid minus owed, plus settlements paid, minus settlements received.
-- Positive: the others owe this member. Suggested settlements: the largest debtor pays the largest creditor, until
-- every balance is zero (at most n - 1 transfers).
create or replace function api.settle_plan(p_balances jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare b jsonb := p_balances; out_ jsonb := '[]'; d record; c record; x bigint; guard int := 0;
begin
  loop
    guard := guard + 1; exit when guard > 200;
    select e.key as u, (e.value)::bigint as v into d from jsonb_each(b) e where (e.value)::bigint < 0 order by (e.value)::bigint, e.key limit 1;
    select e.key as u, (e.value)::bigint as v into c from jsonb_each(b) e where (e.value)::bigint > 0 order by (e.value)::bigint desc, e.key limit 1;
    exit when d.u is null or c.u is null;
    x := least(-d.v, c.v);
    out_ := out_ || jsonb_build_object('from_user', d.u, 'to_user', c.u, 'amount_minor', x);
    b := b || jsonb_build_object(d.u, d.v + x, c.u, c.v - x);
    d := null; c := null;
  end loop;
  return out_;
end $$;

create or replace function api._balances(p_id uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  with people as (
    select user_id from home.household_members where household_id = p_id and role = 'flatmate'
    union select paid_by from home.expenses where household_id = p_id and deleted_at is null and paid_by is not null
    union select s.user_id from home.expense_shares s join home.expenses e on e.id = s.expense_id
           where e.household_id = p_id and e.deleted_at is null
    union select from_user from home.settlements where household_id = p_id and from_user is not null
    union select to_user from home.settlements where household_id = p_id and to_user is not null
  ), v as (
    select p.user_id,
      coalesce((select sum(amount_minor) from home.expenses e where e.household_id = p_id and e.deleted_at is null and e.paid_by = p.user_id), 0)
      - coalesce((select sum(s.share_minor) from home.expense_shares s join home.expenses e on e.id = s.expense_id
                   where e.household_id = p_id and e.deleted_at is null and s.user_id = p.user_id), 0)
      + coalesce((select sum(amount_minor) from home.settlements t where t.household_id = p_id and t.from_user = p.user_id), 0)
      - coalesce((select sum(amount_minor) from home.settlements t where t.household_id = p_id and t.to_user = p.user_id), 0) as bal
    from people p where p.user_id is not null
  )
  select coalesce(jsonb_object_agg(user_id::text, bal), '{}'::jsonb) from v
$$;

-- 5. Households, invites, membership -------------------------------------------------------------------------------------
create or replace function api._member_list(p_id uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_agg(api._name(m.user_id) || jsonb_build_object('role', m.role, 'status', m.status, 'joined_at', m.joined_at,
           'move_in_on', m.move_in_on, 'move_out_on', m.move_out_on, 'me', m.user_id = app.current_user_id())
           order by m.joined_at, m.user_id), '[]')
    from home.household_members m where m.household_id = p_id and m.status <> 'left'
$$;

-- POST /v1/households {name, jurisdiction_code, listing_id, address_text, role}
create or replace function api.household_create(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare b jsonb := coalesce(p->'body', '{}'); j record; v_id uuid := gen_random_uuid(); v_listing uuid := (b->>'listing_id')::uuid;
begin
  perform api._as(p_user);
  select code, default_currency, timezone into j from app.jurisdictions where code = upper(b->>'jurisdiction_code');
  if j.code is null then
    return api._err(422, 'VALIDATION_FAILED', 'Request is invalid', '[{"field": "jurisdiction_code", "issue": "unknown_jurisdiction"}]');
  end if;
  if v_listing is not null and not exists (select 1 from app.listings where id = v_listing and owner_id = p_user) then
    return api._err(422, 'VALIDATION_FAILED', 'Request is invalid', '[{"field": "listing_id", "issue": "not_your_listing"}]');
  end if;
  insert into home.households (id, name, jurisdiction_code, currency, timezone, listing_id, address_text, created_by)
  values (v_id, btrim(b->>'name'), j.code, j.default_currency, j.timezone, v_listing, nullif(btrim(coalesce(b->>'address_text', '')), ''), p_user);
  insert into home.household_members (household_id, user_id, role) values (v_id, p_user, coalesce(b->>'role', 'flatmate'));
  return api._ok(api._household_view(v_id), 201);
end $$;

-- the next due date of each active recurring item, on or after a day (household dates, 7.2)
create or replace function api._next_due(p_due_day int, p_from date) returns date
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when make_date(extract(year from p_from)::int, extract(month from p_from)::int, p_due_day) >= p_from
              then make_date(extract(year from p_from)::int, extract(month from p_from)::int, p_due_day)
              else (make_date(extract(year from p_from)::int, extract(month from p_from)::int, p_due_day) + interval '1 month')::date end
$$;
create or replace function api._due_items(p_id uuid, p_today date) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('item_id', r.id, 'kind', r.kind, 'label', r.label, 'due_on', api._next_due(r.due_day, p_today),
           'amount', case when r.amount_minor is null then null else api._money(r.amount_minor, h.currency) end)
           order by api._next_due(r.due_day, p_today)), '[]')
    from home.recurring_items r join home.households h on h.id = r.household_id
   where r.household_id = p_id and r.active
$$;

-- the household as its member sees it: members, my role, my balance (flatmates), next due dates, last announcements
create or replace function api._household_view(p_id uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('household_id', h.id, 'name', h.name, 'jurisdiction_code', h.jurisdiction_code, 'currency', h.currency,
    'exponent', api._exp(h.currency), 'timezone', h.timezone, 'status', h.status, 'address_text', h.address_text,
    'listing_id', h.listing_id, 'created_at', h.created_at, 'my_role', api._my_role(h.id),
    'members', api._member_list(h.id),
    'my_balance_minor', case when api._my_role(h.id) = 'flatmate' then coalesce((api._balances(h.id)->>(app.current_user_id()::text))::bigint, 0) end,
    'announcements', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'body', a.body, 'pinned', a.pinned, 'created_at', a.created_at,
                                 'author', api._name(a.author_id)) order by a.pinned desc, a.id desc)
                               from (select * from home.announcements where household_id = h.id order by pinned desc, id desc limit 5) a), '[]'),
    'upcoming', api._due_items(h.id, (now() at time zone h.timezone)::date))
  from home.households h where h.id = p_id
$$;


create or replace function api.household_get(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb;
begin
  perform api._as(p_user);
  e := api._need(v_id); if e is not null then return e; end if;
  return api._ok(api._household_view(v_id));
end $$;

-- GET /v1/me/households: the caller's households and the personal invites waiting for them
create or replace function api.households_mine(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform api._as(p_user);
  return api._ok(jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object('household_id', h.id, 'name', h.name, 'my_role', m.role, 'status', h.status,
                         'members', (select count(*) from home.household_members x where x.household_id = h.id and x.status <> 'left'))
                         order by m.joined_at desc)
                       from home.household_members m join home.households h on h.id = m.household_id
                      where m.user_id = p_user and m.status in ('active', 'leaving')), '[]'),
    'invites', coalesce((select jsonb_agg(jsonb_build_object('invite_id', i.id, 'role', i.role, 'expires_at', i.expires_at,
                           'household', (select jsonb_build_object('household_id', h.id, 'name', h.name) from home.household_names(i.id) h)))
                         from home.household_invites i where i.for_user = p_user and i.used_at is null and i.expires_at > now()), '[]')));
end $$;
-- the name of the household of a personal invite, for the invited user who is not a member yet
create or replace function home.household_names(p_invite uuid) returns table (id uuid, name text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select h.id, h.name from home.household_invites i join home.households h on h.id = i.household_id
   where i.id = p_invite and i.for_user = app.current_user_id()
$$;
revoke execute on function home.household_names(uuid) from public;
grant execute on function home.household_names(uuid) to app_rls;

-- POST /v1/households/{id}/invites {role}: a code shown once (only its hash is stored)
create or replace function api.household_invite(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb; v_code text; v_exp timestamptz;
begin
  perform api._as(p_user);
  e := api._need(v_id); if e is not null then return e; end if;
  -- 12 characters from a random UUID (122 random bits), grouped for reading out loud
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  v_code := substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4) || '-' || substr(v_code, 9, 4);
  v_exp := now() + make_interval(days => api._setting_int('household.invite_days', 7));
  insert into home.household_invites (household_id, code_hash, role, expires_at, created_by)
  values (v_id, sha256(convert_to(v_code, 'UTF8')), coalesce(p#>>'{body,role}', 'flatmate'), v_exp, p_user);
  return api._ok(jsonb_build_object('code', v_code, 'role', coalesce(p#>>'{body,role}', 'flatmate'), 'expires_at', v_exp), 201);
end $$;

-- POST /v1/household-invites/accept {code} or {invite_id}
create or replace function api.household_invite_accept(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare r jsonb; v_code text := upper(btrim(coalesce(p#>>'{body,code}', '')));
begin
  perform api._as(p_user);
  r := home.redeem_invite(case when v_code <> '' then sha256(convert_to(v_code, 'UTF8')) end, (p#>>'{body,invite_id}')::uuid);
  if r ? 'error' then
    return case when r->>'error' = 'not_found' then api._err(404, 'NOT_FOUND', 'Invite not found')
                else api._err(409, 'CONFLICT', 'Invite not usable', jsonb_build_array(jsonb_build_object('field', 'code', 'issue', r->>'error'))) end;
  end if;
  perform api.notify_emit(m.user_id, 'household_joined', jsonb_build_object('name', (api._name(p_user))->>'display_name'), 'household', r->>'household_id')
     from home.household_members m where m.household_id = (r->>'household_id')::uuid and m.user_id <> p_user and m.status = 'active';
  return api._ok(api._household_view((r->>'household_id')::uuid));
end $$;

-- POST /v1/households/{id}/leave: membership ends; the expenses the member paid or shared stay, so balances stay right
create or replace function api.household_leave(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb;
begin
  perform api._as(p_user);
  e := api._need(v_id); if e is not null then return e; end if;
  update home.household_members set status = 'left', move_out_on = coalesce(move_out_on, current_date)
   where household_id = v_id and user_id = p_user;
  return api._ok(jsonb_build_object('household_id', v_id, 'status', 'left'));
end $$;

-- 6. Expenses, balances, settlements -------------------------------------------------------------------------------------
create or replace function api._expense_json(x home.expenses) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('expense_id', x.id, 'label', x.label, 'category', x.category, 'spent_on', x.spent_on,
    'amount', api._money(x.amount_minor, x.currency), 'split_mode', x.split_mode, 'paid_by', api._name(x.paid_by),
    'shares', coalesce((select jsonb_agg(api._name(s.user_id) || jsonb_build_object('share_minor', s.share_minor) order by s.share_minor desc, s.user_id)
                        from home.expense_shares s where s.expense_id = x.id), '[]'),
    'can_delete', x.created_by = app.current_user_id() and x.deleted_at is null, 'deleted', x.deleted_at is not null,
    'created_at', x.created_at)
$$;

create or replace function api.expenses_list(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb; q jsonb := coalesce(p->'query', '{}');
begin
  perform api._as(p_user);
  e := api._need(v_id, 'flatmate'); if e is not null then return e; end if;
  return api._ok(jsonb_build_object('items', coalesce((select jsonb_agg(api._expense_json(x) order by x.spent_on desc, x.created_at desc)
    from (select * from home.expenses where household_id = v_id and deleted_at is null
           order by spent_on desc, created_at desc limit coalesce((q->>'limit')::int, 50)) x), '[]')));
end $$;

-- POST /v1/households/{id}/expenses {amount_minor, label, category, spent_on, paid_by, split_mode, participants,
-- values, preview}. participants: flatmate ids (default: every active flatmate, in join order); values: weights
-- (shares) or amounts (exact) in the same order. preview: the split without saving.
create or replace function api.expense_create(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb; b jsonb := coalesce(p->'body', '{}'); h home.households;
  mates uuid[]; who uuid[]; vals bigint[]; sp jsonb; v_payer uuid; xr home.expenses;
begin
  perform api._as(p_user);
  e := api._need(v_id, 'flatmate'); if e is not null then return e; end if;
  h := api._hh(v_id);
  mates := api._flatmates(v_id);
  v_payer := coalesce((b->>'paid_by')::uuid, p_user);
  if not v_payer = any(mates) then
    return api._err(422, 'VALIDATION_FAILED', 'Request is invalid', '[{"field": "paid_by", "issue": "not_a_flatmate"}]');
  end if;
  if jsonb_typeof(b->'participants') = 'array' and jsonb_array_length(b->'participants') > 0 then
    who := array(select (pt)::uuid from jsonb_array_elements_text(b->'participants') pt);
    -- in join order, whatever order they were given in, so leftover units go the same way every time
    if exists (select 1 from unnest(who) u where not u = any(mates)) then
      return api._err(422, 'VALIDATION_FAILED', 'Request is invalid', '[{"field": "participants", "issue": "not_a_flatmate"}]');
    end if;
    if b ? 'values' then
      vals := array(select (b->'values'->>(array_position(who, m) - 1))::bigint from unnest(mates) with ordinality u(m, o)
                     where m = any(who) order by o);
    end if;
    who := array(select m from unnest(mates) with ordinality u(m, o) where m = any(who) order by o);
  else
    who := mates;
    if b ? 'values' then vals := array(select (vl)::bigint from jsonb_array_elements_text(b->'values') vl); end if;
  end if;
  sp := api.split((b->>'amount_minor')::bigint, coalesce(b->>'split_mode', 'equal'), who, vals);
  if sp ? 'error' then
    return api._err(422, 'VALIDATION_FAILED', 'Request is invalid',
      jsonb_build_array(jsonb_build_object('field', 'values', 'issue', sp->>'error') || (sp - 'error')));
  end if;
  if coalesce((b->>'preview')::boolean, false) then
    return api._ok(jsonb_build_object('preview', true, 'amount', api._money((b->>'amount_minor')::bigint, h.currency),
      'shares', (select jsonb_agg(api._name((s->>'user_id')::uuid) || jsonb_build_object('share_minor', (s->>'share_minor')::bigint))
                   from jsonb_array_elements(sp->'shares') s)));
  end if;
  insert into home.expenses (household_id, paid_by, amount_minor, currency, category, label, spent_on, split_mode, created_by)
  values (v_id, v_payer, (b->>'amount_minor')::bigint, h.currency, coalesce(b->>'category', 'other'), btrim(b->>'label'),
          coalesce((b->>'spent_on')::date, (now() at time zone h.timezone)::date), coalesce(b->>'split_mode', 'equal'), p_user)
  returning * into xr;
  insert into home.expense_shares (expense_id, user_id, share_minor)
  select xr.id, (s->>'user_id')::uuid, (s->>'share_minor')::bigint from jsonb_array_elements(sp->'shares') s;
  perform api.notify_emit(u, 'expense_added', jsonb_build_object('label', xr.label, 'amount_minor', xr.amount_minor, 'currency', xr.currency),
                          'household', v_id::text)
     from unnest(who) u where u <> p_user;
  return api._ok(api._expense_json(xr), 201);
end $$;

-- DELETE /v1/households/{id}/expenses/{expense_id}: by its creator; kept as deleted (audit), out of the balances
create or replace function api.expense_delete(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb; x home.expenses;
begin
  perform api._as(p_user);
  e := api._need(v_id, 'flatmate'); if e is not null then return e; end if;
  select * into x from home.expenses where id = (p#>>'{params,expense_id}')::uuid and household_id = v_id and deleted_at is null;
  if x.id is null then return api._err(404, 'NOT_FOUND', 'Expense not found'); end if;
  if x.created_by is distinct from p_user then return api._err(403, 'FORBIDDEN', 'Only who added it can delete it'); end if;
  update home.expenses set deleted_at = now() where id = x.id returning * into x;
  insert into app.audit_log (actor_id, action, entity, entity_id) values (p_user, 'expense_deleted', 'expense', x.id::text);
  return api._ok(api._expense_json(x));
end $$;

-- GET /v1/households/{id}/balances: each person's balance and the suggested settlements
create or replace function api.balances_get(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb; b jsonb; h home.households;
begin
  perform api._as(p_user);
  e := api._need(v_id, 'flatmate'); if e is not null then return e; end if;
  h := api._hh(v_id);
  b := api._balances(v_id);
  return api._ok(jsonb_build_object('currency', h.currency, 'exponent', api._exp(h.currency),
    'balances', coalesce((select jsonb_agg(api._name(k::uuid) || jsonb_build_object('balance_minor', (v)::bigint, 'me', k::uuid = p_user)
                                           order by (v)::bigint desc, k) from jsonb_each_text(b) t(k, v)), '[]'),
    'suggested', coalesce((select jsonb_agg(jsonb_build_object('from', api._name((s->>'from_user')::uuid), 'to', api._name((s->>'to_user')::uuid),
                                            'amount_minor', (s->>'amount_minor')::bigint))
                            from jsonb_array_elements(api.settle_plan(b)) s), '[]'),
    'settlements', coalesce((select jsonb_agg(jsonb_build_object('settlement_id', t.id, 'from', api._name(t.from_user), 'to', api._name(t.to_user),
                               'amount_minor', t.amount_minor, 'settled_on', t.settled_on) order by t.settled_on desc, t.created_at desc)
                             from (select * from home.settlements where household_id = v_id order by settled_on desc limit 20) t), '[]')));
end $$;

-- POST /v1/households/{id}/settlements {to_user, amount_minor, settled_on, from_user}: a record that someone paid
-- someone; nothing moves money (PLATFORM_SPEC rule 2.8)
create or replace function api.settlement_create(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb; b jsonb := coalesce(p->'body', '{}'); mates uuid[]; v_from uuid; v_to uuid; t home.settlements;
begin
  perform api._as(p_user);
  e := api._need(v_id, 'flatmate'); if e is not null then return e; end if;
  mates := api._flatmates(v_id);
  v_from := coalesce((b->>'from_user')::uuid, p_user); v_to := (b->>'to_user')::uuid;
  if not (v_from = any(mates) and v_to = any(mates)) or v_from = v_to or p_user not in (v_from, v_to) then
    return api._err(422, 'VALIDATION_FAILED', 'Request is invalid', '[{"field": "to_user", "issue": "not_a_flatmate"}]');
  end if;
  insert into home.settlements (household_id, from_user, to_user, amount_minor, settled_on, created_by)
  values (v_id, v_from, v_to, (b->>'amount_minor')::bigint, coalesce((b->>'settled_on')::date, current_date), p_user) returning * into t;
  perform api.notify_emit(case when p_user = v_from then v_to else v_from end, 'settlement_recorded',
                          jsonb_build_object('amount_minor', t.amount_minor, 'currency', (api._hh(v_id)).currency), 'household', v_id::text);
  return api._ok(jsonb_build_object('settlement_id', t.id, 'from', api._name(t.from_user), 'to', api._name(t.to_user),
                                    'amount_minor', t.amount_minor, 'settled_on', t.settled_on), 201);
end $$;

-- 7. Recurring rent and bills, rent payments --------------------------------------------------------------------------------
create or replace function api.recurring_get(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb; h home.households;
begin
  perform api._as(p_user);
  e := api._need(v_id); if e is not null then return e; end if;
  h := api._hh(v_id);
  return api._ok(jsonb_build_object('currency', h.currency, 'exponent', api._exp(h.currency),
    'items', coalesce((select jsonb_agg(jsonb_build_object('item_id', r.id, 'kind', r.kind, 'label', r.label, 'amount_minor', r.amount_minor,
                         'due_day', r.due_day, 'remind_days_before', r.remind_days_before, 'active', r.active,
                         'next_due_on', api._next_due(r.due_day, (now() at time zone h.timezone)::date)) order by r.due_day, r.label)
                       from home.recurring_items r where r.household_id = v_id), '[]')));
end $$;

-- PUT /v1/households/{id}/recurring {items: [{kind, label, amount_minor, due_day, remind_days_before}]}: the list becomes this
create or replace function api.recurring_put(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb;
begin
  perform api._as(p_user);
  e := api._need(v_id); if e is not null then return e; end if;
  delete from home.recurring_items where household_id = v_id;
  insert into home.recurring_items (household_id, kind, label, amount_minor, due_day, remind_days_before)
  select v_id, x->>'kind', btrim(x->>'label'), (x->>'amount_minor')::bigint, (x->>'due_day')::smallint,
         coalesce((x->>'remind_days_before')::smallint, 3)
    from jsonb_array_elements(coalesce(p#>'{body,items}', '[]')) x;
  return api.recurring_get(p_user, p);
end $$;

create or replace function api._rent_json(r home.rent_payments) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('payment_id', r.id, 'user', api._name(r.user_id), 'period', r.period, 'amount_minor', r.amount_minor,
    'paid_on', r.paid_on, 'confirmed', r.confirmed_at is not null, 'confirmed_at', r.confirmed_at,
    'can_confirm', r.confirmed_at is null and api._my_role(r.household_id) = 'owner', 'mine', r.user_id = app.current_user_id())
$$;

create or replace function api.rent_payment_create(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb; b jsonb := coalesce(p->'body', '{}'); r home.rent_payments;
begin
  perform api._as(p_user);
  e := api._need(v_id, 'flatmate'); if e is not null then return e; end if;
  insert into home.rent_payments (household_id, user_id, period, amount_minor, paid_on)
  values (v_id, p_user, b->>'period', (b->>'amount_minor')::bigint, coalesce((b->>'paid_on')::date, current_date)) returning * into r;
  perform api.notify_emit(m.user_id, 'rent_payment_recorded', jsonb_build_object('period', r.period, 'from', (api._name(p_user))->>'display_name'),
                          'household', v_id::text)
     from home.household_members m where m.household_id = v_id and m.role = 'owner' and m.status = 'active';
  return api._ok(api._rent_json(r), 201);
end $$;

create or replace function api.rent_payments_list(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb; h home.households;
begin
  perform api._as(p_user);
  e := api._need(v_id); if e is not null then return e; end if;
  h := api._hh(v_id);
  return api._ok(jsonb_build_object('currency', h.currency, 'exponent', api._exp(h.currency),
    'items', coalesce((select jsonb_agg(api._rent_json(r) order by r.period desc, r.paid_on desc)
                       from (select * from home.rent_payments where household_id = v_id order by period desc, paid_on desc limit 60) r), '[]')));
end $$;

-- POST /v1/rent-payments/{id}/confirm: the owner member confirms it was received (receipts only for confirmed rows)
create or replace function api.rent_payment_confirm(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare r home.rent_payments; e jsonb;
begin
  perform api._as(p_user);
  select * into r from home.rent_payments where id = (p#>>'{params,id}')::uuid;
  if r.id is null then return api._err(404, 'NOT_FOUND', 'Payment not found'); end if;
  e := api._need(r.household_id, 'owner'); if e is not null then return e; end if;
  if r.confirmed_at is not null then return api._ok(api._rent_json(r)); end if;
  update home.rent_payments set confirmed_by = p_user, confirmed_at = now() where id = r.id returning * into r;
  insert into app.audit_log (actor_id, action, entity, entity_id) values (p_user, 'rent_payment_confirmed', 'rent_payment', r.id::text);
  perform api.notify_emit(r.user_id, 'rent_payment_confirmed', jsonb_build_object('period', r.period), 'household', r.household_id::text);
  return api._ok(api._rent_json(r));
end $$;

-- 8. Announcements -------------------------------------------------------------------------------------------------------
create or replace function api.announcements_list(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb;
begin
  perform api._as(p_user);
  e := api._need(v_id); if e is not null then return e; end if;
  return api._ok(jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'body', a.body, 'pinned', a.pinned,
           'created_at', a.created_at, 'author', api._name(a.author_id)) order by a.pinned desc, a.id desc)
    from (select * from home.announcements where household_id = v_id order by pinned desc, id desc limit 50) a), '[]')));
end $$;

create or replace function api.announcement_create(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb; v bigint;
begin
  perform api._as(p_user);
  e := api._need(v_id); if e is not null then return e; end if;
  insert into home.announcements (household_id, author_id, body, pinned)
  values (v_id, p_user, btrim(p#>>'{body,body}'), coalesce((p#>>'{body,pinned}')::boolean, false)) returning id into v;
  perform api.notify_emit(m.user_id, 'announcement_posted', jsonb_build_object('from', (api._name(p_user))->>'display_name'), 'household', v_id::text)
     from home.household_members m where m.household_id = v_id and m.user_id <> p_user and m.status = 'active';
  return api._ok(jsonb_build_object('id', v, 'household_id', v_id), 201);
end $$;

-- 9. An accepted application becomes a personal invite when the listing belongs to a household (PLATFORM_SPEC 3.4)
create or replace function api._application_set(p_user uuid, p_id uuid, p_action text, p_code text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare x social.applications; j jsonb; v_new text; v_hh uuid; v_inv uuid;
begin
  select * into x from social.applications where id = p_id for update;
  if x.id is null then return api._err(404, 'NOT_FOUND', 'Application not found'); end if;
  j := api._application_json(x);
  if not coalesce((j#>>array['actions', p_action])::boolean, false) then
    if (p_action = 'withdraw' and x.applicant_id <> p_user) or (p_action <> 'withdraw' and x.owner_id <> p_user) then
      return api._err(403, 'FORBIDDEN', 'Not allowed for your role');
    end if;
    return api._err(409, 'CONFLICT', 'Already decided', jsonb_build_array(jsonb_build_object('field', 'status', 'issue', 'not_allowed', 'status', x.status)));
  end if;
  v_new := case p_action when 'accept' then 'accepted' when 'decline' then 'declined' else 'withdrawn' end;
  update social.applications set status = v_new, decided_at = now(), updated_at = now(), decision_code = p_code
   where id = x.id returning * into x;
  insert into app.audit_log (actor_id, action, entity, entity_id) values (p_user, 'application_' || v_new, 'application', x.id::text);
  if v_new = 'accepted' then
    -- the owner's active household of this listing, if the owner is one of its members
    select h.id into v_hh from home.households h where h.listing_id = x.listing_id and h.status = 'active'
       and h.id in (select home.my_households()) order by h.created_at desc limit 1;
    if v_hh is not null then
      v_inv := gen_random_uuid();
      insert into home.household_invites (id, household_id, for_user, role, expires_at, created_by)
      values (v_inv, v_hh, x.applicant_id, 'flatmate', now() + make_interval(days => api._setting_int('household.invite_days', 7)), p_user);
      perform api.notify_emit(x.applicant_id, 'household_invite', jsonb_build_object('name', (api._hh(v_hh)).name), 'household_invite', v_inv::text);
    end if;
  end if;
  perform api.notify_emit(case when p_action = 'withdraw' then x.owner_id else x.applicant_id end, 'application_' || v_new,
            jsonb_build_object('listing_title', (select title from app.listings where id = x.listing_id)), 'application', x.id::text);
  return api._ok(api._application_json(x) || jsonb_build_object('household_invite', v_inv is not null));
end $$;

-- 10. The daily household workflow (acts for nobody, 7.1): reminders of rent and bills due in remind_days_before
--     days, in each household's own date. One reminder per item and due date (reminder_log). today: the parameter,
--     else the setting household.today_override (tests), else the household's real date.
create or replace function home.daily_reminders(p_today date default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare r record; v_today date; v_due date; n int := 0; v_override date;
begin
  v_override := (select nullif(value #>> '{}', '')::date from app.settings where key = 'household.today_override');
  for r in select i.*, h.timezone, h.currency from home.recurring_items i join home.households h on h.id = i.household_id
            where i.active and h.status = 'active' loop
    v_today := coalesce(p_today, v_override, (now() at time zone r.timezone)::date);
    v_due := api._next_due(r.due_day, v_today);
    continue when v_due - v_today <> r.remind_days_before;
    insert into home.reminder_log (item_id, due_on) values (r.id, v_due) on conflict do nothing;
    continue when not found;
    perform api.notify_emit(m.user_id, case when r.kind = 'rent' then 'rent_due' else 'bill_due' end,
              jsonb_build_object('label', r.label, 'due_on', v_due, 'amount_minor', r.amount_minor, 'currency', r.currency),
              'household', r.household_id::text)
       from home.household_members m where m.household_id = r.household_id and m.status = 'active' and m.role = 'flatmate';
    n := n + 1;
  end loop;
  return jsonb_build_object('reminders', n, 'today', coalesce(p_today, v_override));
end $$;
revoke execute on function home.daily_reminders(date) from public;
grant execute on function home.daily_reminders(date) to n8n_worker;
grant usage on schema home to n8n_worker;

-- 11. Owners and grants -----------------------------------------------------------------------------------------------------
do $$
declare f text;
  internal text[] := array['api._hh(uuid)', 'api._my_role(uuid)', 'api._exp(text)', 'api._money(bigint, text)', 'api._need(uuid, text)',
    'api._flatmates(uuid)', 'api.split(bigint, text, uuid[], bigint[])', 'api.settle_plan(jsonb)', 'api._balances(uuid)',
    'api._member_list(uuid)', 'api._household_view(uuid)', 'api._next_due(int, date)', 'api._due_items(uuid, date)',
    'api._expense_json(home.expenses)', 'api._rent_json(home.rent_payments)', 'api._application_set(uuid, uuid, text, text)'];
  public_ text[] := array['api.household_create(uuid, jsonb)', 'api.household_get(uuid, jsonb)', 'api.households_mine(uuid, jsonb)',
    'api.household_invite(uuid, jsonb)', 'api.household_invite_accept(uuid, jsonb)', 'api.household_leave(uuid, jsonb)',
    'api.expenses_list(uuid, jsonb)', 'api.expense_create(uuid, jsonb)', 'api.expense_delete(uuid, jsonb)', 'api.balances_get(uuid, jsonb)',
    'api.settlement_create(uuid, jsonb)', 'api.recurring_get(uuid, jsonb)', 'api.recurring_put(uuid, jsonb)',
    'api.rent_payment_create(uuid, jsonb)', 'api.rent_payments_list(uuid, jsonb)', 'api.rent_payment_confirm(uuid, jsonb)',
    'api.announcements_list(uuid, jsonb)', 'api.announcement_create(uuid, jsonb)'];
begin
  foreach f in array internal || public_ loop
    execute format('alter function %s owner to app_rls', f);
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to app_rls', f);
  end loop;
  foreach f in array public_ loop execute format('grant execute on function %s to n8n_worker', f); end loop;
end $$;
-- the split and settlement arithmetic is pure: the tests call it directly
grant execute on function api.split(bigint, text, uuid[], bigint[]), api.settle_plan(jsonb) to n8n_worker;

-- 12. Erasure (7.4): membership set to left; records others depend on (expenses, settlements) stay, with the user
--     anonymised by app.erase_user (the name is removed from app.users), so balances stay right.
create or replace function app.platform_household_on_user_erased() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update home.household_members set status = 'left', move_out_on = coalesce(move_out_on, current_date) where user_id = new.id;
    delete from home.household_invites where for_user = new.id and used_at is null;
  end if;
  return new;
end $$;
create trigger trg_platform_household_erased after update of deleted_at on app.users
  for each row execute function app.platform_household_on_user_erased();
revoke execute on function app.platform_household_on_user_erased() from public;

-- migrate:down
drop trigger if exists trg_platform_household_erased on app.users;
-- (the 0025 api._application_set is restored at the end)
drop function if exists app.platform_household_on_user_erased();
drop function if exists home.daily_reminders(date), api.announcement_create(uuid, jsonb), api.announcements_list(uuid, jsonb),
  api.rent_payment_confirm(uuid, jsonb), api.rent_payments_list(uuid, jsonb), api.rent_payment_create(uuid, jsonb), api._rent_json(home.rent_payments),
  api.recurring_put(uuid, jsonb), api.recurring_get(uuid, jsonb), api.settlement_create(uuid, jsonb), api.balances_get(uuid, jsonb),
  api.expense_delete(uuid, jsonb), api.expense_create(uuid, jsonb), api.expenses_list(uuid, jsonb), api._expense_json(home.expenses),
  api.household_leave(uuid, jsonb), api.household_invite_accept(uuid, jsonb), api.household_invite(uuid, jsonb), home.household_names(uuid),
  api.households_mine(uuid, jsonb), api.household_get(uuid, jsonb), api._due_items(uuid, date), api._next_due(int, date),
  api._household_view(uuid), api.household_create(uuid, jsonb), api._member_list(uuid), api._balances(uuid), api.settle_plan(jsonb),
  api.split(bigint, text, uuid[], bigint[]), api._flatmates(uuid), api._need(uuid, text), api._money(bigint, text), api._exp(text),
  api._my_role(uuid), api._hh(uuid);
drop table if exists home.reminder_log, home.announcements, home.rent_payments, home.recurring_items, home.settlements, home.expense_shares,
  home.expenses, home.household_invites, home.household_members, home.households;
drop function if exists home.redeem_invite(bytea, uuid), home.household_creator(uuid), home.my_flatmate_households(), home.my_households();
revoke usage on schema home from n8n_worker;
delete from app.settings where key in ('household.invite_days', 'household.today_override');
-- api._application_set back to its 0025 version (no household invite)
create or replace function api._application_set(p_user uuid, p_id uuid, p_action text, p_code text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare x social.applications; j jsonb; v_new text;
begin
  select * into x from social.applications where id = p_id for update;
  if x.id is null then return api._err(404, 'NOT_FOUND', 'Application not found'); end if;
  j := api._application_json(x);
  if not coalesce((j#>>array['actions', p_action])::boolean, false) then
    -- the applicant cannot decide and the owner cannot withdraw: the role is wrong (403); otherwise the state (409)
    if (p_action = 'withdraw' and x.applicant_id <> p_user) or (p_action <> 'withdraw' and x.owner_id <> p_user) then
      return api._err(403, 'FORBIDDEN', 'Not allowed for your role');
    end if;
    return api._err(409, 'CONFLICT', 'Already decided', jsonb_build_array(jsonb_build_object('field', 'status', 'issue', 'not_allowed', 'status', x.status)));
  end if;
  v_new := case p_action when 'accept' then 'accepted' when 'decline' then 'declined' else 'withdrawn' end;
  update social.applications set status = v_new, decided_at = now(), updated_at = now(), decision_code = p_code
   where id = x.id returning * into x;
  insert into app.audit_log (actor_id, action, entity, entity_id) values (p_user, 'application_' || v_new, 'application', x.id::text);
  perform api.notify_emit(case when p_action = 'withdraw' then x.owner_id else x.applicant_id end, 'application_' || v_new,
            jsonb_build_object('listing_title', (select title from app.listings where id = x.listing_id)), 'application', x.id::text);
  return api._ok(api._application_json(x));
end $$;
