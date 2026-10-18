-- migrate:up
-- Platform phase P7 (docs/PLATFORM_SPEC.md 3.3, 7.2, 9 P7; DECISIONS D-106): flatmate profiles, compatibility,
-- browsing flatmates, rooms posted by a household, saved searches with daily alerts.

insert into app.settings (key, value, description) values
  ('compat.weights', '{"schedule": 15, "cleanliness": 15, "smoking": 15, "pets": 10, "guests": 10, "quiet_hours": 10, "languages": 10, "budget": 10, "move_in": 5, "distance": 0}',
   'Weights of the compatibility factors (PLATFORM_SPEC 3.3). Starting values chosen by hand, not measured; distance is off (0) until the areas of profiles are filled'),
  ('compat.move_in_days', '30', 'Two move-in dates this many days apart or less count as a match'),
  ('compat.distance_km', '5', 'Two profile anchors this close or closer count as a match'),
  ('saved_searches.max', '10', 'Most saved searches per user')
on conflict (key) do nothing;

create table social.flatmate_profiles (
  user_id      uuid primary key references app.users(id) on delete cascade,
  visible      boolean not null default false,
  headline     text check (char_length(headline) <= 80),
  bio          text check (char_length(bio) <= 600),        -- shown as written, never read by matching (rule 2.6)
  seeking      text not null default 'both' check (seeking in ('room', 'flatmate', 'both')),
  areas        text[] not null default '{}',
  move_in_from date,
  updated_at   timestamptz not null default now()
);
create table social.saved_searches (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references app.users(id) on delete cascade,
  name                   text not null check (char_length(name) between 1 and 60),
  query                  jsonb not null,                    -- the /v2/search parameters as the website sent them
  params                 jsonb not null,                    -- the same, checked by the /v2/search rules (wf.api.saved_search_create)
  alert                  text not null default 'daily' check (alert in ('none', 'daily')),
  last_alert_at          timestamptz,
  last_seen_published_at timestamptz,
  created_at             timestamptz not null default now()
);
create table social.saved_search_hits (
  search_id  uuid not null references social.saved_searches(id) on delete cascade,
  listing_id uuid not null references app.listings(id) on delete cascade,
  sent_at    timestamptz not null default now(),
  primary key (search_id, listing_id)
);
alter table social.flatmate_profiles enable row level security;  alter table social.flatmate_profiles force row level security;
alter table social.saved_searches enable row level security;     alter table social.saved_searches force row level security;
alter table social.saved_search_hits enable row level security;  alter table social.saved_search_hits force row level security;
-- a profile: its owner always; others only when it is visible and nobody blocked anybody
create policy fp_own on social.flatmate_profiles for all
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy fp_visible on social.flatmate_profiles for select
  using (visible and not exists (select 1 from social.blocks b where (b.blocker_id = app.current_user_id() and b.blocked_id = user_id)
                                                                   or (b.blocked_id = app.current_user_id() and b.blocker_id = user_id)));
create policy ss_own on social.saved_searches for all using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy ssh_own on social.saved_search_hits for select using (search_id in (select id from social.saved_searches));
grant select, insert, update, delete on social.flatmate_profiles, social.saved_searches to app_rls;
grant select on social.saved_search_hits to app_rls;

