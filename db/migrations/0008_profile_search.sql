-- migrate:up
-- Phase 3: prompt registry and prompt evaluation, money and exchange rates,
-- places (geocoding), rent period, fuzzed public locations, search, profiles.
-- docs/DECISIONS.md D-053 to D-063 explain the choices made here.

-- ===========================================================================
-- 1. Prompt registry (spec 9.1). Files in prompts/ are the source; scripts/prompts.py
--    writes them here. A stored version is never edited: a changed template is a new version.
alter table ai.prompt_versions
  add column template_sha256 text,
  add column source_path     text;

-- The version a workflow runs: the active one, or a given number (evaluation runs).
create or replace function ai.prompt_for(p_name text, p_version integer default null) returns jsonb
language sql stable as $$
  select jsonb_build_object('prompt', p.name, 'version_id', v.id, 'version', v.version, 'status', v.status,
                            'template', v.template, 'output_schema', v.output_schema, 'model', v.model,
                            'params', v.params, 'techniques', to_jsonb(v.techniques))
  from ai.prompts p join ai.prompt_versions v on v.prompt_id = p.id
  where p.name = p_name
    and (case when p_version is null then v.status = 'active' else v.version = p_version end)
$$;

-- Failures found by an evaluation run (spec 9.5 step 2): one row per item and category.
alter table ai.prompt_failures
  add column eval_run_id uuid references eval.runs(id) on delete cascade,
  add column item_id     text;
create index on ai.prompt_failures (prompt_version_id, category);

-- Local language models (spec 5.5). Candidates of the phase-3 benchmark (D-053); the
-- default is a setting, changed after the benchmark, never hard-coded in workflows.
insert into ai.models (name, provider, is_local, kind, endpoint, active) values
  ('qwen3.5:4b',     'ollama', true, 'llm', 'ollama', true),
  ('granite4.2:3b',  'ollama', true, 'llm', 'ollama', true),
  ('phi4-mini:3.8b', 'ollama', true, 'llm', 'ollama', true)
on conflict (name) do nothing;

-- ===========================================================================
-- 2. Prompt evaluation datasets and results.
alter table eval.datasets drop constraint if exists datasets_kind_check;
alter table eval.datasets add constraint datasets_kind_check
  check (kind in ('retrieval','asr','trust','extraction','legal_qa','matching','routing'));
alter table eval.runs add column prompt_version_id uuid references ai.prompt_versions(id) on delete set null;
alter table eval.results alter column retrieved set default '[]'::jsonb;
alter table eval.results add column output jsonb;     -- model output of a prompt run (parsed or raw)

-- ===========================================================================
-- 3. Money (spec 4.2): integer minor units, exponent from app.currencies.
create or replace function app.currency_exponent(p_code text) returns smallint
language sql stable as $$ select exponent from app.currencies where code = upper(p_code) $$;

-- Major units (as written by a person: 450, 12.5) to minor units. NULL for an unknown
-- currency or an amount with more decimals than the currency has (12.345 EUR).
create or replace function app.to_minor(p_amount numeric, p_currency text) returns bigint
language sql stable as $$
  select case when p_amount * 10 ^ e = trunc(p_amount * 10 ^ e) then (p_amount * 10 ^ e)::bigint end
  from (select app.currency_exponent(p_currency)::int as e) x
$$;

-- Rates: one row says 1 <base> = <rate> <quote>, valid on <as_of>, from <source>.
create or replace function app.store_fx_rates(p jsonb) returns integer
language sql as $$
  with ins as (
    insert into app.fx_rates (base, quote, rate, as_of, source)
    select upper(r->>'base'), upper(r->>'quote'), (r->>'rate')::numeric, (r->>'as_of')::date, r->>'source'
    from jsonb_array_elements(p->'rates') r
    where exists (select 1 from app.currencies c where c.code = upper(r->>'quote'))
      and exists (select 1 from app.currencies c where c.code = upper(r->>'base'))
      and (r->>'rate')::numeric > 0
    on conflict (base, quote, as_of) do update set rate = excluded.rate, source = excluded.source
    returning 1)
  select count(*)::int from ins
$$;

