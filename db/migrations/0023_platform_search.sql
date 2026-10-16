-- migrate:up
-- Platform P2 (docs/PLATFORM_SPEC.md 3.2, 3.5, 9): search with more filters and pages (GET /v2/search), the public
-- listing page (GET /v1/listings/{id}/public), favourites, and cancelling an owner-assistant proposal from the API.
-- GET /v1/search and app.search_public are not changed (D-095, D-096): /v2 has its own function.

insert into app.settings (key, value, description) values
  ('media.photo_url_ttl_s', '900', 'Lifetime in seconds of the signed photo URLs given to browsers (listing page, search covers, favourites)'),
  ('search.v2_candidates', '200', 'GET /v2/search with text: candidates per ranking (meaning, words) before fusion; pages are cut from the fused list'),
  ('favourites.max', '500', 'Most favourites one user can keep')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. GET /v2/search. Same budget, place and ranking rules as app.search_public (v1), plus filters, a bounding box
--    for the map, a list of ids (cards of known listings, e.g. the assistant's results), and pages by offset.
-- p = {jurisdiction, q_text, q_vec, max_rent_minor, currency, budget_period, lat, lng, place, radius_m, on_date,
--      kind, furnished, bills_included, available_by, amenities [..], house_rules {name: yes|no},
--      bbox [min_lng, min_lat, max_lng, max_lat], ids [..], limit, offset}
-- Returns cards in the shape of app.public_cards, the cover photo key of each result in a separate list (the
-- workflow turns keys into signed URLs and drops them), and paging fields.
create or replace function app.search_public_v2(p jsonb) returns jsonb
language plpgsql as $$                -- volatile: it fills a temporary table
declare
  t0 timestamptz := clock_timestamp();
  j record;
  warnings jsonb := '[]'::jsonb;
  v_lim int := least(greatest(coalesce((p->>'limit')::int, 20), 1), 50);
  v_off int := greatest(coalesce((p->>'offset')::int, 0), 0);
  v_cand int := least(greatest(coalesce((select (value #>> '{}')::int from app.settings where key = 'search.v2_candidates'), 200), 20), 1000);
  v_cur text; v_max bigint; v_budget jsonb := null; fx jsonb;
  v_center geography := null; v_radius int := null; v_place jsonb := null; g jsonb;
  v_text text := nullif(btrim(coalesce(p->>'q_text', '')), '');
  v_vec vector(1024) := (p->>'q_vec')::vector(1024);
  v_on date := coalesce((p->>'on_date')::date, current_date);
  v_kind text := nullif(p->>'kind', '');
  v_furn boolean := (p->>'furnished')::boolean;
  v_bills boolean := (p->>'bills_included')::boolean;
  v_avail date := (p->>'available_by')::date;
  v_amen text[] := case when jsonb_typeof(p->'amenities') = 'array' and jsonb_array_length(p->'amenities') > 0
                        then array(select jsonb_array_elements_text(p->'amenities')) end;
  v_rules jsonb := case when jsonb_typeof(p->'house_rules') = 'object' and p->'house_rules' <> '{}'::jsonb then p->'house_rules' end;
  v_bbox geometry := case when jsonb_typeof(p->'bbox') = 'array' and jsonb_array_length(p->'bbox') = 4
                          then st_makeenvelope((p->'bbox'->>0)::float, (p->'bbox'->>1)::float,
                                               (p->'bbox'->>2)::float, (p->'bbox'->>3)::float, 4326) end;
  v_ids uuid[] := case when jsonb_typeof(p->'ids') = 'array' and jsonb_array_length(p->'ids') > 0
                       then array(select (x)::uuid from jsonb_array_elements_text(p->'ids') x) end;
  v_total int; v_pool int; ranked jsonb; page jsonb; cards jsonb; covers jsonb; mode text;
begin
  select code, default_currency into j from app.jurisdictions where code = p->>'jurisdiction';
  if not found then
    return jsonb_build_object('error', 'unknown_jurisdiction');
  end if;

  -- budget: monthly equivalent in the jurisdiction's currency (as v1)
  if p->>'max_rent_minor' is not null then
    v_cur := upper(coalesce(p->>'currency', j.default_currency));
    v_max := (p->>'max_rent_minor')::bigint;
    if coalesce(p->>'budget_period', 'month') = 'week' then
      v_max := floor(v_max * 52 / 12.0)::bigint;
    end if;
    if v_cur <> j.default_currency then
      fx := app.fx_convert_minor(v_max, v_cur, j.default_currency, v_on);
      if fx is null then
        warnings := warnings || '["fx_rate_unavailable"]'::jsonb;
        v_budget := jsonb_build_object('applied', false, 'stated_currency', v_cur, 'stated_max_minor', (p->>'max_rent_minor')::bigint);
        v_max := null;
      else
        v_budget := jsonb_build_object('applied', true, 'stated_currency', v_cur, 'stated_max_minor', (p->>'max_rent_minor')::bigint,
                                       'currency', j.default_currency, 'max_rent_monthly_minor', (fx->>'amount_minor')::bigint,
                                       'fx', fx - 'amount_minor' - 'currency');
        v_max := (fx->>'amount_minor')::bigint;
      end if;
    else
      v_budget := jsonb_build_object('applied', true, 'currency', v_cur, 'max_rent_monthly_minor', v_max);
    end if;
    v_cur := j.default_currency;
  end if;

  -- distance: explicit point, or a place name resolved by app.geocode (as v1)
  if p->>'lat' is not null and p->>'lng' is not null then
    v_center := st_setsrid(st_makepoint((p->>'lng')::float, (p->>'lat')::float), 4326)::geography;
  elsif nullif(btrim(coalesce(p->>'place', '')), '') is not null then
    g := app.geocode(p->>'place', j.code);
    v_place := g;
    if g->>'status' = 'found' then
      v_center := st_setsrid(st_makepoint((g#>>'{place,lng}')::float, (g#>>'{place,lat}')::float), 4326)::geography;
    else
      warnings := warnings || to_jsonb('place_' || (g->>'status'));
    end if;
  end if;
  if v_center is not null then
    v_radius := coalesce((p->>'radius_m')::int,
                         (select (value #>> '{}')::int from app.settings where key = 'search.default_radius_m'));
  end if;

  create temp table if not exists _sv2 (id uuid primary key, embedding vector(1024), tsv tsvector, dist double precision,
                                        published_at timestamptz) on commit drop;
  truncate _sv2;
  insert into _sv2
  select l.id, l.embedding, l.tsv, case when v_center is not null then st_distance(l.public_location, v_center) end, l.published_at
    from app.listings l
   where l.status = 'published' and l.jurisdiction_code = j.code
     and (v_max is null or (l.rent_monthly_minor <= v_max and l.currency = v_cur))
     and (v_center is null or v_radius is null or st_dwithin(l.public_location, v_center, v_radius))
     and (v_kind is null or l.kind = v_kind)
     and (v_furn is null or l.furnished = v_furn)
     and (v_bills is null or l.bills_included = v_bills)
     -- an unknown availability date does not match a date filter (no guess)
     and (v_avail is null or l.available_from <= v_avail)
     and (v_amen is null or l.amenities @> v_amen)
     and (v_rules is null or l.house_rules @> v_rules)
     and (v_bbox is null or (l.public_location is not null and l.public_location::geometry && v_bbox))
     and (v_ids is null or l.id = any(v_ids));
  get diagnostics v_total = row_count;

  if v_ids is not null then
    -- cards of given listings, in the order given (those that are not published or not matching are left out)
    mode := 'ids';
    select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'score', null, 'dense_rank', null, 'lexical_rank', null,
                                                 'distance_m', round(f.dist::numeric)) order by i.ord), '[]')
      into ranked
      from unnest(v_ids) with ordinality i(id, ord) join _sv2 f on f.id = i.id;
  elsif v_text is not null or v_vec is not null then
    -- meaning (bge-m3) and words, fused by reciprocal rank as in v1, over v_cand candidates per ranking
    mode := 'hybrid';
    with dense as (
      select id, (row_number() over (order by embedding <=> v_vec, id))::int as r
        from _sv2 where embedding is not null and v_vec is not null
       order by embedding <=> v_vec, id limit v_cand
    ), lex as (
      select id, (row_number() over (order by ts_rank_cd(tsv, app.or_tsquery(v_text)) desc, id))::int as r
        from _sv2 where v_text is not null and tsv @@ app.or_tsquery(v_text)
       order by ts_rank_cd(tsv, app.or_tsquery(v_text)) desc, id limit v_cand
    ), fused as (
      select coalesce(d.id, x.id) as id, (coalesce(1.0 / (60 + d.r), 0) + coalesce(1.0 / (60 + x.r), 0))::double precision as score,
             d.r as dr, x.r as xr
        from dense d full join lex x on d.id = x.id
    )
    select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'score', round(f.score::numeric, 6), 'dense_rank', f.dr,
                                                 'lexical_rank', f.xr, 'distance_m', round(s.dist::numeric))
                              order by f.score desc, f.id), '[]')
      into ranked
      from fused f join _sv2 s on s.id = f.id;
  else
    -- filters only: nearest first when there is a point, else newest first (as v1)
    mode := 'filters';
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'score', null, 'dense_rank', null, 'lexical_rank', null,
                                                 'distance_m', round(dist::numeric))
                              order by coalesce(dist, 0), published_at desc nulls last, id), '[]')
      into ranked from _sv2;
  end if;

  v_pool := jsonb_array_length(ranked);
  select coalesce(jsonb_agg(e order by ord), '[]') into page
    from jsonb_array_elements(ranked) with ordinality r(e, ord)
   where ord > v_off and ord <= v_off + v_lim;
  cards := app.public_cards(page);
  -- ranks continue across pages
  select coalesce(jsonb_agg(c || jsonb_build_object('rank', (c->>'rank')::int + v_off) order by (c->>'rank')::int), '[]')
    into cards from jsonb_array_elements(cards) c;
  select coalesce(jsonb_agg(jsonb_build_object('listing_id', s->'listing_id', 'count', s->'count',
                                               'key', s->'keys'->0->'key') order by (s->>'position')::int), '[]')
    into covers
    from jsonb_array_elements(app.listing_photo_summary(array(select (e->>'id')::uuid from jsonb_array_elements(page) e), 1)) s;

  return jsonb_build_object(
    'mode', mode, 'results', cards, 'count', jsonb_array_length(cards), 'covers', covers,
    'total_matching_filters', v_total, 'pool', v_pool, 'offset', v_off,
    'next_offset', case when v_off + v_lim < v_pool then v_off + v_lim end,
    'warnings', warnings,
    'applied', jsonb_build_object('jurisdiction', j.code, 'budget', v_budget, 'text', v_text is not null,
                                  'vector', v_vec is not null,
                                  'center', case when v_center is null then null else
                                     jsonb_build_object('lat', round(st_y(v_center::geometry)::numeric, 5),
                                                        'lng', round(st_x(v_center::geometry)::numeric, 5)) end,
                                  'radius_m', v_radius, 'place', v_place, 'limit', v_lim,
                                  'kind', v_kind, 'furnished', v_furn, 'bills_included', v_bills, 'available_by', v_avail,
                                  'amenities', to_jsonb(v_amen), 'house_rules', v_rules, 'bbox', p->'bbox',
                                  'ids', case when v_ids is null then null else jsonb_array_length(p->'ids') end,
                                  'candidates', case when mode = 'hybrid' then v_cand end),
    'db_ms', round(extract(epoch from clock_timestamp() - t0) * 1000, 2));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. GET /v1/listings/{id}/public: a published listing, or the caller's own listing in any state as a preview.
--    Public fields only: the fuzzed public point, never the exact location or the owner's identity. Photo keys
--    (processed copies only) are turned into signed URLs by the workflow and never reach the client.
create or replace function app.listing_public_view(p_listing uuid, p_user uuid) returns jsonb
language plpgsql stable as $$
declare l app.listings; c int;
begin
  select * into l from app.listings where id = p_listing and (status = 'published' or (p_user is not null and owner_id = p_user));
  if l.id is null then return jsonb_build_object('found', false); end if;
  select exponent into c from app.currencies where code = l.currency;
  return jsonb_build_object('found', true, 'listing', jsonb_build_object(
    'id', l.id, 'status', l.status, 'is_own', l.owner_id is not distinct from p_user, 'jurisdiction_code', l.jurisdiction_code,
    'kind', l.kind, 'title', l.title, 'description', l.description, 'description_lang', l.description_lang,
    'rent', case when l.rent_minor is null then null else
       jsonb_build_object('amount_minor', l.rent_minor, 'currency', l.currency, 'period', l.rent_period,
                          'monthly_minor', l.rent_monthly_minor, 'exponent', c, 'scope', l.rent_scope) end,
    'deposit_minor', l.deposit_minor, 'bills_included', l.bills_included,
    'available_from', l.available_from, 'min_stay_months', l.min_stay_months,
    'bedrooms', l.bedrooms, 'bathrooms', l.bathrooms, 'total_area_m2', l.total_area_m2, 'room_area_m2', l.room_area_m2,
    'furnished', l.furnished, 'current_flatmates', l.current_flatmates,
    'amenities', to_jsonb(l.amenities), 'house_rules', l.house_rules,
    'city', l.city, 'neighbourhood', l.neighbourhood,
    'public_location', case when l.public_location is null then null else
       jsonb_build_object('lat', round(st_y(l.public_location::geometry)::numeric, 5),
                          'lng', round(st_x(l.public_location::geometry)::numeric, 5)) end,
    'trust', jsonb_build_object('score', l.trust_score, 'verdict', l.trust_verdict),
    'is_synthetic', l.is_synthetic, 'published_at', l.published_at, 'updated_at', l.updated_at),
    'photos', (select coalesce(jsonb_agg(jsonb_build_object('media_id', m.id, 'key', m.storage_key, 'width', m.width,
                                                            'height', m.height) order by m.created_at, m.id), '[]'::jsonb)
                 from (select * from app.listing_media
                        where listing_id = l.id and kind = 'photo' and moderation in ('ok', 'blurred')
                        order by created_at, id limit 20) m));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. POST /v1/listing-changes/{id}/cancel: what happened to the proposal, so the API can answer 200, 404 or 409.
--    The Telegram button keeps using app.listing_change_cancel (unchanged).
create or replace function app.listing_change_cancel_request(p_user uuid, p_change uuid) returns jsonb
language plpgsql as $$
declare ch ai.listing_changes; v_min int;
begin
  v_min := coalesce((select (value #>> '{}')::int from app.settings where key = 'owner.change_minutes'), 30);
  select * into ch from ai.listing_changes where id = p_change and user_id = p_user for update;
  if ch.id is null then return jsonb_build_object('found', false); end if;
  if ch.status <> 'pending' then
    return jsonb_build_object('found', true, 'cancelled', false, 'issue', 'already_' || ch.status, 'listing_id', ch.listing_id);
  end if;
  if ch.created_at < now() - make_interval(mins => v_min) then
    return jsonb_build_object('found', true, 'cancelled', false, 'issue', 'expired', 'listing_id', ch.listing_id);
  end if;
  update ai.listing_changes set status = 'cancelled', decided_at = now() where id = ch.id;
  return jsonb_build_object('found', true, 'cancelled', true, 'listing_id', ch.listing_id, 'change_id', ch.id,
                            'decided_at', now());
end $$;

revoke execute on function app.search_public_v2(jsonb), app.listing_public_view(uuid, uuid),
  app.listing_change_cancel_request(uuid, uuid) from public;
grant execute on function app.search_public_v2(jsonb), app.listing_public_view(uuid, uuid),
  app.listing_change_cancel_request(uuid, uuid) to n8n_worker;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Favourites (social.favourites), behind the row-level layer of migration 0022 (D-096).
create table social.favourites (
  id         bigint generated always as identity,
  user_id    uuid not null references app.users(id) on delete cascade,
  listing_id uuid not null references app.listings(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, listing_id)
);
create unique index favourites_id on social.favourites (id);
create index favourites_user_recent on social.favourites (user_id, id desc);
alter table social.favourites enable row level security;
alter table social.favourites force row level security;
create policy favourites_own on social.favourites for all
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
grant select, insert, delete on social.favourites to app_rls;

-- PUT /v1/me/favourites/{listing_id}: idempotent; only a published listing can be saved.
create or replace function api.favourite_put(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_listing uuid := (p #>> '{params,listing_id}')::uuid; v_at timestamptz; v_max int; v_n int;
begin
  perform api._as(p_user);
  if not exists (select 1 from app.listings where id = v_listing and status = 'published') then   -- RLS: published or own
    return api._err(404, 'NOT_FOUND', 'Listing not found');
  end if;
  select created_at into v_at from social.favourites where listing_id = v_listing;                    -- RLS: own rows
  if v_at is null then
    v_max := coalesce((select (value #>> '{}')::int from app.settings where key = 'favourites.max'), 500);
    select count(*) into v_n from social.favourites;
    if v_n >= v_max then
      return api._err(422, 'VALIDATION_FAILED', 'Too many favourites',
                      jsonb_build_array(jsonb_build_object('field', 'listing_id', 'issue', 'limit_reached', 'max', v_max)));
    end if;
    insert into social.favourites (user_id, listing_id) values (p_user, v_listing) returning created_at into v_at;
  end if;
  return api._ok(jsonb_build_object('listing_id', v_listing, 'favourite', true, 'saved_at', v_at));
end $$;

-- DELETE /v1/me/favourites/{listing_id}: idempotent; works for a listing that is no longer published.
create or replace function api.favourite_delete(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_listing uuid := (p #>> '{params,listing_id}')::uuid; n int;
begin
  perform api._as(p_user);
  delete from social.favourites where listing_id = v_listing;                                            -- RLS: own rows
  get diagnostics n = row_count;
  return api._ok(jsonb_build_object('listing_id', v_listing, 'favourite', false, 'removed', n > 0));
end $$;

-- GET /v1/me/favourites: newest first; query = {before (id), limit}. The workflow adds the listing cards.
create or replace function api.favourites_list(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare q jsonb := coalesce(p->'query', '{}'::jsonb); lim int := coalesce((q->>'limit')::int, 20); items jsonb;
begin
  perform api._as(p_user);
  select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'listing_id', f.listing_id, 'saved_at', f.created_at)
                            order by f.id desc), '[]'::jsonb)
    into items
    from (select * from social.favourites
           where (q->>'before' is null or id < (q->>'before')::bigint)
           order by id desc limit lim + 1) f;
  return api._ok(jsonb_build_object(
    'items', case when jsonb_array_length(items) > lim then items - lim else items end,
    'next_before', case when jsonb_array_length(items) > lim then items->(lim - 1)->'id' else 'null'::jsonb end,
    'total', (select count(*) from social.favourites)));
end $$;

-- Which of these listings the caller has saved (search results, listing page). Not an endpoint of its own.
create or replace function api.favourite_flags(p_user uuid, p_ids jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform api._as(p_user);
  return coalesce((select jsonb_agg(f.listing_id order by f.listing_id) from social.favourites f
                    where f.listing_id in (select (x)::uuid from jsonb_array_elements_text(coalesce(p_ids, '[]'::jsonb)) x)),
                  '[]'::jsonb);
end $$;

alter function api.favourite_put(uuid, jsonb) owner to app_rls;
alter function api.favourite_delete(uuid, jsonb) owner to app_rls;
alter function api.favourites_list(uuid, jsonb) owner to app_rls;
alter function api.favourite_flags(uuid, jsonb) owner to app_rls;
revoke execute on function api.favourite_put(uuid, jsonb), api.favourite_delete(uuid, jsonb),
  api.favourites_list(uuid, jsonb), api.favourite_flags(uuid, jsonb) from public;
grant execute on function api.favourite_put(uuid, jsonb), api.favourite_delete(uuid, jsonb),
  api.favourites_list(uuid, jsonb), api.favourite_flags(uuid, jsonb) to n8n_worker;

-- Erasure also deletes favourites (erase_user keeps the anonymised users row, so the cascade does not fire).
create or replace function app.platform_on_user_erased() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    delete from notify.notifications where user_id = new.id;
    delete from social.favourites where user_id = new.id;
  end if;
  return new;
end $$;

-- migrate:down
create or replace function app.platform_on_user_erased() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    delete from notify.notifications where user_id = new.id;
  end if;
  return new;
end $$;
drop function if exists api.favourite_flags(uuid, jsonb);
drop function if exists api.favourites_list(uuid, jsonb);
drop function if exists api.favourite_delete(uuid, jsonb);
drop function if exists api.favourite_put(uuid, jsonb);
drop table if exists social.favourites;
drop function if exists app.listing_change_cancel_request(uuid, uuid);
drop function if exists app.listing_public_view(uuid, uuid);
drop function if exists app.search_public_v2(jsonb);
delete from app.settings where key in ('media.photo_url_ttl_s', 'search.v2_candidates', 'favourites.max');