-- 1. Compatibility (PLATFORM_SPEC 3.3): an allowlist of lifestyle fields only; a missing answer is "unknown", never a
--    mismatch; 0 to 100 over the known factors, with each factor's state so the page can say why. Superuser-owned:
--    it reads two people's profiles (the caller may not), and returns only the factor states and the score.
create or replace function social.compatibility(p_a uuid, p_b uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare a record; b record; w jsonb; f jsonb := '[]'; k text; va text; vb text; known numeric := 0; got numeric := 0; st text;
  v_days int; v_km numeric; fa date; fb date;
begin
  select p.declared_preferences dp, p.languages, p.budget_min_minor bmin, p.budget_max_minor bmax, p.currency, p.budget_period, p.move_in_from,
         p.anchor_point, fp.move_in_from fmove into a
    from app.users u left join app.profiles p on p.user_id = u.id left join social.flatmate_profiles fp on fp.user_id = u.id where u.id = p_a;
  select p.declared_preferences dp, p.languages, p.budget_min_minor bmin, p.budget_max_minor bmax, p.currency, p.budget_period, p.move_in_from,
         p.anchor_point, fp.move_in_from fmove into b
    from app.users u left join app.profiles p on p.user_id = u.id left join social.flatmate_profiles fp on fp.user_id = u.id where u.id = p_b;
  w := coalesce((select value from app.settings where key = 'compat.weights'), '{}');
  v_days := coalesce((select (value #>> '{}')::int from app.settings where key = 'compat.move_in_days'), 30);
  v_km := coalesce((select (value #>> '{}')::numeric from app.settings where key = 'compat.distance_km'), 5);
  foreach k in array array['schedule', 'cleanliness', 'smoking', 'pets', 'guests', 'quiet_hours'] loop
    va := a.dp->>k; vb := b.dp->>k;
    st := case when va is null or vb is null then 'unknown' when va = vb then 'match' else 'differs' end;
    f := f || jsonb_build_object('factor', k, 'state', st);
  end loop;
  st := case when coalesce(cardinality(a.languages), 0) = 0 or coalesce(cardinality(b.languages), 0) = 0 then 'unknown'
             when a.languages && b.languages then 'match' else 'differs' end;
  f := f || jsonb_build_object('factor', 'languages', 'state', st);
  -- budget: overlapping ranges in the same currency and period; a missing bound is open
  st := case when (a.bmax is null and a.bmin is null) or (b.bmax is null and b.bmin is null) or a.currency is null or b.currency is null
                  or a.currency <> b.currency or coalesce(a.budget_period, 'month') <> coalesce(b.budget_period, 'month') then 'unknown'
             when coalesce(a.bmin, 0) <= coalesce(b.bmax, 9223372036854775807) and coalesce(b.bmin, 0) <= coalesce(a.bmax, 9223372036854775807)
             then 'match' else 'differs' end;
  f := f || jsonb_build_object('factor', 'budget', 'state', st);
  fa := coalesce(a.fmove, a.move_in_from); fb := coalesce(b.fmove, b.move_in_from);
  st := case when fa is null or fb is null then 'unknown' when abs(fa - fb) <= v_days then 'match' else 'differs' end;
  f := f || jsonb_build_object('factor', 'move_in', 'state', st);
  if a.anchor_point is null or b.anchor_point is null then st := 'unknown';
  else st := case when public.st_distance(a.anchor_point, b.anchor_point) <= v_km * 1000 then 'match' else 'differs' end; end if;
  f := f || jsonb_build_object('factor', 'distance', 'state', st);
  select coalesce(sum(coalesce((w->>(x->>'factor'))::numeric, 0)) filter (where x->>'state' <> 'unknown'), 0),
         coalesce(sum(coalesce((w->>(x->>'factor'))::numeric, 0)) filter (where x->>'state' = 'match'), 0)
    into known, got from jsonb_array_elements(f) x;
  return jsonb_build_object('score', case when known = 0 then null else round(100 * got / known)::int end,
    'factors', (select jsonb_agg(x) from jsonb_array_elements(f) x where coalesce((w->>(x->>'factor'))::numeric, 0) > 0));
end $$;
-- with a household: the average over its active flatmates (shown to the household when someone applies)
create or replace function social.compatibility_household(p_user uuid, p_household uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('score', round(avg((social.compatibility(p_user, m.user_id)->>'score')::numeric))::int,
                            'members', count(*))
    from home.household_members m where m.household_id = p_household and m.role = 'flatmate' and m.status = 'active' and m.user_id <> p_user
$$;
revoke execute on function social.compatibility(uuid, uuid), social.compatibility_household(uuid, uuid) from public;
grant execute on function social.compatibility(uuid, uuid), social.compatibility_household(uuid, uuid) to app_rls, n8n_worker;

-- 2. Flatmate profile and browsing -------------------------------------------------------------------------------------------
create or replace function api._fp_json(f social.flatmate_profiles) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('user', api._name(f.user_id), 'visible', f.visible, 'headline', f.headline, 'bio', f.bio, 'seeking', f.seeking,
    'areas', to_jsonb(f.areas), 'move_in_from', f.move_in_from, 'updated_at', f.updated_at)
$$;
create or replace function api.flatmate_profile_get(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare f social.flatmate_profiles;
begin
  perform api._as(p_user);
  select * into f from social.flatmate_profiles where user_id = p_user;
  return api._ok(jsonb_build_object('profile', case when f.user_id is null then null else api._fp_json(f) end,
                                    'has_lifestyle', exists (select 1 from app.profiles where user_id = p_user)));
end $$;
create or replace function api.flatmate_profile_put(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare b jsonb := coalesce(p->'body', '{}');
begin
  perform api._as(p_user);
  insert into social.flatmate_profiles (user_id, visible, headline, bio, seeking, areas, move_in_from, updated_at)
  values (p_user, coalesce((b->>'visible')::boolean, false), nullif(btrim(coalesce(b->>'headline', '')), ''), nullif(btrim(coalesce(b->>'bio', '')), ''),
          coalesce(b->>'seeking', 'both'), coalesce(array(select btrim(x) from jsonb_array_elements_text(b->'areas') x), '{}'),
          (b->>'move_in_from')::date, now())
  on conflict (user_id) do update set visible = excluded.visible, headline = excluded.headline, bio = excluded.bio, seeking = excluded.seeking,
    areas = excluded.areas, move_in_from = excluded.move_in_from, updated_at = now();
  return api.flatmate_profile_get(p_user, p);
end $$;

-- GET /v1/flatmates: visible profiles (not the caller's, nobody blocked), in the caller's country, best match first
create or replace function api.flatmates_list(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare q jsonb := coalesce(p->'query', '{}'); lim int := coalesce((q->>'limit')::int, 20); off int := coalesce((q->>'cursor')::int, 0);
  v_j text := coalesce(q->>'jurisdiction', (select jurisdiction_code from app.users where id = p_user)); items jsonb; n int;
begin
  perform api._as(p_user);
  with c as (
    select f.*, social.compatibility(p_user, f.user_id) as cmp from social.flatmate_profiles f
      join app.users u on u.id = f.user_id
     where f.user_id <> p_user and f.visible and u.deleted_at is null and (v_j is null or u.jurisdiction_code = v_j)
       and (q->>'seeking' is null or f.seeking in (q->>'seeking', 'both'))
  )
  select coalesce(jsonb_agg(api._fp_json(row(c.user_id, c.visible, c.headline, c.bio, c.seeking, c.areas, c.move_in_from, c.updated_at)::social.flatmate_profiles)
                            || jsonb_build_object('compatibility', c.cmp) order by (c.cmp->>'score')::int desc nulls last, c.updated_at desc), '[]'),
         count(*)
    into items, n
    from (select * from c order by (cmp->>'score')::int desc nulls last, updated_at desc offset off limit lim) c;
  return jsonb_build_object('status', 200, 'data', jsonb_build_object('items', items),
    'meta', jsonb_build_object('next_cursor', case when n = lim then (off + lim)::text end));
end $$;

create or replace function api.flatmate_get(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare f social.flatmate_profiles;
begin
  perform api._as(p_user);
  select * into f from social.flatmate_profiles where user_id = (p#>>'{params,user_id}')::uuid and visible and user_id <> p_user;
  if f.user_id is null then return api._err(404, 'NOT_FOUND', 'Profile not found'); end if;
  return api._ok(api._fp_json(f) || jsonb_build_object('compatibility', social.compatibility(p_user, f.user_id)));
end $$;

-- 3. A room free in a household: a flatmate (or the owner member) starts a draft listing for it, linked to the
--    household; the draft then goes through the owner pages like any other (photos, analysis, submit). Superuser-owned:
--    it writes app.listings (app.listing_create) and the household row, after checking the caller is an active member.
create or replace function home.room_post(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; h home.households; r jsonb; v_l uuid;
begin
  select * into h from home.households where id = v_id and status = 'active';
  if h.id is null or not exists (select 1 from home.household_members where household_id = v_id and user_id = p_user and status = 'active') then
    return jsonb_build_object('status', 404, 'error', jsonb_build_object('code', 'NOT_FOUND', 'message', 'Household not found', 'details', '[]'::jsonb));
  end if;
  if exists (select 1 from app.listings where id = h.listing_id and status in ('draft', 'processing', 'pending_review', 'published')) then
    return jsonb_build_object('status', 409, 'error', jsonb_build_object('code', 'CONFLICT', 'message', 'The household already has a room listing',
      'details', jsonb_build_array(jsonb_build_object('field', 'listing_id', 'issue', 'already_posted', 'listing_id', h.listing_id))));
  end if;
  r := app.listing_create(p_user, jsonb_build_object('jurisdiction_code', h.jurisdiction_code, 'kind', 'room',
         'title', p#>>'{body,title}', 'text', coalesce(p#>>'{body,text}', '')));
  v_l := (r->>'listing_id')::uuid;
  update app.listings set current_flatmates = (select count(*) from home.household_members m
                                                 where m.household_id = v_id and m.role = 'flatmate' and m.status = 'active')
   where id = v_l;
  update home.households set listing_id = v_l where id = v_id;
  return jsonb_build_object('status', 201, 'data', jsonb_build_object('household_id', v_id, 'listing_id', v_l, 'status', 'draft',
    'next', jsonb_build_object('edit', format('/owner/listings/%s', v_l), 'photos', format('/v1/listings/%s/media/presign', v_l),
                               'submit', format('/v1/listings/%s/submit', v_l))));
end $$;
revoke execute on function home.room_post(uuid, jsonb) from public;
grant execute on function home.room_post(uuid, jsonb) to n8n_worker;

-- 4. Saved searches and their daily alert -----------------------------------------------------------------------------------
create or replace function api._ss_json(s social.saved_searches) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('saved_search_id', s.id, 'name', s.name, 'query', s.query, 'alert', s.alert, 'last_alert_at', s.last_alert_at,
                            'created_at', s.created_at, 'hits', (select count(*) from social.saved_search_hits h where h.search_id = s.id))
$$;
create or replace function api.saved_searches_list(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform api._as(p_user);
  return api._ok(jsonb_build_object('items', coalesce((select jsonb_agg(api._ss_json(s) order by s.created_at desc) from social.saved_searches s), '[]')));
end $$;
create or replace function api.saved_search_create(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare b jsonb := coalesce(p->'body', '{}'); s social.saved_searches; v_max int := api._setting_int('saved_searches.max', 10);
begin
  perform api._as(p_user);
  if (select count(*) from social.saved_searches) >= v_max then
    return api._err(422, 'VALIDATION_FAILED', 'Request is invalid', jsonb_build_array(jsonb_build_object('field', 'name', 'issue', 'limit_reached', 'max', v_max)));
  end if;
  insert into social.saved_searches (user_id, name, query, params, alert, last_seen_published_at)
  values (p_user, btrim(b->>'name'), coalesce(b->'query', '{}'), coalesce(b->'params', '{}'), coalesce(b->>'alert', 'daily'), now())
  returning * into s;
  return api._ok(api._ss_json(s), 201);
end $$;
create or replace function api.saved_search_delete(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform api._as(p_user);
  delete from social.saved_searches where id = (p#>>'{params,id}')::uuid;
  if not found then return api._err(404, 'NOT_FOUND', 'Saved search not found'); end if;
  return api._ok(jsonb_build_object('saved_search_id', p#>>'{params,id}', 'deleted', true));
end $$;

-- The daily alert (acts for nobody, 7.1): each saved search with alert daily runs again with the /v2/search function;
-- listings published since the last run that were never sent for this search are sent once (saved_search_hits).
create or replace function social.daily_alerts() returns jsonb
-- public on the path: app.search_public_v2 uses PostGIS and pgvector types by their plain names
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare s social.saved_searches; r jsonb; fresh jsonb; n int := 0; sent int := 0; v_max timestamptz;
begin
  for s in select * from social.saved_searches where alert = 'daily' and (last_alert_at is null or last_alert_at < now() - interval '20 hours')
            and user_id in (select id from app.users where deleted_at is null) loop
    r := app.search_public_v2(s.params || jsonb_build_object('limit', 50, 'offset', 0, 'q_vec', null, 'ids', null));
    select coalesce(jsonb_agg(c order by l.published_at desc), '[]'), max(l.published_at) into fresh, v_max
      from jsonb_array_elements(coalesce(r->'results', '[]')) c join app.listings l on l.id = (c->>'id')::uuid
     where l.published_at > coalesce(s.last_seen_published_at, s.created_at)
       and not exists (select 1 from social.saved_search_hits h where h.search_id = s.id and h.listing_id = l.id);
    if jsonb_array_length(fresh) > 0 then
      insert into social.saved_search_hits (search_id, listing_id) select s.id, (c->>'id')::uuid from jsonb_array_elements(fresh) c
      on conflict do nothing;
      perform api.notify_emit(s.user_id, 'saved_search_match', jsonb_build_object('name', s.name, 'count', jsonb_array_length(fresh),
                                'title', fresh->0->>'title'), 'saved_search', s.id::text);
      sent := sent + jsonb_array_length(fresh); n := n + 1;
    end if;
    update social.saved_searches set last_alert_at = now(), last_seen_published_at = greatest(coalesce(last_seen_published_at, created_at), coalesce(v_max, '-infinity'))
     where id = s.id;
  end loop;
  return jsonb_build_object('alerts', n, 'listings', sent);
end $$;
revoke execute on function social.daily_alerts() from public;
grant execute on function social.daily_alerts() to n8n_worker;
grant usage on schema social to n8n_worker;

-- 5. The application view gains the compatibility with the listing's household (shown to the owner side)
create or replace function api._application_json(x social.applications) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('application_id', x.id,
    'listing', (select jsonb_build_object('listing_id', l.id, 'title', l.title) from app.listings l where l.id = x.listing_id),
    'role', case when x.owner_id = app.current_user_id() then 'owner' else 'applicant' end,
    'other', api._name(case when x.owner_id = app.current_user_id() then x.applicant_id else x.owner_id end),
    'status', x.status, 'message', x.message, 'move_in_from', x.move_in_from, 'shared_profile', x.shared_profile,
    'decision_code', x.decision_code, 'decided_at', x.decided_at, 'created_at', x.created_at,
    'compatibility', case when x.owner_id = app.current_user_id() and x.shared_profile is not null then
       (select social.compatibility_household(x.applicant_id, h.id) from home.households h
         where h.listing_id = x.listing_id and h.status = 'active' order by h.created_at desc limit 1) end,
    'actions', jsonb_build_object(
      'accept', x.status = 'submitted' and x.owner_id = app.current_user_id(),
      'decline', x.status = 'submitted' and x.owner_id = app.current_user_id(),
      'withdraw', x.status = 'submitted' and x.applicant_id = app.current_user_id()))
$$;

do $$
declare f text;
  internal text[] := array['api._fp_json(social.flatmate_profiles)', 'api._ss_json(social.saved_searches)', 'api._application_json(social.applications)'];
  public_ text[] := array['api.flatmate_profile_get(uuid, jsonb)', 'api.flatmate_profile_put(uuid, jsonb)', 'api.flatmates_list(uuid, jsonb)',
    'api.flatmate_get(uuid, jsonb)', 'api.saved_searches_list(uuid, jsonb)', 'api.saved_search_create(uuid, jsonb)',
    'api.saved_search_delete(uuid, jsonb)'];
begin
  foreach f in array internal || public_ loop
    execute format('alter function %s owner to app_rls', f);
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to app_rls', f);
  end loop;
  foreach f in array public_ loop execute format('grant execute on function %s to n8n_worker', f); end loop;
end $$;

-- erasure: the flatmate profile and saved searches go (7.4)
create or replace function app.platform_flatmates_on_user_erased() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    delete from social.flatmate_profiles where user_id = new.id;
    delete from social.saved_searches where user_id = new.id;
  end if;
  return new;
end $$;
create trigger trg_platform_flatmates_erased after update of deleted_at on app.users
  for each row execute function app.platform_flatmates_on_user_erased();
revoke execute on function app.platform_flatmates_on_user_erased() from public;

-- migrate:down
drop trigger if exists trg_platform_flatmates_erased on app.users;
drop function if exists app.platform_flatmates_on_user_erased();
drop function if exists social.daily_alerts(), api.saved_search_delete(uuid, jsonb), api.saved_search_create(uuid, jsonb),
  api.saved_searches_list(uuid, jsonb), api._ss_json(social.saved_searches), home.room_post(uuid, jsonb),
  api.flatmate_get(uuid, jsonb), api.flatmates_list(uuid, jsonb), api.flatmate_profile_put(uuid, jsonb), api.flatmate_profile_get(uuid, jsonb),
  api._fp_json(social.flatmate_profiles);
-- the application view without compatibility (0025)
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
drop function if exists social.compatibility_household(uuid, uuid), social.compatibility(uuid, uuid);
drop table if exists social.saved_search_hits, social.saved_searches, social.flatmate_profiles;
delete from app.settings where key in ('compat.weights', 'compat.move_in_days', 'compat.distance_km', 'saved_searches.max');