-- Rate from one currency to another on a date: the latest published rate not older than
-- fx.max_age_days. Direct pair, inverse pair, or a cross rate through EUR (the ECB
-- publishes EUR-based rates only; a cross rate is a derived figure and is labelled so).
-- NULL when no rate is available.
create or replace function app.fx_quote(p_from text, p_to text, p_on date default current_date) returns jsonb
language plpgsql stable as $$
declare
  f text := upper(p_from); t text := upper(p_to);
  max_age int := coalesce((select (value #>> '{}')::int from app.settings where key = 'fx.max_age_days'), 7);
  r1 record; r2 record;
begin
  if f = t then
    return jsonb_build_object('rate', 1, 'as_of', p_on, 'source', null, 'path', 'identity');
  end if;
  -- direct or inverse
  select rate, as_of, source, false as inv into r1 from app.fx_rates
   where base = f and quote = t and as_of <= p_on and as_of > p_on - max_age order by as_of desc limit 1;
  if not found then
    select 1 / rate as rate, as_of, source, true as inv into r1 from app.fx_rates
     where base = t and quote = f and as_of <= p_on and as_of > p_on - max_age order by as_of desc limit 1;
  end if;
  if found then
    return jsonb_build_object('rate', r1.rate, 'as_of', r1.as_of, 'source', r1.source,
                              'path', case when r1.inv then 'inverse' else 'direct' end);
  end if;
  -- cross through EUR, both legs from the same publication date
  select a.rate as ra, b.rate as rb, a.as_of, a.source into r2
    from app.fx_rates a join app.fx_rates b on b.base = 'EUR' and b.as_of = a.as_of
   where a.base = 'EUR' and a.quote = f and b.quote = t
     and a.as_of <= p_on and a.as_of > p_on - max_age
   order by a.as_of desc limit 1;
  if found then
    return jsonb_build_object('rate', r2.rb / r2.ra, 'as_of', r2.as_of, 'source', r2.source, 'path', 'cross_eur');
  end if;
  if f = 'EUR' or t = 'EUR' then
    return null;
  end if;
  return null;
end $$;

-- Convert an amount in minor units. Rounds half away from zero (numeric round()).
create or replace function app.fx_convert_minor(p_amount bigint, p_from text, p_to text, p_on date default current_date)
returns jsonb language sql stable as $$
  select case when q is null or p_amount is null then null else
    q || jsonb_build_object('amount_minor',
      round(p_amount::numeric / 10 ^ app.currency_exponent(p_from) * (q->>'rate')::numeric
            * 10 ^ app.currency_exponent(p_to))::bigint,
      'currency', upper(p_to)) end
  from (select app.fx_quote(p_from, p_to, p_on) as q) x
$$;

-- ===========================================================================
-- 4. Rent period. Listings can state a weekly rent (GB practice, P3 schema); search
--    compares monthly equivalents: weekly x 52 / 12, rounded down (D-056).
alter table app.listings
  add column rent_period text not null default 'month' check (rent_period in ('month','week')),
  add column rent_monthly_minor bigint generated always as
    (case when rent_period = 'week' then floor(rent_minor * 52 / 12.0)::bigint else rent_minor end) stored;
create index listings_search on app.listings (jurisdiction_code, status, currency, rent_monthly_minor);
grant select (rent_period, rent_monthly_minor) on app.listings to api_user;
grant insert (rent_period), update (rent_period) on app.listings to api_user;

alter table app.profiles
  add column budget_period text check (budget_period in ('month','week')),
  add column unparsed      text[] not null default '{}',
  add column field_confidence jsonb not null default '{}'::jsonb,
  add column extraction    jsonb;                -- prompt version, model, warnings of the last extraction

-- ===========================================================================
-- 5. Fuzzed public location (spec 4.2). The exact point is never exposed; the public point
--    is moved by a random distance in [geo.fuzz_min_m, geo.fuzz_max_m] in a random
--    direction, drawn once when the exact point changes. Random, not derived from the
--    listing id: a derived offset could be recomputed by anyone who knows the id (D-059).
create or replace function app.random_unit() returns double precision
language sql volatile as $$
  select ('x' || encode(public.gen_random_bytes(6), 'hex'))::bit(48)::bigint / 281474976710656.0
$$;

create or replace function app.fuzz_point(p geography, p_min_m double precision, p_max_m double precision)
returns geography language sql volatile as $$
  -- uniform over the area of the ring between the two radii
  select public.st_project(p, sqrt(app.random_unit() * (p_max_m ^ 2 - p_min_m ^ 2) + p_min_m ^ 2),
                           app.random_unit() * 2 * pi())
$$;

-- SECURITY DEFINER: owners write listings through api_user, which may not read app.settings.
create or replace function app.listings_fuzz_location() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  mn double precision := coalesce((select (value #>> '{}')::float from app.settings where key = 'geo.fuzz_min_m'), 150);
  mx double precision := coalesce((select (value #>> '{}')::float from app.settings where key = 'geo.fuzz_max_m'), 400);
begin
  if new.location is null then
    -- no exact point: a public point given on its own (approximate area) is kept, but one
    -- derived from an exact point that is being removed goes with it
    if tg_op = 'UPDATE' and old.location is not null then
      new.public_location := null;
    end if;
  elsif tg_op = 'INSERT' or old.location is null
        or public.st_asbinary(new.location) is distinct from public.st_asbinary(old.location) then
    new.public_location := app.fuzz_point(new.location, mn, mx);
  else
    new.public_location := old.public_location;   -- not settable on its own
  end if;
  return new;
end $$;
create trigger trg_listings_fuzz before insert or update on app.listings
  for each row execute function app.listings_fuzz_location();

-- ===========================================================================
-- 6. Places (geocoding, D-058). A gazetteer of named places with coordinates from
--    OpenStreetMap (fetched once, cached, attributed), searched locally: the text a
--    user types is never sent to an outside geocoder.
create table app.places (
  id            bigint generated always as identity primary key,
  place_key     text not null unique check (place_key ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
  jurisdiction_code text not null references app.jurisdictions(code),
  kind          text not null check (kind in ('city','district','neighbourhood','campus','station','landmark')),
  name          text not null,
  city          text,
  admin_area    text,
  location      geography(Point,4326) not null,
  source        text not null,                   -- 'osm-nominatim' or 'test'
  osm_type      text,
  osm_id        bigint,
  display_name  text,                            -- as returned by the source
  fetched_on    date,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index on app.places (jurisdiction_code);

-- Text used to match place names: lower case, no accents or harakat, punctuation as spaces.
create or replace function app.geo_normalize(t text) returns text
language sql immutable parallel safe as $$
  select btrim(regexp_replace(
           regexp_replace(kb.lex_normalize(t), '[-_''’‘ʼ`´.,;:!?()/\\«»"،؛؟]+', ' ', 'g'),
           '\s+', ' ', 'g'))
$$;

create table app.place_names (
  place_id  bigint not null references app.places(id) on delete cascade,
  name      text not null,
  lang      text,                                -- BCP-47, 'aeb-Latn' for transliterated Tunisian
  norm      text generated always as (app.geo_normalize(name)) stored,
  primary key (place_id, name)
);
create index place_names_norm on app.place_names (norm);
create index place_names_trgm on app.place_names using gin (norm gin_trgm_ops);

-- Resolve a place name within a jurisdiction. Scores: exact name 1.0; a known name that
-- appears as whole words inside the text 0.9; otherwise trigram similarity. The best
-- place is 'found' when its score reaches geo.min_similarity and no other place has the
-- same score ('ambiguous' otherwise, with the candidates).
create or replace function app.geocode(p_text text, p_jurisdiction text) returns jsonb
language sql stable as $$
  with q as (select app.geo_normalize(p_text) as n),
  m as (
    select pn.place_id,
           max(case when pn.norm = q.n then 1.0
                    when length(pn.norm) >= 4 and position(' ' || pn.norm || ' ' in ' ' || q.n || ' ') > 0 then 0.9
                    else public.similarity(pn.norm, q.n) end) as score
    from q join app.place_names pn
      on pn.norm = q.n or public.similarity(pn.norm, q.n) > 0.3
         or (length(pn.norm) >= 4 and position(' ' || pn.norm || ' ' in ' ' || q.n || ' ') > 0)
    join app.places p on p.id = pn.place_id and p.active and p.jurisdiction_code = p_jurisdiction
    where q.n <> ''
    group by pn.place_id
  ),
  ranked as (
    select p.place_key, p.name, p.kind, p.city, round(m.score::numeric, 3) as score,
           public.st_y(p.location::geometry) as lat, public.st_x(p.location::geometry) as lng,
           rank() over (order by m.score desc) as rk
    from m join app.places p on p.id = m.place_id
  ),
  thr as (select coalesce((select (value #>> '{}')::float from app.settings where key = 'geo.min_similarity'), 0.6) as t)
  select jsonb_build_object(
    'query', p_text,
    'status', case when not exists (select 1 from ranked, thr where rk = 1 and score >= thr.t) then 'not_found'
                   when (select count(*) from ranked where rk = 1) > 1 then 'ambiguous'
                   else 'found' end,
    'place', (select to_jsonb(r) - 'rk' from ranked r, thr where rk = 1 and score >= thr.t
              and (select count(*) from ranked where rk = 1) = 1),
    'candidates', coalesce((select jsonb_agg(to_jsonb(r) - 'rk' order by r.score desc, r.place_key)
                            from (select * from ranked order by score desc, place_key limit 5) r), '[]'::jsonb))
$$;

-- ===========================================================================
-- 7. Search (spec 2.4 journey A step 5). app.search_listings keeps its signature; the
--    budget is compared on the monthly equivalent, and ties are broken by id.
create or replace function app.search_listings(
  q_embedding  vector(1024),
  q_text       text,
  p_jurisdiction text,
  p_max_rent_minor bigint default null,
  p_currency   char(3) default null,
  p_center     geography default null,
  p_radius_m   integer default null,
  p_limit      integer default 20
) returns table (
  listing_id uuid, score double precision, dense_rank integer, lexical_rank integer,
  distance_m double precision
) language sql stable as $$
  with filt as (
    select l.id, l.embedding, l.tsv,
           case when p_center is not null then st_distance(l.public_location, p_center) end as dist
    from app.listings l
    where l.status = 'published'
      and l.jurisdiction_code = p_jurisdiction
      and (p_max_rent_minor is null or (l.rent_monthly_minor <= p_max_rent_minor and l.currency = p_currency))
      and (p_center is null or p_radius_m is null or st_dwithin(l.public_location, p_center, p_radius_m))
  ),
  dense as (
    select id, (row_number() over (order by embedding <=> q_embedding, id))::int as r
    from filt where embedding is not null and q_embedding is not null
    order by embedding <=> q_embedding, id limit 100
  ),
  lex as (
    select id, (row_number() over (order by ts_rank_cd(tsv, app.or_tsquery(q_text)) desc, id))::int as r
    from filt where tsv @@ app.or_tsquery(q_text)
    order by ts_rank_cd(tsv, app.or_tsquery(q_text)) desc, id limit 100
  )
  select coalesce(d.id, x.id) as listing_id,
         (coalesce(1.0/(60 + d.r), 0) + coalesce(1.0/(60 + x.r), 0))::double precision as score,
         d.r, x.r,
         (select f.dist from filt f where f.id = coalesce(d.id, x.id))
  from dense d full join lex x on d.id = x.id
  order by 2 desc, 1
  limit p_limit
$$;

-- One search as the API runs it, with the time spent in the database.
-- p = {jurisdiction, q_text, q_vec ('[..]' or null), max_rent_minor, currency, budget_period,
--      lat, lng, place, radius_m, limit, on_date}
-- Returns public fields only (never the exact location), warnings as codes, and what was applied.
create or replace function app.search_public(p jsonb) returns jsonb
language plpgsql stable as $$
declare
  t0 timestamptz := clock_timestamp();
  j record;
  warnings jsonb := '[]'::jsonb;
  v_lim int := least(greatest(coalesce((p->>'limit')::int,
                 (select (value #>> '{}')::int from app.settings where key = 'search.default_limit'), 20), 1),
               coalesce((select (value #>> '{}')::int from app.settings where key = 'search.max_limit'), 50));
  v_cur text; v_max bigint; v_budget jsonb := null; fx jsonb;
  v_center geography := null; v_radius int := null; v_place jsonb := null; g jsonb;
  v_text text := nullif(btrim(coalesce(p->>'q_text', '')), '');
  v_vec vector(1024) := (p->>'q_vec')::vector(1024);
  v_on date := coalesce((p->>'on_date')::date, current_date);
  ids jsonb; res jsonb; mode text;
begin
  select code, default_currency into j from app.jurisdictions where code = p->>'jurisdiction';
  if not found then
    return jsonb_build_object('error', 'unknown_jurisdiction');
  end if;

  -- budget: monthly equivalent in the jurisdiction's currency
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

  -- distance: explicit point, or a place name resolved by app.geocode
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

  if v_text is not null or v_vec is not null then
    mode := 'hybrid';
    select coalesce(jsonb_agg(jsonb_build_object('id', s.listing_id, 'score', round(s.score::numeric, 6),
                                                 'dense_rank', s.dense_rank, 'lexical_rank', s.lexical_rank,
                                                 'distance_m', round(s.distance_m::numeric)) order by s.score desc, s.listing_id), '[]')
      into ids
      from app.search_listings(v_vec, coalesce(v_text, ''), j.code, v_max, v_cur::char(3), v_center, v_radius, v_lim) s;
  else
    -- filters only: nearest first when there is a point, else newest first
    mode := 'filters';
    select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'score', null, 'dense_rank', null, 'lexical_rank', null,
                                                 'distance_m', round(x.dist::numeric)) order by x.ord1, x.ord2 desc nulls last, x.id), '[]')
      into ids
      from (select l.id, case when v_center is not null then st_distance(l.public_location, v_center) end as dist,
                   case when v_center is not null then st_distance(l.public_location, v_center) else 0 end as ord1,
                   l.published_at as ord2
              from app.listings l
             where l.status = 'published' and l.jurisdiction_code = j.code
               and (v_max is null or (l.rent_monthly_minor <= v_max and l.currency = v_cur))
               and (v_center is null or v_radius is null or st_dwithin(l.public_location, v_center, v_radius))
             order by 3, 4 desc nulls last, 1
             limit v_lim) x;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'rank', r.ord, 'score', r.e->'score', 'dense_rank', r.e->'dense_rank', 'lexical_rank', r.e->'lexical_rank',
           'distance_m', r.e->'distance_m',
           'kind', l.kind, 'title', l.title, 'description', left(l.description, 400), 'description_lang', l.description_lang,
           'rent', jsonb_build_object('amount_minor', l.rent_minor, 'currency', l.currency, 'period', l.rent_period,
                                      'monthly_minor', l.rent_monthly_minor, 'exponent', c.exponent),
           'deposit_minor', l.deposit_minor, 'bills_included', l.bills_included,
           'available_from', l.available_from, 'min_stay_months', l.min_stay_months,
           'bedrooms', l.bedrooms, 'furnished', l.furnished, 'current_flatmates', l.current_flatmates,
           'amenities', to_jsonb(l.amenities), 'house_rules', l.house_rules,
           'city', l.city, 'neighbourhood', l.neighbourhood,
           'public_location', case when l.public_location is null then null else
              jsonb_build_object('lat', round(st_y(l.public_location::geometry)::numeric, 5),
                                 'lng', round(st_x(l.public_location::geometry)::numeric, 5)) end,
           'trust', jsonb_build_object('score', l.trust_score, 'verdict', l.trust_verdict),
           'is_synthetic', l.is_synthetic) order by r.ord), '[]'::jsonb)
    into res
    from jsonb_array_elements(ids) with ordinality r(e, ord)
    join app.listings l on l.id = (r.e->>'id')::uuid
    left join app.currencies c on c.code = l.currency;

  return jsonb_build_object(
    'mode', mode, 'results', res, 'count', jsonb_array_length(res), 'warnings', warnings,
    'applied', jsonb_build_object('jurisdiction', j.code, 'budget', v_budget, 'text', v_text is not null,
                                  'vector', v_vec is not null,
                                  'center', case when v_center is null then null else
                                     jsonb_build_object('lat', round(st_y(v_center::geometry)::numeric, 5),
                                                        'lng', round(st_x(v_center::geometry)::numeric, 5)) end,
                                  'radius_m', v_radius, 'place', v_place, 'limit', v_lim),
    'db_ms', round(extract(epoch from clock_timestamp() - t0) * 1000, 2));
end $$;

-- Listings without an embedding for a model (worker wf.listings.embed).
create or replace function app.listings_to_embed(p_limit integer default 500) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'text', t) order by id), '[]'::jsonb)
  from (select id, concat_ws(E'\n', title, description, nullif(concat_ws(', ', neighbourhood, city), '')) as t
          from app.listings where embedding is null and status in ('published', 'pending_review', 'draft')
         order by id limit p_limit) x
$$;

create or replace function app.store_listing_embeddings(p_model text, p_rows jsonb) returns integer
language sql as $$
  with up as (
    update app.listings l set embedding = (r->>'v')::vector(1024), embedding_model = p_model
      from jsonb_array_elements(p_rows) r
     where l.id = (r->>'id')::uuid
    returning 1)
  select count(*)::int from up
$$;

-- ===========================================================================
-- 8. Profiles (PUT /v1/profiles/me). Body already validated by the workflow; the
--    anchor is resolved here from its label when no point is given.
create or replace function app.save_profile(p_user uuid, p jsonb) returns jsonb
language plpgsql as $$
declare g jsonb := null; v_point geography := null; row app.profiles;
begin
  if p->>'anchor_lat' is not null and p->>'anchor_lng' is not null then
    v_point := st_setsrid(st_makepoint((p->>'anchor_lng')::float, (p->>'anchor_lat')::float), 4326)::geography;
  elsif nullif(p->>'anchor_label', '') is not null and p->>'jurisdiction_code' is not null then
    g := app.geocode(p->>'anchor_label', p->>'jurisdiction_code');
    if g->>'status' = 'found' then
      v_point := st_setsrid(st_makepoint((g#>>'{place,lng}')::float, (g#>>'{place,lat}')::float), 4326)::geography;
    end if;
  end if;
  insert into app.profiles as pr (user_id, jurisdiction_code, budget_min_minor, budget_max_minor, currency, budget_period,
      anchor_point, anchor_label, max_commute_min, search_radius_m, move_in_from, min_stay_months,
      declared_preferences, languages, unparsed, field_confidence, extraction, raw_text)
  values (p_user, p->>'jurisdiction_code', (p->>'budget_min_minor')::bigint, (p->>'budget_max_minor')::bigint,
      p->>'currency', p->>'budget_period', v_point, p->>'anchor_label', (p->>'max_commute_min')::smallint,
      (p->>'search_radius_m')::int, (p->>'move_in_from')::date, (p->>'min_stay_months')::smallint,
      coalesce(p->'declared_preferences', '{}'::jsonb),
      coalesce(array(select jsonb_array_elements_text(p->'languages')), '{}'),
      coalesce(array(select jsonb_array_elements_text(p->'unparsed')), '{}'),
      coalesce(p->'field_confidence', '{}'::jsonb), p->'extraction', null)
  on conflict (user_id) do update set
      jurisdiction_code = excluded.jurisdiction_code, budget_min_minor = excluded.budget_min_minor,
      budget_max_minor = excluded.budget_max_minor, currency = excluded.currency, budget_period = excluded.budget_period,
      anchor_point = excluded.anchor_point, anchor_label = excluded.anchor_label, max_commute_min = excluded.max_commute_min,
      search_radius_m = excluded.search_radius_m, move_in_from = excluded.move_in_from,
      min_stay_months = excluded.min_stay_months, declared_preferences = excluded.declared_preferences,
      languages = excluded.languages, unparsed = excluded.unparsed, field_confidence = excluded.field_confidence,
      extraction = coalesce(excluded.extraction, pr.extraction), raw_text = null,
      profile_version = pr.profile_version + 1
  returning * into row;
  return jsonb_build_object(
    'id', row.id, 'profile_version', row.profile_version, 'jurisdiction_code', row.jurisdiction_code,
    'budget_min_minor', row.budget_min_minor, 'budget_max_minor', row.budget_max_minor, 'currency', row.currency,
    'budget_period', row.budget_period, 'anchor_label', row.anchor_label,
    'anchor', case when row.anchor_point is null then null else
       jsonb_build_object('lat', round(st_y(row.anchor_point::geometry)::numeric, 5),
                          'lng', round(st_x(row.anchor_point::geometry)::numeric, 5)) end,
    'anchor_geocode', g, 'max_commute_min', row.max_commute_min, 'search_radius_m', row.search_radius_m,
    'move_in_from', row.move_in_from, 'min_stay_months', row.min_stay_months,
    'declared_preferences', row.declared_preferences, 'languages', to_jsonb(row.languages),
    'unparsed', to_jsonb(row.unparsed), 'updated_at', row.updated_at);
end $$;

-- What the profile extractor needs to know about a jurisdiction (prompt variables).
create or replace function app.extraction_context(p_jurisdiction text) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'jurisdiction', j.code, 'default_currency', j.default_currency, 'languages', to_jsonb(j.languages),
    'timezone', j.timezone,
    'allowed_preference_filters', coalesce(j.rules->'allowed_preference_filters',
       (select value from app.settings where key = 'profile.default_preference_filters')),
    'currencies', (select jsonb_object_agg(code, exponent) from app.currencies))
  from app.jurisdictions j where j.code = p_jurisdiction
$$;

-- ===========================================================================
-- 9. Agent steps are written with the request record (spec 8.3): app.api_finish takes
--    an optional "steps" array and adds their tokens to the execution.
create or replace function app.api_finish(p jsonb) returns void
language plpgsql as $$
declare
  v_status integer := (p->>'status_code')::int;
  v_scope  text := p#>>'{idempotency,scope}';
  v_key    text := p#>>'{idempotency,key}';
  v_exec   uuid;
begin
  insert into ai.executions (request_id, workflow, n8n_execution_id, user_id, channel, status,
                             started_at, finished_at, latency_ms, error, tokens_in, tokens_out)
  values ((p->>'request_id')::uuid, p->>'workflow', p->>'n8n_execution_id',
          (select u.id from app.users u where u.id = app.try_uuid(p->>'user_id')),
          coalesce(p->>'channel', 'api'),
          case when v_status >= 500 then 'failed' else 'succeeded' end,
          clock_timestamp() - make_interval(secs => coalesce((p->>'latency_ms')::numeric, 0) / 1000.0),
          clock_timestamp(), (p->>'latency_ms')::int,
          nullif(concat_ws(' | ', p->>'error_code', nullif(p->>'error_detail', '')), ''),
          coalesce((select sum((s->>'tokens_in')::int) from jsonb_array_elements(coalesce(p->'steps', '[]')) s), 0),
          coalesce((select sum((s->>'tokens_out')::int) from jsonb_array_elements(coalesce(p->'steps', '[]')) s), 0))
  returning id into v_exec;

  insert into ai.agent_steps (execution_id, step_index, agent, prompt_version_id, model, input, output,
                              tool_calls, latency_ms, tokens_in, tokens_out, error)
  select v_exec, (ord - 1)::int, s->>'agent', app.try_uuid(s->>'prompt_version_id'), s->>'model',
         s->'input', s->'output', coalesce(s->'tool_calls', '[]'::jsonb), (s->>'latency_ms')::int,
         coalesce((s->>'tokens_in')::int, 0), coalesce((s->>'tokens_out')::int, 0), s->>'error'
  from jsonb_array_elements(coalesce(p->'steps', '[]'::jsonb)) with ordinality x(s, ord);

  if v_scope is not null and v_key is not null and coalesce((p->>'idempotency_replay')::boolean, false) = false then
    if v_status >= 500 then
      perform app.idempotency_release(v_scope, v_key);
    else
      perform app.idempotency_complete(v_scope, v_key, v_status, p->'response_body',
                                       app.try_uuid(p->>'result_user_id'));
    end if;
  end if;
end $$;

-- ===========================================================================
-- 10. Settings (no secrets). Thresholds marked "design choice" are not measurements.
insert into app.settings (key, value, description) values
  ('llm.default_model',  '"qwen3.5:4b"', 'Local LLM used by P1 and P2 until the phase-3 benchmark decides (D-053)'),
  ('llm.timeout_ms',     '120000', 'Timeout of one LLM call'),
  ('llm.num_ctx',        '4096',   'Context window requested from Ollama for P1 and P2'),
  ('llm.keep_alive',     '"10m"',  'How long Ollama keeps the model loaded after a call'),
  ('llm.seed',           '42',     'Sampling seed for LLM calls (temperature 0 makes it mostly irrelevant)'),
  ('llm.model_overrides', '{"qwen3.5:4b": {"think": false}}', 'Per-model request fields; Qwen3.5 thinks by default and must be told not to (D-053)'),
  ('router.min_confidence', '0.6', 'Below this P1 confidence the orchestrator asks a clarifying question (design choice, revisited with the golden set)'),
  ('search.default_limit', '20',   'Results returned when the request does not say'),
  ('search.max_limit',     '50',   'Largest page of results'),
  ('search.default_radius_m', '5000', 'Radius around a place or point when the request gives none (design choice)'),
  ('geo.fuzz_min_m',     '150',    'Smallest distance between the exact and the public point of a listing (design choice)'),
  ('geo.fuzz_max_m',     '400',    'Largest distance between the exact and the public point of a listing (design choice)'),
  ('geo.min_similarity', '0.6',    'Smallest name-match score for a place to count as found (design choice)'),
  ('fx.max_age_days',    '7',      'Oldest exchange rate used for a conversion, in days'),
  ('fx.ecb_url',         '"https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"', 'ECB euro reference rates (D-057)'),
  ('profile.default_preference_filters', '["smoking","pets","quiet_hours","guests","schedule","languages","cleanliness"]',
     'Declared preferences accepted when a jurisdiction pack has no list (spec 4.4; budget is a profile field)')
on conflict (key) do nothing;

-- ===========================================================================
-- Grants (D-012: nothing executable by PUBLIC).
revoke execute on function ai.prompt_for(text, integer), app.currency_exponent(text), app.to_minor(numeric, text),
  app.store_fx_rates(jsonb), app.fx_quote(text, text, date), app.fx_convert_minor(bigint, text, text, date),
  app.random_unit(), app.fuzz_point(geography, double precision, double precision), app.listings_fuzz_location(),
  app.geo_normalize(text), app.geocode(text, text), app.search_public(jsonb), app.listings_to_embed(integer),
  app.store_listing_embeddings(text, jsonb), app.save_profile(uuid, jsonb), app.extraction_context(text)
  from public;
grant execute on function ai.prompt_for(text, integer), app.currency_exponent(text), app.to_minor(numeric, text),
  app.store_fx_rates(jsonb), app.fx_quote(text, text, date), app.fx_convert_minor(bigint, text, text, date),
  app.random_unit(), app.fuzz_point(geography, double precision, double precision),
  app.geo_normalize(text), app.geocode(text, text), app.search_public(jsonb), app.listings_to_embed(integer),
  app.store_listing_embeddings(text, jsonb), app.save_profile(uuid, jsonb), app.extraction_context(text)
  to n8n_worker;

-- migrate:down
-- app.api_finish as in migration 0006
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
drop function if exists app.extraction_context(text);
drop function if exists app.save_profile(uuid, jsonb);
drop function if exists app.store_listing_embeddings(text, jsonb);
drop function if exists app.listings_to_embed(integer);
drop function if exists app.search_public(jsonb);
drop function if exists app.geocode(text, text);
drop table if exists app.place_names;
drop table if exists app.places;
drop function if exists app.geo_normalize(text);
drop trigger if exists trg_listings_fuzz on app.listings;
drop function if exists app.listings_fuzz_location();
drop function if exists app.fuzz_point(geography, double precision, double precision);
drop function if exists app.random_unit();
alter table app.profiles drop column if exists extraction, drop column if exists field_confidence,
  drop column if exists unparsed, drop column if exists budget_period;
drop index if exists app.listings_search;
alter table app.listings drop column if exists rent_monthly_minor, drop column if exists rent_period;
drop function if exists app.fx_convert_minor(bigint, text, text, date);
drop function if exists app.fx_quote(text, text, date);
drop function if exists app.store_fx_rates(jsonb);
drop function if exists app.to_minor(numeric, text);
drop function if exists app.currency_exponent(text);
alter table eval.results drop column if exists output;
alter table eval.runs drop column if exists prompt_version_id;
alter table eval.datasets drop constraint if exists datasets_kind_check;
alter table eval.datasets add constraint datasets_kind_check
  check (kind in ('retrieval','asr','trust','extraction','legal_qa','matching'));
delete from ai.models where name in ('qwen3.5:4b', 'granite4.2:3b', 'phi4-mini:3.8b');
alter table ai.prompt_failures drop column if exists item_id, drop column if exists eval_run_id;
drop function if exists ai.prompt_for(text, integer);
alter table ai.prompt_versions drop column if exists source_path, drop column if exists template_sha256;
delete from app.settings where key in ('llm.default_model','llm.timeout_ms','llm.model_overrides','llm.num_ctx','llm.keep_alive','llm.seed',
  'router.min_confidence','search.default_limit','search.max_limit','search.default_radius_m','geo.fuzz_min_m',
  'geo.fuzz_max_m','geo.min_similarity','fx.max_age_days','fx.ecb_url','profile.default_preference_filters');
