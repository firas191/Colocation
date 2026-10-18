-- migrate:up
-- Platform phase P4 (docs/PLATFORM_SPEC.md 3.4, 7.2, 7.3, 9 P4; DECISIONS D-103): messages about a listing, blocks,
-- the owner's visit slots, visit requests, applications, reports. Every table is behind the row-level layer of
-- migration 0022 (D-096): schema social, RLS enabled and forced, n8n_worker has no privilege, the api.* functions run
-- as app_rls with the caller set first. Who may see a row is decided by the policies, not by the functions' WHERE.

-- 1. Settings ----------------------------------------------------------------------------------------------------------
insert into app.settings (key, value, description) values
  ('messages.per_minute', '20', 'Most messages one user may send in a minute (stricter than the API limit, against spam; PLATFORM_SPEC 8)'),
  ('messages.max_chars', '4000', 'Longest message'),
  ('visits.max_slots', '30', 'Most future visit slots per listing'),
  ('reports.per_hour', '10', 'Most reports one user may send in an hour')
on conflict (key) do nothing;

-- What the functions read from app.listings (RLS of app.listings applies to app_rls: published or the caller's own).
grant select (title, jurisdiction_code, published_at, city, neighbourhood) on app.listings to app_rls;
grant insert on app.audit_log to app_rls;

-- 2. Tables ------------------------------------------------------------------------------------------------------------
create table social.blocks (
  blocker_id uuid not null references app.users(id) on delete cascade,
  blocked_id uuid not null references app.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create table social.conversations (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('listing', 'application', 'household', 'direct')),
  listing_id      uuid references app.listings(id) on delete set null,
  created_by      uuid references app.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create table social.conversation_members (
  conversation_id uuid not null references social.conversations(id) on delete cascade,
  user_id         uuid not null references app.users(id) on delete cascade,
  last_read_at    timestamptz,
  left_at         timestamptz,
  primary key (conversation_id, user_id)
);
create index conversation_members_user on social.conversation_members (user_id);
create table social.messages (
  id                   bigint generated always as identity primary key,
  conversation_id      uuid not null references social.conversations(id) on delete cascade,
  sender_id            uuid references app.users(id) on delete set null,
  body                 text not null check (char_length(body) between 1 and 4000),
  flags                jsonb not null default '[]'::jsonb,
  hidden_by_moderation boolean not null default false,
  deleted_at           timestamptz,
  created_at           timestamptz not null default now()
);
create index messages_conversation on social.messages (conversation_id, id desc);
create index messages_sender_time on social.messages (sender_id, created_at desc);

create table social.visit_slots (
  id         uuid primary key default gen_random_uuid(),
  listing_id uuid not null references app.listings(id) on delete cascade,
  owner_id   uuid not null references app.users(id) on delete cascade,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  capacity   smallint not null default 1 check (capacity between 1 and 20),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index visit_slots_listing on social.visit_slots (listing_id, starts_at);
create table social.visits (
  id          uuid primary key default gen_random_uuid(),
  listing_id  uuid not null references app.listings(id) on delete cascade,
  seeker_id   uuid not null references app.users(id) on delete cascade,
  owner_id    uuid not null references app.users(id) on delete cascade,
  slot_id     uuid references social.visit_slots(id) on delete set null,
  starts_at   timestamptz not null,
  status      text not null default 'requested'
              check (status in ('requested', 'proposed', 'confirmed', 'declined', 'cancelled', 'done', 'no_show')),
  proposed_by uuid references app.users(id) on delete set null,   -- who asked for the current time (the other confirms)
  note        text check (char_length(note) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index visits_seeker on social.visits (seeker_id, starts_at desc);
create index visits_owner on social.visits (owner_id, starts_at desc);
create table social.visit_events (
  id        bigint generated always as identity primary key,
  visit_id  uuid not null references social.visits(id) on delete cascade,
  actor_id  uuid references app.users(id) on delete set null,
  action    text not null,
  starts_at timestamptz,
  at        timestamptz not null default now()
);

create table social.applications (
  id             uuid primary key default gen_random_uuid(),
  listing_id     uuid not null references app.listings(id) on delete cascade,
  applicant_id   uuid not null references app.users(id) on delete cascade,
  owner_id       uuid not null references app.users(id) on delete cascade,
  status         text not null default 'submitted' check (status in ('submitted', 'accepted', 'declined', 'withdrawn', 'expired')),
  message        text check (char_length(message) <= 2000),
  move_in_from   date,
  shared_profile jsonb,                          -- lifestyle fields only, copied when the applicant chooses to share
  decided_at     timestamptz,
  decision_code  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index applications_one_open on social.applications (listing_id, applicant_id) where status = 'submitted';
create index applications_owner on social.applications (owner_id, created_at desc);

-- Reports (PLATFORM_SPEC 7.2): what is reported, its state. The moderation pages come in P8.
alter table app.reports
  add column target_type    text not null default 'listing' check (target_type in ('listing', 'user', 'message')),
  add column target_user_id uuid references app.users(id) on delete set null,
  add column message_id     bigint references social.messages(id) on delete set null,
  add column status         text not null default 'open' check (status in ('open', 'in_review', 'actioned', 'dismissed')),
  add column queue_id       bigint;
grant insert on app.reports to app_rls;
grant select (id, reporter_id, created_at) on app.reports to app_rls;

-- 3. Row-level rules (PLATFORM_SPEC 7.3) ----------------------------------------------------------------------------------
-- Membership helpers: SECURITY DEFINER owned by the migration's superuser, so a policy does not query its own table
-- under RLS (PLATFORM_SPEC 7.1 point 5). They only answer about the caller.
create or replace function social.my_conversations() returns setof uuid
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select conversation_id from social.conversation_members where user_id = app.current_user_id() and left_at is null
$$;
create or replace function social.conversation_creator(p_id uuid) returns uuid
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select created_by from social.conversations where id = p_id
$$;
-- How many requested or confirmed visits a slot has, all seekers counted (a seeker sees only their own visits).
create or replace function social.slot_taken(p_slot uuid) returns int
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select count(*)::int from social.visits where slot_id = p_slot and status in ('requested', 'confirmed')
$$;
revoke execute on function social.my_conversations(), social.conversation_creator(uuid), social.slot_taken(uuid) from public;
grant execute on function social.my_conversations(), social.conversation_creator(uuid), social.slot_taken(uuid) to app_rls;

alter table social.blocks enable row level security;            alter table social.blocks force row level security;
alter table social.conversations enable row level security;     alter table social.conversations force row level security;
alter table social.conversation_members enable row level security; alter table social.conversation_members force row level security;
alter table social.messages enable row level security;          alter table social.messages force row level security;
alter table social.visit_slots enable row level security;       alter table social.visit_slots force row level security;
alter table social.visits enable row level security;            alter table social.visits force row level security;
alter table social.visit_events enable row level security;      alter table social.visit_events force row level security;
alter table social.applications enable row level security;      alter table social.applications force row level security;

-- a block is seen by both sides (the API says "blocked" to the blocked side anyway); only the blocker writes it
create policy blocks_either on social.blocks for select
  using (app.current_user_id() in (blocker_id, blocked_id));
create policy blocks_insert on social.blocks for insert with check (blocker_id = app.current_user_id());
create policy blocks_delete on social.blocks for delete using (blocker_id = app.current_user_id());

create policy conversations_member on social.conversations for select
  using (id in (select social.my_conversations()));
create policy conversations_insert on social.conversations for insert with check (created_by = app.current_user_id());
create policy conversations_touch on social.conversations for update
  using (id in (select social.my_conversations())) with check (id in (select social.my_conversations()));
create policy members_read on social.conversation_members for select
  using (conversation_id in (select social.my_conversations()));
create policy members_insert on social.conversation_members for insert
  with check (social.conversation_creator(conversation_id) = app.current_user_id());
create policy members_own on social.conversation_members for update
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy messages_member on social.messages for select
  using (conversation_id in (select social.my_conversations()));
create policy messages_send on social.messages for insert
  with check (sender_id = app.current_user_id() and conversation_id in (select social.my_conversations()));
create policy messages_own on social.messages for update
  using (sender_id = app.current_user_id()) with check (sender_id = app.current_user_id());

-- slots: anyone may read (the function shows them only for a published listing or the owner's own); the owner writes
create policy slots_read on social.visit_slots for select using (true);
create policy slots_owner on social.visit_slots for insert with check (owner_id = app.current_user_id());
create policy slots_owner_delete on social.visit_slots for delete using (owner_id = app.current_user_id());
create policy visits_parties on social.visits for select using (app.current_user_id() in (seeker_id, owner_id));
create policy visits_request on social.visits for insert with check (seeker_id = app.current_user_id());
create policy visits_decide on social.visits for update
  using (app.current_user_id() in (seeker_id, owner_id)) with check (app.current_user_id() in (seeker_id, owner_id));
create policy visit_events_parties on social.visit_events for select using (visit_id in (select id from social.visits));
create policy visit_events_insert on social.visit_events for insert
  with check (actor_id = app.current_user_id() and visit_id in (select id from social.visits));
create policy applications_parties on social.applications for select using (app.current_user_id() in (applicant_id, owner_id));
create policy applications_apply on social.applications for insert with check (applicant_id = app.current_user_id());
create policy applications_decide on social.applications for update
  using (app.current_user_id() in (applicant_id, owner_id)) with check (app.current_user_id() in (applicant_id, owner_id));

grant select, insert, delete on social.blocks to app_rls;
grant select, insert, update on social.conversations, social.conversation_members, social.messages to app_rls;
grant select, insert, delete on social.visit_slots to app_rls;
grant select, insert, update on social.visits, social.applications to app_rls;
grant select, insert on social.visit_events to app_rls;

-- 4. Helpers of the functions ----------------------------------------------------------------------------------------------
-- Whether either user blocks the other (both directions are visible to both by the policy above).
create or replace function api._blocked(p_a uuid, p_b uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select exists (select 1 from social.blocks where (blocker_id = p_a and blocked_id = p_b) or (blocker_id = p_b and blocked_id = p_a))
$$;
create or replace function api._name(p_user uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('user_id', u.id, 'display_name', case when u.deleted_at is null then u.display_name end)
    from app.users u where u.id = p_user
$$;
create or replace function api._setting_int(p_key text, p_default int) returns int
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce((select (value #>> '{}')::int from app.settings where key = p_key), p_default)
$$;
-- one conversation as the caller sees it
create or replace function api._conversation(p_id uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'conversation_id', c.id, 'kind', c.kind, 'created_at', c.created_at, 'last_message_at', c.last_message_at,
    'listing', case when c.listing_id is null then null else
      (select jsonb_build_object('listing_id', l.id, 'title', l.title, 'status', l.status) from app.listings l where l.id = c.listing_id) end,
    'other', (select api._name(m.user_id) from social.conversation_members m
               where m.conversation_id = c.id and m.user_id <> app.current_user_id() limit 1),
    'blocked', coalesce((select api._blocked(app.current_user_id(), m.user_id) from social.conversation_members m
                          where m.conversation_id = c.id and m.user_id <> app.current_user_id() limit 1), false),
    'unread', (select count(*) from social.messages x, social.conversation_members me
                where x.conversation_id = c.id and me.conversation_id = c.id and me.user_id = app.current_user_id()
                  and x.sender_id is distinct from app.current_user_id() and x.created_at > coalesce(me.last_read_at, '-infinity')),
    'last_message', (select jsonb_build_object('id', x.id, 'mine', x.sender_id = app.current_user_id(),
                              'excerpt', case when x.deleted_at is not null or x.hidden_by_moderation then null else left(x.body, 140) end,
                              'created_at', x.created_at)
                       from social.messages x where x.conversation_id = c.id order by x.id desc limit 1))
  from social.conversations c where c.id = p_id
$$;

-- 5. Messages ----------------------------------------------------------------------------------------------------------------
-- The per-minute limit of messages (and of reports per hour): 429 with the wait, as the gateway's limit does.
create or replace function api._too_many(p_user uuid, p_count bigint, p_limit int, p_window_s int) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when p_count >= p_limit then api._err(429, 'RATE_LIMITED', 'Too many requests',
    jsonb_build_array(jsonb_build_object('limit', p_limit, 'window_s', p_window_s, 'retry_after_s', p_window_s))) end
$$;

-- POST /v1/conversations {listing_id, text}: a conversation with the owner of a published listing (the same one again
-- when it exists), with its first message.
create or replace function api.conversation_start(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare b jsonb := coalesce(p->'body', '{}'); l record; v_id uuid; v_text text := btrim(coalesce(b->>'text', '')); r jsonb;
begin
  perform api._as(p_user);
  select x.id, x.owner_id, x.status into l from app.listings x where x.id = (b->>'listing_id')::uuid;
  if l.id is null or l.status <> 'published' then return api._err(404, 'NOT_FOUND', 'Listing not found'); end if;
  if l.owner_id = p_user then
    return api._err(422, 'VALIDATION_FAILED', 'Request is invalid', '[{"field": "listing_id", "issue": "own_listing"}]');
  end if;
  if api._blocked(p_user, l.owner_id) then
    return api._err(409, 'CONFLICT', 'Blocked', '[{"issue": "blocked"}]');
  end if;
  select c.id into v_id from social.conversations c
   where c.kind = 'listing' and c.listing_id = l.id and c.created_by = p_user;
  if v_id is null then
    v_id := gen_random_uuid();
    insert into social.conversations (id, kind, listing_id, created_by) values (v_id, 'listing', l.id, p_user);
    insert into social.conversation_members (conversation_id, user_id, last_read_at) values (v_id, p_user, now()), (v_id, l.owner_id, null);
  end if;
  r := api._message_insert(p_user, v_id, v_text);
  if r->>'status' <> '201' then return r; end if;
  return api._ok(jsonb_build_object('conversation', api._conversation(v_id), 'message', r->'data'), 201);
end $$;

-- the insert shared by the first message and the next ones: limits, then the row, then the other member's notification
create or replace function api._message_insert(p_user uuid, p_conv uuid, p_text text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_max int := api._setting_int('messages.max_chars', 4000); v_other uuid; v_id bigint; lim jsonb;
begin
  if p_text = '' then return api._err(422, 'VALIDATION_FAILED', 'Request is invalid', '[{"field": "text", "issue": "required"}]'); end if;
  if char_length(p_text) > v_max then
    return api._err(422, 'VALIDATION_FAILED', 'Request is invalid', jsonb_build_array(jsonb_build_object('field', 'text', 'issue', 'too_long', 'max', v_max)));
  end if;
  lim := api._too_many(p_user, (select count(*) from social.messages where sender_id = p_user and created_at > now() - interval '1 minute'),
                       api._setting_int('messages.per_minute', 20), 60);
  if lim is not null then return lim; end if;
  select user_id into v_other from social.conversation_members where conversation_id = p_conv and user_id <> p_user limit 1;
  if v_other is not null and api._blocked(p_user, v_other) then
    return api._err(409, 'CONFLICT', 'Blocked', '[{"issue": "blocked"}]');
  end if;
  insert into social.messages (conversation_id, sender_id, body) values (p_conv, p_user, p_text) returning id into v_id;
  update social.conversations set last_message_at = now() where id = p_conv;
  update social.conversation_members set last_read_at = now() where conversation_id = p_conv and user_id = p_user;
  if v_other is not null then
    perform api.notify_emit(v_other, 'message_received', jsonb_build_object('from', (api._name(p_user))->>'display_name'),
                            'conversation', p_conv::text);
  end if;
  return api._ok(jsonb_build_object('id', v_id, 'conversation_id', p_conv, 'mine', true, 'body', p_text, 'created_at', now()), 201);
end $$;

-- GET /v1/conversations: the caller's conversations, latest message first.
create or replace function api.conversations_list(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare q jsonb := coalesce(p->'query', '{}'); lim int := coalesce((q->>'limit')::int, 20); items jsonb; v_next text;
  v_t timestamptz; v_id uuid;
begin
  perform api._as(p_user);
  if q->>'cursor' is not null then
    v_t := 'epoch'::timestamptz + split_part(q->>'cursor', '_', 1)::bigint * interval '1 microsecond';
    v_id := split_part(q->>'cursor', '_', 2)::uuid;
  end if;
  select coalesce(jsonb_agg(api._conversation(c.id) order by c.last_message_at desc, c.id), '[]') into items
    from (select id, last_message_at from social.conversations
           where v_t is null or last_message_at < v_t or (last_message_at = v_t and id > v_id)
           order by last_message_at desc, id limit lim + 1) c;
  if jsonb_array_length(items) > lim then
    v_next := (select floor(extract(epoch from (e->>'last_message_at')::timestamptz) * 1e6)::bigint::text || '_' || (e->>'conversation_id')
                 from (select items->(lim - 1) as e) z);
    items := items - lim;
  end if;
  return jsonb_build_object('status', 200, 'data', jsonb_build_object('items', items,
           'unread', (select count(*) from jsonb_array_elements(items) e where (e->>'unread')::int > 0)),
           'meta', jsonb_build_object('next_cursor', v_next));
end $$;

-- GET /v1/conversations/{id}/messages: newest first; pages with before (a message id).
create or replace function api.messages_list(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; q jsonb := coalesce(p->'query', '{}'); lim int := coalesce((q->>'limit')::int, 30);
  items jsonb;
begin
  perform api._as(p_user);
  if not exists (select 1 from social.conversations where id = v_id) then return api._err(404, 'NOT_FOUND', 'Conversation not found'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'mine', x.sender_id = p_user, 'sender_id', x.sender_id,
           'body', case when x.deleted_at is not null or x.hidden_by_moderation then null else x.body end,
           'deleted', x.deleted_at is not null, 'hidden', x.hidden_by_moderation, 'created_at', x.created_at) order by x.id desc), '[]')
    into items
    from (select * from social.messages where conversation_id = v_id and (q->>'before' is null or id < (q->>'before')::bigint)
           order by id desc limit lim + 1) x;
  return api._ok(jsonb_build_object('conversation', api._conversation(v_id),
    'items', case when jsonb_array_length(items) > lim then items - lim else items end,
    'next_before', case when jsonb_array_length(items) > lim then items->(lim - 1)->'id' else 'null'::jsonb end));
end $$;

-- POST /v1/conversations/{id}/messages {text}
create or replace function api.message_send(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid;
begin
  perform api._as(p_user);
  if not exists (select 1 from social.conversations where id = v_id) then return api._err(404, 'NOT_FOUND', 'Conversation not found'); end if;
  return api._message_insert(p_user, v_id, btrim(coalesce(p#>>'{body,text}', '')));
end $$;

-- POST /v1/conversations/{id}/read
create or replace function api.conversation_read(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid;
begin
  perform api._as(p_user);
  update social.conversation_members set last_read_at = now() where conversation_id = v_id and user_id = p_user;
  if not found then return api._err(404, 'NOT_FOUND', 'Conversation not found'); end if;
  return api._ok(jsonb_build_object('conversation_id', v_id, 'unread', 0));
end $$;

-- 6. Blocks ----------------------------------------------------------------------------------------------------------------------
-- Only someone the caller has a conversation, a visit or an application with can be blocked (no probing of user ids).
create or replace function api._knows(p_user uuid, p_other uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select exists (select 1 from social.conversation_members m where m.user_id = p_other and m.conversation_id in (select social.my_conversations()))
      or exists (select 1 from social.visits v where p_other in (v.seeker_id, v.owner_id))
      or exists (select 1 from social.applications a where p_other in (a.applicant_id, a.owner_id))
      or exists (select 1 from social.blocks b where b.blocker_id = p_user and b.blocked_id = p_other)
$$;

create or replace function api.block_put(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_other uuid := (p#>>'{body,user_id}')::uuid;
begin
  perform api._as(p_user);
  if v_other is null or v_other = p_user or not api._knows(p_user, v_other) then return api._err(404, 'NOT_FOUND', 'User not found'); end if;
  insert into social.blocks (blocker_id, blocked_id) values (p_user, v_other) on conflict do nothing;
  -- open visits and applications between the two end with the block
  update social.visits set status = 'cancelled', updated_at = now()
   where status in ('requested', 'proposed', 'confirmed') and ((seeker_id = p_user and owner_id = v_other) or (seeker_id = v_other and owner_id = p_user));
  update social.applications set status = 'withdrawn', updated_at = now(), decided_at = now(), decision_code = 'blocked'
   where status = 'submitted' and ((applicant_id = p_user and owner_id = v_other) or (applicant_id = v_other and owner_id = p_user));
  return api._ok(jsonb_build_object('user_id', v_other, 'blocked', true));
end $$;

create or replace function api.block_delete(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_other uuid := (p#>>'{params,user_id}')::uuid;
begin
  perform api._as(p_user);
  delete from social.blocks where blocker_id = p_user and blocked_id = v_other;
  return api._ok(jsonb_build_object('user_id', v_other, 'blocked', false));
end $$;

create or replace function api.blocks_list(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform api._as(p_user);
  return api._ok(jsonb_build_object('items', coalesce((select jsonb_agg(api._name(b.blocked_id) || jsonb_build_object('blocked_at', b.created_at)
                                                                       order by b.created_at desc)
                                                         from social.blocks b where b.blocker_id = p_user), '[]')));
end $$;

-- 7. Visit slots and visits -------------------------------------------------------------------------------------------------------
create or replace function api._slot_json(s social.visit_slots) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('slot_id', s.id, 'starts_at', s.starts_at, 'ends_at', s.ends_at, 'capacity', s.capacity,
    'free', greatest(s.capacity - social.slot_taken(s.id), 0))
$$;

-- GET /v1/listings/{id}/visit-slots: future slots of a published listing (or the caller's own listing).
create or replace function api.visit_slots_get(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare l record;
begin
  perform api._as(p_user);
  select x.id, x.owner_id, x.status into l from app.listings x where x.id = (p#>>'{params,id}')::uuid;
  if l.id is null then return api._err(404, 'NOT_FOUND', 'Listing not found'); end if;
  return api._ok(jsonb_build_object('listing_id', l.id, 'mine', l.owner_id = p_user,
    'items', coalesce((select jsonb_agg(api._slot_json(s) order by s.starts_at) from social.visit_slots s
                        where s.listing_id = l.id and s.starts_at > now()), '[]')));
end $$;

-- PUT /v1/listings/{id}/visit-slots {slots: [{starts_at, ends_at, capacity}]}: the owner's future slots become these.
-- A slot that already has a request or a confirmed visit is kept as it is.
create or replace function api.visit_slots_put(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare l record; e jsonb; i int := 0; v_err jsonb := '[]'; s timestamptz; t timestamptz; v_max int := api._setting_int('visits.max_slots', 30);
begin
  perform api._as(p_user);
  select x.id, x.owner_id, x.status into l from app.listings x where x.id = (p#>>'{params,id}')::uuid;
  if l.id is null or l.owner_id <> p_user then return api._err(404, 'NOT_FOUND', 'Listing not found'); end if;
  if jsonb_array_length(p#>'{body,slots}') > v_max then
    return api._err(422, 'VALIDATION_FAILED', 'Request is invalid', jsonb_build_array(jsonb_build_object('field', 'slots', 'issue', 'too_many', 'max', v_max)));
  end if;
  for e in select * from jsonb_array_elements(p#>'{body,slots}') loop
    begin s := (e->>'starts_at')::timestamptz; t := (e->>'ends_at')::timestamptz; exception when others then s := null; end;
    if s is null or t is null or t <= s or s < now() or t - s > interval '12 hours' or s > now() + interval '180 days' then
      v_err := v_err || jsonb_build_object('field', format('slots[%s]', i), 'issue', 'invalid_time');
    end if;
    i := i + 1;
  end loop;
  if jsonb_array_length(v_err) > 0 then return api._err(422, 'VALIDATION_FAILED', 'Request is invalid', v_err); end if;
  delete from social.visit_slots vs where vs.listing_id = l.id and vs.starts_at > now()
     and not exists (select 1 from social.visits v where v.slot_id = vs.id and v.status in ('requested', 'proposed', 'confirmed'));
  insert into social.visit_slots (listing_id, owner_id, starts_at, ends_at, capacity)
  select l.id, p_user, (x->>'starts_at')::timestamptz, (x->>'ends_at')::timestamptz, coalesce((x->>'capacity')::smallint, 1)
    from jsonb_array_elements(p#>'{body,slots}') x
   where not exists (select 1 from social.visit_slots o where o.listing_id = l.id and o.starts_at = (x->>'starts_at')::timestamptz);
  return api.visit_slots_get(p_user, p);
end $$;

create or replace function api._visit_json(v social.visits) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('visit_id', v.id, 'listing', (select jsonb_build_object('listing_id', l.id, 'title', l.title) from app.listings l where l.id = v.listing_id),
    'role', case when v.owner_id = app.current_user_id() then 'owner' else 'seeker' end,
    'other', api._name(case when v.owner_id = app.current_user_id() then v.seeker_id else v.owner_id end),
    'starts_at', v.starts_at, 'status', v.status, 'note', v.note,
    'waiting_for', case when v.status in ('requested', 'proposed') then
                     case when v.proposed_by = app.current_user_id() then 'other' else 'me' end end,
    'actions', jsonb_build_object(
      'confirm', v.status in ('requested', 'proposed') and v.proposed_by is distinct from app.current_user_id(),
      'propose', v.status in ('requested', 'proposed', 'confirmed'),
      'decline', v.status in ('requested', 'proposed') and v.proposed_by is distinct from app.current_user_id(),
      'cancel', v.status in ('requested', 'proposed', 'confirmed'),
      'done', v.status = 'confirmed' and v.owner_id = app.current_user_id() and v.starts_at < now(),
      'no_show', v.status = 'confirmed' and v.owner_id = app.current_user_id() and v.starts_at < now()),
    'created_at', v.created_at, 'updated_at', v.updated_at)
$$;

-- POST /v1/visits {slot_id, note}: the seeker asks for a visit in one of the owner's slots.
create or replace function api.visit_request(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare s social.visit_slots; l record; v social.visits; v_taken int;
begin
  perform api._as(p_user);
  select * into s from social.visit_slots where id = (p#>>'{body,slot_id}')::uuid;
  select x.id, x.owner_id, x.status into l from app.listings x where x.id = s.listing_id;
  if s.id is null or l.id is null or l.status <> 'published' or s.starts_at <= now() then
    return api._err(404, 'NOT_FOUND', 'Slot not found');
  end if;
  if l.owner_id = p_user then
    return api._err(422, 'VALIDATION_FAILED', 'Request is invalid', '[{"field": "slot_id", "issue": "own_listing"}]');
  end if;
  if api._blocked(p_user, l.owner_id) then return api._err(409, 'CONFLICT', 'Blocked', '[{"issue": "blocked"}]'); end if;
  if exists (select 1 from social.visits where seeker_id = p_user and listing_id = l.id and status in ('requested', 'proposed', 'confirmed')) then
    return api._err(409, 'CONFLICT', 'A visit is already planned', '[{"field": "slot_id", "issue": "visit_exists"}]');
  end if;
  -- the slot's capacity counts every visit in it, not only the caller's: asked through a superuser-owned helper
  v_taken := social.slot_taken(s.id);
  if v_taken >= s.capacity then
    return api._err(409, 'CONFLICT', 'Slot full', '[{"field": "slot_id", "issue": "slot_full"}]');
  end if;
  insert into social.visits (listing_id, seeker_id, owner_id, slot_id, starts_at, proposed_by, note)
  values (l.id, p_user, l.owner_id, s.id, s.starts_at, p_user, nullif(btrim(coalesce(p#>>'{body,note}', '')), ''))
  returning * into v;
  insert into social.visit_events (visit_id, actor_id, action, starts_at) values (v.id, p_user, 'requested', v.starts_at);
  perform api.notify_emit(l.owner_id, 'visit_requested', jsonb_build_object('starts_at', v.starts_at), 'visit', v.id::text);
  return api._ok(api._visit_json(v), 201);
end $$;

-- GET /v1/me/visits: as seeker and as owner.
create or replace function api.visits_list(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare q jsonb := coalesce(p->'query', '{}');
begin
  perform api._as(p_user);
  return api._ok(jsonb_build_object('items', coalesce((select jsonb_agg(api._visit_json(v) order by v.starts_at desc)
    from (select * from social.visits
           where (q->>'role' is null or (q->>'role' = 'owner' and owner_id = p_user) or (q->>'role' = 'seeker' and seeker_id = p_user))
             and (coalesce((q->>'upcoming')::boolean, false) = false or (starts_at > now() - interval '1 day' and status in ('requested', 'proposed', 'confirmed')))
           order by starts_at desc limit coalesce((q->>'limit')::int, 50)) v), '[]')));
end $$;

-- POST /v1/visits/{id}/decision {action: confirm | propose | decline | cancel | done | no_show, starts_at (propose)}
create or replace function api.visit_decide(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v social.visits; a text := p#>>'{body,action}'; j jsonb; t timestamptz; v_new text; v_other uuid;
begin
  perform api._as(p_user);
  select * into v from social.visits where id = (p#>>'{params,id}')::uuid for update;
  if v.id is null then return api._err(404, 'NOT_FOUND', 'Visit not found'); end if;
  j := api._visit_json(v);
  if not coalesce((j#>>array['actions', a])::boolean, false) then
    return api._err(409, 'CONFLICT', 'Not allowed now',
      jsonb_build_array(jsonb_build_object('field', 'action', 'issue', 'not_allowed', 'status', v.status)));
  end if;
  if a = 'propose' then
    begin t := (p#>>'{body,starts_at}')::timestamptz; exception when others then t := null; end;
    if t is null or t <= now() or t > now() + interval '180 days' then
      return api._err(422, 'VALIDATION_FAILED', 'Request is invalid', '[{"field": "starts_at", "issue": "invalid_time"}]');
    end if;
  end if;
  v_new := case a when 'confirm' then 'confirmed' when 'propose' then 'proposed' when 'decline' then 'declined'
                  when 'cancel' then 'cancelled' when 'done' then 'done' else 'no_show' end;
  update social.visits set status = v_new, updated_at = now(),
         starts_at = case when a = 'propose' then t else starts_at end,
         slot_id = case when a = 'propose' then null else slot_id end,
         proposed_by = case when a = 'propose' then p_user else proposed_by end
   where id = v.id returning * into v;
  insert into social.visit_events (visit_id, actor_id, action, starts_at) values (v.id, p_user, a, v.starts_at);
  v_other := case when v.owner_id = p_user then v.seeker_id else v.owner_id end;
  if a not in ('done', 'no_show') then
    perform api.notify_emit(v_other, 'visit_' || v_new, jsonb_build_object('starts_at', v.starts_at), 'visit', v.id::text);
  end if;
  return api._ok(api._visit_json(v));
end $$;

-- 8. Applications ------------------------------------------------------------------------------------------------------------
create or replace function api._application_json(x social.applications) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('application_id', x.id,
    'listing', (select jsonb_build_object('listing_id', l.id, 'title', l.title) from app.listings l where l.id = x.listing_id),
    'role', case when x.owner_id = app.current_user_id() then 'owner' else 'applicant' end,
    'other', api._name(case when x.owner_id = app.current_user_id() then x.applicant_id else x.owner_id end),
    'status', x.status, 'message', x.message, 'move_in_from', x.move_in_from, 'shared_profile', x.shared_profile,
    'decision_code', x.decision_code, 'decided_at', x.decided_at, 'created_at', x.created_at,
    'actions', jsonb_build_object(
      'accept', x.status = 'submitted' and x.owner_id = app.current_user_id(),
      'decline', x.status = 'submitted' and x.owner_id = app.current_user_id(),
      'withdraw', x.status = 'submitted' and x.applicant_id = app.current_user_id()))
$$;

-- POST /v1/listings/{id}/applications {message, move_in_from, share_profile}
create or replace function api.application_create(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare l record; b jsonb := coalesce(p->'body', '{}'); x social.applications; v_prof jsonb := null;
begin
  perform api._as(p_user);
  select y.id, y.owner_id, y.status into l from app.listings y where y.id = (p#>>'{params,id}')::uuid;
  if l.id is null or l.status <> 'published' then return api._err(404, 'NOT_FOUND', 'Listing not found'); end if;
  if l.owner_id = p_user then
    return api._err(422, 'VALIDATION_FAILED', 'Request is invalid', '[{"field": "listing_id", "issue": "own_listing"}]');
  end if;
  if api._blocked(p_user, l.owner_id) then return api._err(409, 'CONFLICT', 'Blocked', '[{"issue": "blocked"}]'); end if;
  if exists (select 1 from social.applications where listing_id = l.id and applicant_id = p_user and status = 'submitted') then
    return api._err(409, 'CONFLICT', 'Already applied', '[{"field": "listing_id", "issue": "already_applied"}]');
  end if;
  -- lifestyle fields only (PLATFORM_SPEC rule 2.6); never the bio or anything else
  if coalesce((b->>'share_profile')::boolean, false) then
    select jsonb_strip_nulls(jsonb_build_object('declared_preferences', pr.declared_preferences, 'languages', to_jsonb(pr.languages),
             'move_in_from', pr.move_in_from, 'min_stay_months', pr.min_stay_months,
             'budget', jsonb_build_object('min_minor', pr.budget_min_minor, 'max_minor', pr.budget_max_minor,
                                          'currency', pr.currency, 'period', pr.budget_period)))
      into v_prof from app.profiles pr where pr.user_id = p_user;
  end if;
  insert into social.applications (listing_id, applicant_id, owner_id, message, move_in_from, shared_profile)
  values (l.id, p_user, l.owner_id, nullif(btrim(coalesce(b->>'message', '')), ''), (b->>'move_in_from')::date, v_prof)
  returning * into x;
  perform api.notify_emit(l.owner_id, 'application_received', jsonb_build_object('listing_title',
            (select title from app.listings where id = l.id)), 'application', x.id::text);
  return api._ok(api._application_json(x), 201);
end $$;

-- GET /v1/me/applications (as applicant) and GET /v1/owner/applications (as owner): p.role chooses.
create or replace function api.applications_list(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_role text := coalesce(p->>'role', 'applicant'); q jsonb := coalesce(p->'query', '{}');
begin
  perform api._as(p_user);
  return api._ok(jsonb_build_object('items', coalesce((select jsonb_agg(api._application_json(x) order by x.created_at desc)
    from (select * from social.applications
           where (case when v_role = 'owner' then owner_id else applicant_id end) = p_user
             and (q->>'status' is null or status = q->>'status')
             and (q->>'listing_id' is null or listing_id = (q->>'listing_id')::uuid)
           order by created_at desc limit coalesce((q->>'limit')::int, 50)) x), '[]')));
end $$;
create or replace function api.applications_mine(p_user uuid, p jsonb) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select api.applications_list(p_user, p || '{"role": "applicant"}')
$$;
create or replace function api.applications_owner(p_user uuid, p jsonb) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select api.applications_list(p_user, p || '{"role": "owner"}')
$$;

-- POST /v1/applications/{id}/decision {action: accept | decline, code}; POST /v1/applications/{id}/withdraw
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
create or replace function api.application_decide(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform api._as(p_user);
  return api._application_set(p_user, (p#>>'{params,id}')::uuid, p#>>'{body,action}', p#>>'{body,code}');
end $$;
create or replace function api.application_withdraw(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform api._as(p_user);
  return api._application_set(p_user, (p#>>'{params,id}')::uuid, 'withdraw', null);
end $$;

-- 9. Reports -------------------------------------------------------------------------------------------------------------------
-- POST /v1/reports {target_type, target_id, reason, detail}: stored with status open; the moderation queue is P8.
-- A listing must be visible to the reporter, a message must be in one of their conversations, a user must be someone
-- they deal with (api._knows) or the owner of a visible listing.
create or replace function api.report_create(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare b jsonb := coalesce(p->'body', '{}'); v_type text := b->>'target_type'; v_listing uuid; v_user uuid; v_msg bigint; v_id bigint; lim jsonb;
begin
  perform api._as(p_user);
  lim := api._too_many(p_user, (select count(*) from app.reports where reporter_id = p_user and created_at > now() - interval '1 hour'),
                       api._setting_int('reports.per_hour', 10), 3600);
  if lim is not null then return lim; end if;
  if v_type = 'listing' then
    select id, owner_id into v_listing, v_user from app.listings where id = (b->>'target_id')::uuid and status = 'published';
    if v_listing is null then return api._err(404, 'NOT_FOUND', 'Listing not found'); end if;
  elsif v_type = 'message' then
    select m.id, m.sender_id into v_msg, v_user from social.messages m where m.id = (b->>'target_id')::bigint and m.sender_id <> p_user;
    if v_msg is null then return api._err(404, 'NOT_FOUND', 'Message not found'); end if;
  else
    v_user := (b->>'target_id')::uuid;
    if v_user = p_user or not api._knows(p_user, v_user) then return api._err(404, 'NOT_FOUND', 'User not found'); end if;
  end if;
  insert into app.reports (reporter_id, listing_id, reason, detail, target_type, target_user_id, message_id)
  values (p_user, v_listing, b->>'reason', nullif(btrim(coalesce(b->>'detail', '')), ''), v_type, v_user, v_msg)
  returning id into v_id;
  return api._ok(jsonb_build_object('report_id', v_id, 'status', 'open'), 201);
end $$;

-- 10. Owners and grants -------------------------------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'api._blocked(uuid, uuid)', 'api._name(uuid)', 'api._setting_int(text, int)', 'api._conversation(uuid)',
    'api._too_many(uuid, bigint, int, int)', 'api.conversation_start(uuid, jsonb)', 'api._message_insert(uuid, uuid, text)',
    'api.conversations_list(uuid, jsonb)', 'api.messages_list(uuid, jsonb)', 'api.message_send(uuid, jsonb)',
    'api.conversation_read(uuid, jsonb)', 'api._knows(uuid, uuid)', 'api.block_put(uuid, jsonb)', 'api.block_delete(uuid, jsonb)',
    'api.blocks_list(uuid, jsonb)', 'api._slot_json(social.visit_slots)', 'api.visit_slots_get(uuid, jsonb)',
    'api.visit_slots_put(uuid, jsonb)', 'api._visit_json(social.visits)', 'api.visit_request(uuid, jsonb)',
    'api.visits_list(uuid, jsonb)', 'api.visit_decide(uuid, jsonb)', 'api._application_json(social.applications)',
    'api.application_create(uuid, jsonb)', 'api.applications_list(uuid, jsonb)', 'api.applications_mine(uuid, jsonb)',
    'api.applications_owner(uuid, jsonb)', 'api._application_set(uuid, uuid, text, text)', 'api.application_decide(uuid, jsonb)',
    'api.application_withdraw(uuid, jsonb)', 'api.report_create(uuid, jsonb)'] loop
    execute format('alter function %s owner to app_rls', f);
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to app_rls', f);
  end loop;
  foreach f in array array[
    'api.conversation_start(uuid, jsonb)', 'api.conversations_list(uuid, jsonb)', 'api.messages_list(uuid, jsonb)',
    'api.message_send(uuid, jsonb)', 'api.conversation_read(uuid, jsonb)', 'api.block_put(uuid, jsonb)',
    'api.block_delete(uuid, jsonb)', 'api.blocks_list(uuid, jsonb)', 'api.visit_slots_get(uuid, jsonb)',
    'api.visit_slots_put(uuid, jsonb)', 'api.visit_request(uuid, jsonb)', 'api.visits_list(uuid, jsonb)',
    'api.visit_decide(uuid, jsonb)', 'api.application_create(uuid, jsonb)', 'api.applications_mine(uuid, jsonb)',
    'api.applications_owner(uuid, jsonb)', 'api.application_decide(uuid, jsonb)', 'api.application_withdraw(uuid, jsonb)',
    'api.report_create(uuid, jsonb)'] loop
    execute format('grant execute on function %s to n8n_worker', f);
  end loop;
end $$;
grant usage on schema social to app_rls;
grant execute on function api.notify_emit(uuid, text, jsonb, text, text) to app_rls;

-- 11. Erasure (spec 13.6, PLATFORM_SPEC 7.4): the user's messages are blanked (rows kept for reports), blocks and open
--     visits and applications removed with the user's rows by the foreign keys when the row is deleted; erase_user keeps
--     the users row, so they are handled here.
create or replace function app.platform_contact_on_user_erased() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update social.messages set body = '-', deleted_at = coalesce(deleted_at, now()) where sender_id = new.id;
    delete from social.blocks where new.id in (blocker_id, blocked_id);
    update social.visits set status = 'cancelled', updated_at = now(), note = null
     where new.id in (seeker_id, owner_id) and status in ('requested', 'proposed', 'confirmed');
    update social.applications set status = 'withdrawn', message = null, shared_profile = null, updated_at = now()
     where new.id in (applicant_id, owner_id);
    update social.conversation_members set left_at = now() where user_id = new.id;
  end if;
  return new;
end $$;
create trigger trg_platform_contact_erased after update of deleted_at on app.users
  for each row execute function app.platform_contact_on_user_erased();
revoke execute on function app.platform_contact_on_user_erased() from public;

-- migrate:down
drop trigger if exists trg_platform_contact_erased on app.users;
drop function if exists app.platform_contact_on_user_erased();
drop function if exists api.report_create(uuid, jsonb), api.application_withdraw(uuid, jsonb), api.application_decide(uuid, jsonb),
  api._application_set(uuid, uuid, text, text), api.applications_owner(uuid, jsonb), api.applications_mine(uuid, jsonb),
  api.applications_list(uuid, jsonb), api.application_create(uuid, jsonb), api._application_json(social.applications),
  api.visit_decide(uuid, jsonb), api.visits_list(uuid, jsonb), social.slot_taken(uuid), api.visit_request(uuid, jsonb),
  api._visit_json(social.visits), api.visit_slots_put(uuid, jsonb), api.visit_slots_get(uuid, jsonb), api._slot_json(social.visit_slots),
  api.blocks_list(uuid, jsonb), api.block_delete(uuid, jsonb), api.block_put(uuid, jsonb), api._knows(uuid, uuid),
  api.conversation_read(uuid, jsonb), api.message_send(uuid, jsonb), api.messages_list(uuid, jsonb), api.conversations_list(uuid, jsonb),
  api._message_insert(uuid, uuid, text), api.conversation_start(uuid, jsonb), api._too_many(uuid, bigint, int, int),
  api._conversation(uuid), api._setting_int(text, int), api._name(uuid), api._blocked(uuid, uuid);
alter table app.reports drop column queue_id, drop column status, drop column message_id, drop column target_user_id, drop column target_type;
drop table if exists social.applications, social.visit_events, social.visits, social.visit_slots, social.messages,
  social.conversation_members, social.conversations, social.blocks;
drop function if exists social.my_conversations(), social.conversation_creator(uuid);
revoke select (title, jurisdiction_code, published_at, city, neighbourhood) on app.listings from app_rls;
revoke insert on app.audit_log from app_rls;
delete from app.settings where key in ('messages.per_minute', 'messages.max_chars', 'visits.max_slots', 'reports.per_hour');
