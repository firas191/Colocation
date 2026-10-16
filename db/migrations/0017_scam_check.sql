-- migrate:up
-- A4 Scam check agent: price against the market, account signals, text signals (prompt P8).
-- The model lists signals with evidence; the weights and thresholds below are applied in code.

-- 1. Settings -------------------------------------------------------------------------
insert into app.settings (key, value, description) values
  ('scam.min_comparables', '5',
     'Fewest comparable published listings (same city, kind, currency) needed for a price signal; below it the whole jurisdiction is used, then no price signal'),
  ('scam.price_ratio', '{"very_low": 0.5, "low": 0.7, "high": 1.8, "very_high": 2.5}',
     'Rent divided by the median of comparable listings: below very_low or above very_high is a strong signal, between low/high and these is a weak one'),
  ('scam.new_account_days', '3',
     'An owner account younger than this many days is a weak signal'),
  ('scam.burst_listings_24h', '3',
     'An owner who created at least this many listings in 24 hours is a signal'),
  ('scam.weights', '{"price_very_low": 35, "price_low": 15, "price_very_high": 25, "price_high": 10, "price_mismatch": 30, "off_platform_payment": 30, "advance_payment": 30, "owner_abroad": 20, "urgency": 10, "external_contact": 10, "new_account": 10, "unverified_owner": 5, "listing_burst": 15}',
     'Points added to the score for each signal (the score is capped at 100)'),
  ('scam.thresholds', '{"review": 30, "block": 65}',
     'Score from which a listing goes to review, and from which it is blocked pending moderation')
on conflict (key) do nothing;

-- 2. Results ---------------------------------------------------------------------------
create table app.scam_checks (
  id          bigint generated always as identity primary key,
  listing_id  uuid not null references app.listings(id) on delete cascade,
  score       smallint not null check (score between 0 and 100),
  level       text not null check (level in ('low', 'medium', 'high')),
  signals     jsonb not null default '[]',   -- [{type, source: 'rule'|'model', evidence, weight}]
  detail      jsonb not null default '{}',   -- model output, prompt version, price context
  created_at  timestamptz not null default now()
);
create index on app.scam_checks (listing_id, created_at desc);
alter table app.scam_checks enable row level security;
grant select, insert on app.scam_checks to n8n_worker;

-- 3. Context given to the workflow ----------------------------------------------------------
-- Median monthly rent of comparable listings (weekly rents converted: x 52 / 12).
create or replace function app.scam_context(p_listing uuid) returns jsonb
language plpgsql stable as $$
declare
  l app.listings; u app.users; v_min int; v_n int; v_median numeric; v_scope text := 'city';
  v_burst int;
begin
  select * into l from app.listings where id = p_listing;
  if l.id is null then
    return jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND');
  end if;
  select * into u from app.users where id = l.owner_id;
  select coalesce((value #>> '{}')::int, 5) into v_min from app.settings where key = 'scam.min_comparables';
  v_min := coalesce(v_min, 5);

  select count(*), percentile_cont(0.5) within group (order by m.monthly)
    into v_n, v_median
  from (select case when rent_period = 'week' then rent_minor * 52.0 / 12 else rent_minor end as monthly
          from app.listings
         where id <> l.id and status = 'published' and kind = l.kind and currency = l.currency
           and jurisdiction_code = l.jurisdiction_code and lower(city) = lower(l.city)
           and rent_minor is not null and coalesce(rent_scope, 'per_room') <> 'whole_flat') m;
  if v_n < v_min then
    v_scope := 'jurisdiction';
    select count(*), percentile_cont(0.5) within group (order by m.monthly)
      into v_n, v_median
    from (select case when rent_period = 'week' then rent_minor * 52.0 / 12 else rent_minor end as monthly
            from app.listings
           where id <> l.id and status = 'published' and kind = l.kind and currency = l.currency
             and jurisdiction_code = l.jurisdiction_code
             and rent_minor is not null and coalesce(rent_scope, 'per_room') <> 'whole_flat') m;
  end if;
  if v_n < v_min then v_median := null; v_scope := 'none'; end if;

  select count(*) into v_burst from app.listings
   where owner_id = l.owner_id and l.owner_id is not null and created_at > now() - interval '24 hours';

  return jsonb_build_object('ok', true,
    'listing_id', l.id, 'jurisdiction_code', l.jurisdiction_code, 'kind', l.kind, 'city', l.city,
    'title', l.title, 'text', trim(coalesce(l.title, '') || E'\n' || coalesce(l.description, '')),
    'rent_minor', l.rent_minor, 'rent_period', l.rent_period, 'rent_scope', l.rent_scope, 'currency', l.currency,
    'deposit_minor', l.deposit_minor,
    'currency_exponent', (select exponent from app.currencies where code = l.currency),
    'market', jsonb_build_object('scope', v_scope, 'comparables', v_n, 'median_monthly_minor', round(v_median)),
    'owner', jsonb_build_object('account_age_days',
               case when u.id is null then null else floor(extract(epoch from (now() - u.created_at)) / 86400) end,
             'verified_level', u.verified_level, 'listings_24h', v_burst),
    'settings', (select jsonb_object_agg(key, value) from app.settings where key like 'scam.%'));
end $$;

-- 4. Store a check and update the listing's trust fields.
--    p: {score, level, signals, detail}. level low -> ok, medium -> review, high -> block.
create or replace function app.store_scam_check(p_listing uuid, p jsonb) returns jsonb
language plpgsql as $$
declare v_level text := p->>'level'; v_id bigint;
begin
  if not exists (select 1 from app.listings where id = p_listing) then
    return jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND');
  end if;
  if v_level not in ('low', 'medium', 'high') then
    return jsonb_build_object('ok', false, 'error_code', 'VALIDATION_FAILED', 'field', 'level');
  end if;
  insert into app.scam_checks (listing_id, score, level, signals, detail)
  values (p_listing, (p->>'score')::smallint, v_level, coalesce(p->'signals', '[]'), coalesce(p->'detail', '{}'))
  returning id into v_id;
  update app.listings set
    trust_score   = (p->>'score')::smallint,
    trust_verdict = case v_level when 'low' then 'ok' when 'medium' then 'review' else 'block' end,
    updated_at    = now()
  where id = p_listing;
  return jsonb_build_object('ok', true, 'check_id', v_id, 'listing_id', p_listing);
end $$;
-- migrate:down
drop function if exists app.store_scam_check(uuid, jsonb);
drop function if exists app.scam_context(uuid);
drop table if exists app.scam_checks;
delete from app.settings where key like 'scam.%';
