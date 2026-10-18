-- migrate:up
-- Platform phase P8 (docs/PLATFORM_SPEC.md 3.10, 4, 9 P8; backend spec 12; DECISIONS D-107): price benchmarks, trust
-- signals and score, the trust check before publication, the moderation queue and its decisions, report triage,
-- warnings on messages, badges.

-- Points: the "initial points" of backend spec 12.2. Signals marked (D-107) are mine: they have no line in 12.2.
insert into app.settings (key, value, description) values
  ('trust.enabled', 'true', 'Run the trust check when an owner submits a listing (D-107). Off: submit publishes directly, as in P3'),
  ('trust.agent_enabled', 'true', 'Use the Trust agent (A4) inside the trust check. Off: rules and database checks only'),
  ('trust.agent_max_iterations', '6', 'Most model turns of the Trust agent'),
  ('trust.num_ctx', '8192', 'Context window of the Trust agent'),
  ('trust.points', '{"duplicate_photo_other_owner": -40, "payment_before_viewing": -40, "untraceable_payment": -30, "price_far_below": -25,
    "owner_abroad": -10, "contact_off_platform": -10, "urgency_pressure": -10, "inconsistent_details": -15, "exif_far_from_listing": -15,
    "new_account_many_listings": -10, "consistent_history": 10, "discriminatory_language": 0,
    "payment_claim_unconfirmed": -15, "too_good_price_claim": -10, "other": -10}',
   'Most points per signal (backend spec 12.2 initial points; payment_claim_unconfirmed, too_good_price_claim and other: D-107). Starting values, not tuned'),
  ('trust.hard_signals', '["duplicate_photo_other_owner", "payment_before_viewing"]', 'Signals that allow a block (backend spec 12.2)'),
  ('trust.benchmark_min', '5', 'Fewest comparable listings for a price benchmark; fewer: insufficient_data, never a guess (12.3)'),
  ('trust.price_ratio', '{"review": 0.6, "strong": 0.4}', 'Rent under review x median: -15; under strong x median: the full points (D-107, a choice, not measured)'),
  ('trust.exif_far_m', '5000', 'A photo taken this far or farther from the listing place is a signal (only when EXIF has a position)'),
  ('trust.new_account', '{"days": 7, "listings": 3}', 'An account younger than days with at least listings listings is a signal')
on conflict (key) do nothing;

-- 1. Price benchmarks (12.3): median and spread of the monthly rent per country, city and kind. source real: published,
--    non-synthetic listings; source seed: the same with the synthetic demo listings, used only while real is too small,
--    and labelled so.
create table app.price_benchmarks (
  jurisdiction_code text not null references app.jurisdictions(code),
  city              text not null default '',          -- '' = the whole country
  kind              text not null,
  currency          char(3) not null,
  source            text not null check (source in ('real', 'seed')),
  n                 int not null,
  median_minor      bigint not null,
  p25_minor         bigint not null,
  p75_minor         bigint not null,
  computed_at       timestamptz not null default now(),
  primary key (jurisdiction_code, city, kind, currency, source)
);
grant select on app.price_benchmarks to n8n_worker;

create or replace function app.refresh_price_benchmarks() returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare n int;
begin
  delete from app.price_benchmarks;
  insert into app.price_benchmarks (jurisdiction_code, city, kind, currency, source, n, median_minor, p25_minor, p75_minor)
  select l.jurisdiction_code, g.city, l.kind, l.currency, s.source, count(*),
         percentile_cont(0.5) within group (order by l.rent_monthly_minor)::bigint,
         percentile_cont(0.25) within group (order by l.rent_monthly_minor)::bigint,
         percentile_cont(0.75) within group (order by l.rent_monthly_minor)::bigint
    from app.listings l
    cross join (values ('real'), ('seed')) s(source)
    cross join lateral (select lower(btrim(l.city)) where nullif(btrim(l.city), '') is not null union all select '') g(city)
   where l.status = 'published' and l.rent_monthly_minor is not null and l.currency is not null
     and (s.source = 'seed' or not l.is_synthetic)
   group by l.jurisdiction_code, g.city, l.kind, l.currency, s.source;
  get diagnostics n = row_count;
  return jsonb_build_object('benchmarks', n, 'at', now());
end $$;

-- the benchmark that applies to a listing: real before seed, the city before the whole country, enough listings
create or replace function app.price_benchmark_for(p_listing uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare l app.listings; b app.price_benchmarks; v_min int := coalesce((select (value #>> '{}')::int from app.settings where key = 'trust.benchmark_min'), 5);
begin
  select * into l from app.listings where id = p_listing;
  if l.rent_monthly_minor is null then return jsonb_build_object('status', 'no_rent'); end if;
  select * into b from app.price_benchmarks
   where jurisdiction_code = l.jurisdiction_code and kind = l.kind and currency = l.currency and n >= v_min
     and city in (coalesce(lower(btrim(l.city)), ''), '')
   order by (source = 'real') desc, (city <> '') desc limit 1;
  if b.n is null then return jsonb_build_object('status', 'insufficient_data', 'min', v_min); end if;
  return jsonb_build_object('status', 'ok', 'source', b.source, 'level', case when b.city = '' then 'country' else 'city' end,
    'n', b.n, 'median_minor', b.median_minor, 'p25_minor', b.p25_minor, 'p75_minor', b.p75_minor, 'rent_minor', l.rent_monthly_minor,
    'ratio', round(l.rent_monthly_minor::numeric / nullif(b.median_minor, 0), 2), 'currency', l.currency);
end $$;

-- 2. Facts and signals from the database (no model). The Trust agent's tools read these; the score uses the signals.
create or replace function app.trust_facts(p_listing uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare l app.listings; u app.users; pts jsonb; sig jsonb := '[]'; dups jsonb; bench jsonb; hist jsonb; exif jsonb; issues jsonb;
  v_thr int := coalesce((select (value #>> '{}')::int from app.settings where key = 'media.phash_max_distance'), 12);
  v_far int := coalesce((select (value #>> '{}')::int from app.settings where key = 'trust.exif_far_m'), 5000);
  na jsonb := coalesce((select value from app.settings where key = 'trust.new_account'), '{"days": 7, "listings": 3}');
  pr jsonb := coalesce((select value from app.settings where key = 'trust.price_ratio'), '{"review": 0.6, "strong": 0.4}');
  v_contact text;
begin
  select * into l from app.listings where id = p_listing;
  if l.id is null then return null; end if;
  select * into u from app.users where id = l.owner_id;
  pts := coalesce((select value from app.settings where key = 'trust.points'), '{}');
  -- photos also used by another owner's listing (12.2: the same owner reposting is not a signal)
  select coalesce(jsonb_agg(distinct jsonb_build_object('media_id', m.id, 'other_listing_id', s.listing_id, 'distance', s.distance)), '[]')
    into dups
    from app.listing_media m cross join lateral app.find_similar_media(m.phash, v_thr, l.id) s
    join app.listings ol on ol.id = s.listing_id
   where m.listing_id = l.id and m.phash is not null and ol.owner_id is distinct from l.owner_id;
  if jsonb_array_length(dups) > 0 then
    sig := sig || jsonb_build_object('signal', 'duplicate_photo_other_owner', 'points', pts->'duplicate_photo_other_owner', 'source', 'database',
      'evidence', jsonb_build_object('photos', jsonb_array_length(dups), 'other_listings',
        (select jsonb_agg(distinct d->'other_listing_id') from jsonb_array_elements(dups) d)));
  end if;
  bench := app.price_benchmark_for(l.id);
  if bench->>'status' = 'ok' and (bench->>'ratio')::numeric < (pr->>'review')::numeric then
    sig := sig || jsonb_build_object('signal', 'price_far_below', 'source', 'benchmark',
      'points', case when (bench->>'ratio')::numeric < (pr->>'strong')::numeric then (pts->>'price_far_below')::int else -15 end,
      'evidence', bench - 'status');
  end if;
  hist := jsonb_build_object(
    'account_days', extract(day from now() - u.created_at)::int,
    'listings_total', (select count(*) from app.listings where owner_id = l.owner_id),
    'listings_recent', (select count(*) from app.listings where owner_id = l.owner_id and created_at > now() - make_interval(days => (na->>'days')::int)),
    'published_before', (select count(*) from app.listings where owner_id = l.owner_id and id <> l.id and published_at < now() - interval '30 days'),
    'reports', (select count(*) from app.reports r where r.target_user_id = l.owner_id or r.listing_id in (select id from app.listings where owner_id = l.owner_id)),
    'rejected', (select count(*) from app.listings where owner_id = l.owner_id and status = 'rejected'));
  if (hist->>'account_days')::int < (na->>'days')::int and (hist->>'listings_recent')::int >= (na->>'listings')::int then
    sig := sig || jsonb_build_object('signal', 'new_account_many_listings', 'points', pts->'new_account_many_listings', 'source', 'database',
      'evidence', hist);
  end if;
  if (hist->>'published_before')::int > 0 and (hist->>'reports')::int = 0 and (hist->>'rejected')::int = 0 then
    sig := sig || jsonb_build_object('signal', 'consistent_history', 'points', pts->'consistent_history', 'source', 'database',
      'evidence', jsonb_build_object('published_before', hist->'published_before'));
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('media_id', m.id, 'distance_m', (m.analysis#>>'{exif,gps_distance_m}')::int)), '[]')
    into exif from app.listing_media m
   where m.listing_id = l.id and (m.analysis#>>'{exif,gps_distance_m}')::int >= v_far;
  if jsonb_array_length(exif) > 0 then
    sig := sig || jsonb_build_object('signal', 'exif_far_from_listing', 'points', pts->'exif_far_from_listing', 'source', 'media', 'evidence', exif);
  end if;
  select coalesce(jsonb_agg(i), '[]') into issues from jsonb_array_elements_text(coalesce(l.extraction->'issues', '[]')) i
   where i like 'photos_contradict%';
  if jsonb_array_length(issues) > 0 then
    sig := sig || jsonb_build_object('signal', 'inconsistent_details', 'points', pts->'inconsistent_details', 'source', 'analysis', 'evidence', issues);
  end if;
  -- a phone number, an e-mail address or a messaging handle in the text (12.2 "rules")
  v_contact := substring(coalesce(l.title, '') || ' ' || coalesce(l.description, '') from
    '(\+?[0-9][0-9 .-]{6,}[0-9]|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|[Ww]hats[Aa]pp|wa\.me/[0-9]+|[Tt]elegram|[Vv]iber|[Ss]ignal)');
  if v_contact is not null or coalesce(l.extraction->'issues', '[]') ? 'contact_details_in_text' then
    sig := sig || jsonb_build_object('signal', 'contact_off_platform', 'points', pts->'contact_off_platform', 'source', 'rules',
      'evidence', jsonb_build_object('quote', v_contact));
  end if;
  return jsonb_build_object(
    'listing', jsonb_build_object('listing_id', l.id, 'jurisdiction_code', l.jurisdiction_code, 'kind', l.kind, 'title', l.title,
      'description', l.description, 'rent_minor', l.rent_minor, 'rent_period', l.rent_period, 'rent_monthly_minor', l.rent_monthly_minor,
      'currency', l.currency, 'exponent', (select exponent from app.currencies where code = l.currency),
      'deposit_minor', l.deposit_minor, 'city', l.city, 'neighbourhood', l.neighbourhood, 'furnished', l.furnished,
      'photos', (select count(*) from app.listing_media where listing_id = l.id and kind = 'photo'),
      'issues', coalesce(l.extraction->'issues', '[]')),
    'duplicates', dups, 'benchmark', bench, 'owner_history', hist, 'exif_far', exif, 'signals', sig);
end $$;

-- 3. Score and verdict (12.2), in code: per signal the points the setting allows at most (a model cannot go past
--    them), one line per signal kind (the strongest), 100 plus the points, ok from 70, review from 40, block under 40
--    only with a hard signal (else review).
create or replace function app.trust_score(p_signals jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare pts jsonb := coalesce((select value from app.settings where key = 'trust.points'), '{}');
  hard jsonb := coalesce((select value from app.settings where key = 'trust.hard_signals'), '[]');
  kept jsonb; v_sum int; v_score int; v_hard boolean; v_verdict text;
begin
  with s as (
    select x->>'signal' as k, x,
           case when (pts->>(x->>'signal')) is null then null
                when (pts->>(x->>'signal'))::int < 0 then greatest((pts->>(x->>'signal'))::int, least(0, coalesce((x->>'points')::int, (pts->>(x->>'signal'))::int)))
                else least((pts->>(x->>'signal'))::int, greatest(0, coalesce((x->>'points')::int, (pts->>(x->>'signal'))::int))) end as p
      from jsonb_array_elements(coalesce(p_signals, '[]')) x
  ), best as (
    select distinct on (k) k, x || jsonb_build_object('points', p, 'hard', hard ? k) as x, p from s
     where p is not null order by k, abs(p) desc
  )
  select coalesce(jsonb_agg(x order by p, k), '[]'), coalesce(sum(p), 0), coalesce(bool_or(hard ? k), false) into kept, v_sum, v_hard from best;
  v_score := least(100, greatest(0, 100 + v_sum));
  v_verdict := case when v_score >= 70 then 'ok' when v_score >= 40 then 'review' when v_hard then 'block' else 'review' end;
  return jsonb_build_object('score', v_score, 'verdict', v_verdict, 'hard', v_hard, 'signals', kept,
    'flags', (select coalesce(jsonb_agg(distinct x->>'signal'), '[]') from jsonb_array_elements(kept) x where (x->>'points')::int = 0));
end $$;

-- 4. Store one check: the report, with the evidence; the listing's fields change only when the submit applies it.
create or replace function app.trust_store(p_listing uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare s jsonb := app.trust_score(p->'signals'); v_id uuid;
begin
  insert into app.trust_reports (listing_id, score, verdict, signals, explanation, prompt_version_id, model)
  values (p_listing, (s->>'score')::int, s->>'verdict', s->'signals', left(p->>'summary', 300),
          (p->>'prompt_version_id')::uuid, p->>'model')
  returning id into v_id;
  return s || jsonb_build_object('report_id', v_id, 'agent', p->'agent');
end $$;

-- 5. Submit with the trust check (D-107). The workflow calls app.listing_submit(user, id, null) first: the same checks
--    as P3 and, when the trust check is on, status 100 "run the check". Then app.listing_submit(user, id,
--    {report_id}) applies the report: ok publishes as P3 did (checked true); review keeps the listing out of the search
--    (pending_review) and queues it for a moderator; block rejects it with the signal codes. The /v1 answer keeps
--    its shapes: 200 published, or 409 with details [{field: trust, issue: in_review | rejected}].
alter function app.listing_submit(uuid, uuid) rename to listing_submit_direct;

create or replace function app.listing_submit_check(p_user uuid, p_listing uuid) returns jsonb
language plpgsql as $$
declare l app.listings; rd jsonb; v_job jsonb;
begin
  select * into l from app.listings where id = p_listing;
  if l.id is null or l.owner_id is distinct from p_user then
    return jsonb_build_object('status', 404, 'error', jsonb_build_object('code', 'NOT_FOUND', 'message', 'Listing not found', 'details', '[]'::jsonb));
  end if;
  if l.status = 'published' then return jsonb_build_object('status', 200, 'data', app.listing_submit_answer(l)); end if;
  if l.status <> 'draft' then
    return jsonb_build_object('status', 409, 'error', jsonb_build_object('code', 'CONFLICT', 'message', 'Listing is ' || l.status,
      'details', jsonb_build_array(jsonb_build_object('field', 'status', 'issue', 'status_not_allowed', 'current', l.status))));
  end if;
  v_job := app.listing_last_analysis(l.id);
  if v_job->>'status' in ('queued', 'running') then
    return jsonb_build_object('status', 409, 'error', jsonb_build_object('code', 'CONFLICT', 'message', 'The analysis is still running',
      'details', jsonb_build_array(jsonb_build_object('field', 'analysis', 'issue', 'running', 'job_id', v_job->'job_id'))));
  end if;
  rd := app.listing_readiness(l.id);
  if not (rd->>'ready')::boolean then
    return jsonb_build_object('status', 422, 'error', jsonb_build_object('code', 'VALIDATION_FAILED',
      'message', 'The listing is not complete', 'details', rd->'missing'));
  end if;
  return null;
end $$;

create or replace function app.listing_submit(p_user uuid, p_listing uuid, p_trust jsonb) returns jsonb
language plpgsql as $$
declare l app.listings; e jsonb; rep app.trust_reports; r jsonb; v_codes jsonb; v_prio int;
begin
  if coalesce((select value #>> '{}' from app.settings where key = 'trust.enabled'), 'true') <> 'true' then
    return app.listing_submit_direct(p_user, p_listing);
  end if;
  e := app.listing_submit_check(p_user, p_listing);
  if e is not null then return e; end if;
  if p_trust is null then return jsonb_build_object('status', 100, 'next', 'trust', 'listing_id', p_listing); end if;
  select * into rep from app.trust_reports
   where id = (p_trust->>'report_id')::uuid and listing_id = p_listing and created_at > now() - interval '30 minutes';
  if rep.id is null then
    return jsonb_build_object('status', 409, 'error', jsonb_build_object('code', 'CONFLICT', 'message', 'No trust check for this listing',
      'details', '[{"field": "trust", "issue": "missing"}]'::jsonb));
  end if;
  if rep.verdict = 'ok' then
    r := app.listing_submit_direct(p_user, p_listing);
    if (r->>'status')::int = 200 then
      update app.listings set trust_score = rep.score, trust_verdict = rep.verdict,
             extraction = jsonb_set(extraction, '{publication}', coalesce(extraction->'publication', '{}') ||
                            jsonb_build_object('checked', true, 'trust_report_id', rep.id))
       where id = p_listing returning * into l;
      r := jsonb_set(r, '{data}', app.listing_submit_answer(l));
    end if;
    return r;
  end if;
  select coalesce(jsonb_agg(x->>'signal' order by (x->>'points')::int), '[]') into v_codes
    from jsonb_array_elements(rep.signals) x where (x->>'points')::int < 0;
  update app.listings set status = case when rep.verdict = 'block' then 'rejected' else 'pending_review' end,
         trust_score = rep.score, trust_verdict = rep.verdict,
         extraction = coalesce(extraction, '{}') || jsonb_build_object('trust', jsonb_build_object('report_id', rep.id, 'at', now()))
   where id = p_listing returning * into l;
  insert into app.audit_log (actor_id, action, entity, entity_id, detail)
  values (p_user, 'listing_submitted', 'listing', l.id::text, jsonb_build_object('trust_verdict', rep.verdict, 'trust_score', rep.score));
  if rep.verdict = 'review' then
    v_prio := case when rep.score < 40 then 2 when rep.score < 55 then 3 else 4 end;
    insert into app.moderation_queue (entity_type, entity_id, reason, priority, evidence)
    values ('listing', l.id, 'trust_review', v_prio, jsonb_build_object('trust_report_id', rep.id, 'score', rep.score, 'signals', rep.signals));
    perform api.notify_emit(p_user, 'listing_in_review', jsonb_build_object('title', l.title), 'listing', l.id::text);
    return jsonb_build_object('status', 409, 'error', jsonb_build_object('code', 'CONFLICT', 'message', 'The listing will be checked by a moderator',
      'details', jsonb_build_array(jsonb_build_object('field', 'trust', 'issue', 'in_review', 'signals', v_codes))));
  end if;
  perform api.notify_emit(p_user, 'listing_rejected', jsonb_build_object('title', l.title, 'signals', v_codes), 'listing', l.id::text);
  return jsonb_build_object('status', 409, 'error', jsonb_build_object('code', 'CONFLICT', 'message', 'The listing was refused',
    'details', jsonb_build_array(jsonb_build_object('field', 'trust', 'issue', 'rejected', 'signals', v_codes))));
end $$;
-- two arguments: as before for callers that do not run the check (the trust check is then started by the caller)
create or replace function app.listing_submit(p_user uuid, p_listing uuid) returns jsonb
language sql as $$ select app.listing_submit(p_user, p_listing, null::jsonb) $$;
revoke execute on function app.listing_submit(uuid, uuid) from public;
grant execute on function app.listing_submit(uuid, uuid) to n8n_worker;

-- 6. Moderation queue (12.5): evidence, the report or message an item is about, and the decision.
alter table app.moderation_queue add column evidence jsonb not null default '{}', add column message_id bigint,
  add column reports int not null default 0, add column decision text;
create unique index moderation_open_once on app.moderation_queue (entity_type, entity_id, coalesce(message_id, 0))
  where status in ('open', 'in_review');

-- a report opens an item for its target, or raises the open one: scams and discrimination first, and one step up
-- for every other person who reports the same target (report triage, PLATFORM_SPEC 4)
create or replace function app.report_enqueue() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_type text; v_id uuid; v_q bigint; v_prio int;
begin
  v_type := case new.target_type when 'listing' then 'listing' when 'message' then 'message' else 'user' end;
  v_id := case new.target_type when 'listing' then new.listing_id else new.target_user_id end;
  if v_id is null then return new; end if;
  v_prio := case when new.reason in ('scam', 'discrimination') then 3 else 5 end;
  select id into v_q from app.moderation_queue
   where entity_type = v_type and entity_id = v_id and coalesce(message_id, 0) = coalesce(new.message_id, 0) and status in ('open', 'in_review');
  if v_q is null then
    insert into app.moderation_queue (entity_type, entity_id, message_id, reason, priority, reports, evidence)
    values (v_type, v_id, new.message_id, 'report_' || new.reason, v_prio, 1, jsonb_build_object('report_ids', jsonb_build_array(new.id)))
    returning id into v_q;
  else
    update app.moderation_queue q
       set reports = q.reports + 1,
           priority = greatest(1, least(q.priority, v_prio) - case when exists (select 1 from app.reports r where r.queue_id = q.id
                                                                         and r.reporter_id is distinct from new.reporter_id) then 1 else 0 end),
           evidence = jsonb_set(q.evidence, '{report_ids}', coalesce(q.evidence->'report_ids', '[]') || to_jsonb(new.id))
     where q.id = v_q;
  end if;
  update app.reports set queue_id = v_q where id = new.id;
  return new;
end $$;
create trigger trg_report_enqueue after insert on app.reports for each row execute function app.report_enqueue();
revoke execute on function app.report_enqueue() from public;

-- GET /v1/admin/moderation (moderator or admin): open items first by priority, with what they are about
create or replace function app.moderation_list(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare q jsonb := coalesce(p->'query', '{}'); v_status text := coalesce(q->>'status', 'open'); lim int := coalesce((q->>'limit')::int, 20);
  off int := coalesce((q->>'cursor')::int, 0); items jsonb; n int;
begin
  if not exists (select 1 from app.users where id = p_user and role in ('moderator', 'admin') and deleted_at is null) then
    return jsonb_build_object('status', 403, 'error', jsonb_build_object('code', 'FORBIDDEN', 'message', 'Staff only', 'details', '[]'::jsonb));
  end if;
  select coalesce(jsonb_agg(app._moderation_item(m) order by m.priority, m.created_at), '[]'), count(*) into items, n
    from (select * from app.moderation_queue
           where (v_status = 'all' or (v_status = 'open' and status in ('open', 'in_review')) or status = v_status)
           order by priority, created_at offset off limit lim) m;
  return jsonb_build_object('status', 200, 'data', jsonb_build_object('items', items),
    'meta', jsonb_build_object('next_cursor', case when n = lim then (off + lim)::text end));
end $$;

create or replace function app._moderation_item(m app.moderation_queue) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('item_id', m.id, 'entity_type', m.entity_type, 'entity_id', m.entity_id, 'message_id', m.message_id,
    'reason', m.reason, 'priority', m.priority, 'status', m.status, 'decision', m.decision, 'reports', m.reports,
    'created_at', m.created_at, 'decided_at', m.decided_at,
    'evidence', m.evidence - 'report_ids',
    'listing', case when m.entity_type = 'listing' then (select jsonb_build_object('listing_id', l.id, 'title', l.title, 'status', l.status,
        'description', l.description, 'rent_minor', l.rent_minor, 'currency', l.currency, 'city', l.city, 'trust_score', l.trust_score,
        'trust_verdict', l.trust_verdict, 'owner', jsonb_build_object('user_id', l.owner_id,
          'display_name', (select display_name from app.users where id = l.owner_id)))
       from app.listings l where l.id = m.entity_id) end,
    'message', case when m.message_id is not null then (select jsonb_build_object('id', x.id, 'body', x.body, 'hidden', x.hidden_by_moderation,
        'flags', x.flags, 'created_at', x.created_at) from social.messages x where x.id = m.message_id) end,
    'user', case when m.entity_type in ('user', 'message') then (select jsonb_build_object('user_id', u.id, 'display_name', u.display_name,
        'created_at', u.created_at) from app.users u where u.id = m.entity_id) end,
    'report_reasons', (select coalesce(jsonb_agg(jsonb_build_object('reason', r.reason, 'detail', r.detail, 'created_at', r.created_at)
        order by r.created_at), '[]') from app.reports r where r.queue_id = m.id),
    'actions', case when m.status not in ('open', 'in_review') then '[]'::jsonb
      when m.entity_type = 'listing' then '["approve", "reject", "dismiss"]'::jsonb
      when m.message_id is not null then '["hide_message", "dismiss"]'::jsonb
      else '["dismiss", "warn"]'::jsonb end)
$$;

-- POST /v1/admin/moderation/{id}/decision {action, note, code}: the decision, its effect, the audit log (12.5)
create or replace function app.moderation_decide(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare m app.moderation_queue; b jsonb := coalesce(p->'body', '{}'); v_act text := b->>'action'; l app.listings; v_effect text;
begin
  if not exists (select 1 from app.users where id = p_user and role in ('moderator', 'admin') and deleted_at is null) then
    return jsonb_build_object('status', 403, 'error', jsonb_build_object('code', 'FORBIDDEN', 'message', 'Staff only', 'details', '[]'::jsonb));
  end if;
  select * into m from app.moderation_queue where id = (p#>>'{params,id}')::bigint for update;
  if m.id is null then
    return jsonb_build_object('status', 404, 'error', jsonb_build_object('code', 'NOT_FOUND', 'message', 'Item not found', 'details', '[]'::jsonb));
  end if;
  if m.status not in ('open', 'in_review') then
    return jsonb_build_object('status', 409, 'error', jsonb_build_object('code', 'CONFLICT', 'message', 'Already decided',
      'details', jsonb_build_array(jsonb_build_object('field', 'status', 'issue', 'already_decided', 'current', m.status))));
  end if;
  if not (app._moderation_item(m)->'actions') ? v_act then
    return jsonb_build_object('status', 422, 'error', jsonb_build_object('code', 'VALIDATION_FAILED', 'message', 'Request is invalid',
      'details', jsonb_build_array(jsonb_build_object('field', 'action', 'issue', 'not_allowed', 'allowed', app._moderation_item(m)->'actions'))));
  end if;
  if m.entity_type = 'listing' and v_act in ('approve', 'reject') then
    select * into l from app.listings where id = m.entity_id for update;
    if v_act = 'approve' then
      update app.listings set status = 'published', published_at = coalesce(published_at, now()), trust_verdict = 'ok',
             extraction = coalesce(extraction, '{}') || jsonb_build_object('publication', coalesce(extraction->'publication', '{}') ||
                            jsonb_build_object('published', true, 'checked', true, 'mode', 'moderator', 'at', now()))
       where id = l.id and status in ('pending_review', 'published', 'rejected') returning * into l;
      perform api.notify_emit(l.owner_id, 'listing_published', jsonb_build_object('title', l.title), 'listing', l.id::text);
      v_effect := 'published';
    else
      update app.listings set status = 'rejected', trust_verdict = 'block' where id = l.id returning * into l;
      perform api.notify_emit(l.owner_id, 'listing_rejected', jsonb_build_object('title', l.title, 'code', coalesce(b->>'code', 'moderator')),
                              'listing', l.id::text);
      v_effect := 'rejected';
    end if;
  elsif v_act = 'hide_message' then
    update social.messages set hidden_by_moderation = true where id = m.message_id;
    v_effect := 'message_hidden';
  elsif v_act = 'warn' then
    perform api.notify_emit(m.entity_id, 'moderation_warning', jsonb_build_object('code', coalesce(b->>'code', 'other')), null, null);
    v_effect := 'warned';
  else
    v_effect := 'none';
  end if;
  update app.moderation_queue set status = case when v_act in ('approve', 'dismiss') then 'approved' else 'rejected' end,
         decision = v_act, decision_note = nullif(btrim(coalesce(b->>'note', '')), ''), assigned_to = p_user, decided_at = now()
   where id = m.id returning * into m;
  update app.reports set status = 'closed' where queue_id = m.id;
  insert into app.audit_log (actor_id, action, entity, entity_id, detail)
  values (p_user, 'moderation_decision', m.entity_type, coalesce(m.message_id::text, m.entity_id::text),
          jsonb_build_object('item_id', m.id, 'decision', v_act, 'note', m.decision_note, 'code', b->>'code', 'effect', v_effect, 'reason', m.reason));
  return jsonb_build_object('status', 200, 'data', app._moderation_item(m) || jsonb_build_object('effect', v_effect));
end $$;

-- 7. Warnings on messages (rule 2.7: phrase rules, no model). The workflow scans the text and passes the codes; they
--    are stored on the message and shown to the person who receives it.
create or replace function api.message_send(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; r jsonb; v_codes jsonb := coalesce(p->'scan', '[]');
begin
  perform api._as(p_user);
  if not exists (select 1 from social.conversations where id = v_id) then return api._err(404, 'NOT_FOUND', 'Conversation not found'); end if;
  r := api._message_insert(p_user, v_id, btrim(coalesce(p#>>'{body,text}', '')));
  if (r->>'status')::int = 201 and jsonb_typeof(v_codes) = 'array' and jsonb_array_length(v_codes) > 0 then
    perform social.flag_message((r#>>'{data,id}')::bigint, p_user, v_codes);
  end if;
  return r;
end $$;
create or replace function social.flag_message(p_id bigint, p_user uuid, p_codes jsonb) returns void
language sql security definer set search_path = pg_catalog, pg_temp as $$
  update social.messages set flags = (select coalesce(jsonb_agg(distinct x), '[]') from jsonb_array_elements(flags || p_codes) x
                                       where jsonb_typeof(x) = 'string' and x #>> '{}' ~ '^[a-z_]{3,40}$')
   where id = p_id and sender_id = p_user
$$;
revoke execute on function social.flag_message(bigint, uuid, jsonb) from public;
grant execute on function social.flag_message(bigint, uuid, jsonb) to app_rls;

-- the warnings stored on a message are shown to the person who receives it (not to its sender)
create or replace function api.messages_list(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; q jsonb := coalesce(p->'query', '{}'); lim int := coalesce((q->>'limit')::int, 30);
  items jsonb;
begin
  perform api._as(p_user);
  if not exists (select 1 from social.conversations where id = v_id) then return api._err(404, 'NOT_FOUND', 'Conversation not found'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'mine', x.sender_id = p_user, 'sender_id', x.sender_id,
           'body', case when x.deleted_at is not null or x.hidden_by_moderation then null else x.body end,
           'deleted', x.deleted_at is not null, 'hidden', x.hidden_by_moderation, 'created_at', x.created_at)
           || jsonb_build_object('warnings', case when x.sender_id is distinct from p_user then x.flags else '[]'::jsonb end) order by x.id desc), '[]')
    into items
    from (select * from social.messages where conversation_id = v_id and (q->>'before' is null or id < (q->>'before')::bigint)
           order by id desc limit lim + 1) x;
  return api._ok(jsonb_build_object('conversation', api._conversation(v_id),
    'items', case when jsonb_array_length(items) > lim then items - lim else items end,
    'next_before', case when jsonb_array_length(items) > lim then items->(lim - 1)->'id' else 'null'::jsonb end));
end $$;

-- 8. Badges (3.10): each one names what was checked. No table: each is read from what is stored, so it is never stale.
--    email_confirmed: an account from the website, which signs in only with a confirmed address (D-098);
--    telegram_linked: the bot knows the account; photos_checked: a published listing whose last trust check passed
--    and found no photo of another owner.
create or replace function app.user_badges(p_user uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', b) order by b), '[]') from (
    select 'email_confirmed' as b from app.users where id = p_user and external_auth_id like 'web:%' and email is not null
    union all select 'telegram_linked' from app.users where id = p_user and telegram_chat_id is not null
    union all select 'photos_checked' where exists (
      select 1 from app.listings l where l.owner_id = p_user and l.status = 'published' and l.trust_verdict = 'ok'
         and (l.extraction#>>'{publication,checked}')::boolean
         and not exists (select 1 from app.trust_reports t where t.listing_id = l.id
                          and t.created_at = (select max(created_at) from app.trust_reports where listing_id = l.id)
                          and t.signals @> '[{"signal": "duplicate_photo_other_owner"}]'))) x
$$;
revoke execute on function app.user_badges(uuid) from public;
grant execute on function app.user_badges(uuid) to app_rls, n8n_worker;

do $$
declare src text;
begin
  -- GET /v1/me: badges filled (the field exists since P1, empty until now)
  select pg_get_functiondef('api.me(uuid)'::regprocedure) into src;
  src := replace(src, '''badges'', ''[]''::jsonb,', '''badges'', app.user_badges(p_user),');
  if position('app.user_badges(p_user)' in src) = 0 then raise exception 'api.me: badges line not found'; end if;
  execute src;
end $$;

-- the trust check's tools and the workflow
revoke execute on function app.refresh_price_benchmarks(), app.price_benchmark_for(uuid), app.trust_facts(uuid), app.trust_score(jsonb),
  app.trust_store(uuid, jsonb), app.listing_submit_check(uuid, uuid), app.listing_submit(uuid, uuid, jsonb),
  app.moderation_list(uuid, jsonb), app._moderation_item(app.moderation_queue), app.moderation_decide(uuid, jsonb) from public;
grant execute on function app.refresh_price_benchmarks(), app.price_benchmark_for(uuid), app.trust_facts(uuid), app.trust_score(jsonb),
  app.trust_store(uuid, jsonb), app.listing_submit_check(uuid, uuid), app.listing_submit(uuid, uuid, jsonb),
  app.moderation_list(uuid, jsonb), app._moderation_item(app.moderation_queue), app.moderation_decide(uuid, jsonb) to n8n_worker;
select app.refresh_price_benchmarks();

-- migrate:down
do $$
declare src text;
begin
  select pg_get_functiondef('api.me(uuid)'::regprocedure) into src;
  execute replace(src, '''badges'', app.user_badges(p_user),', '''badges'', ''[]''::jsonb,');
end $$;
drop function if exists app.user_badges(uuid);
create or replace function api.message_send(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid;
begin
  perform api._as(p_user);
  if not exists (select 1 from social.conversations where id = v_id) then return api._err(404, 'NOT_FOUND', 'Conversation not found'); end if;
  return api._message_insert(p_user, v_id, btrim(coalesce(p#>>'{body,text}', '')));
end $$;
create or replace function api.messages_list(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; q jsonb := coalesce(p->'query', '{}'); lim int := coalesce((q->>'limit')::int, 30);
  items jsonb;
begin
  perform api._as(p_user);
  if not exists (select 1 from social.conversations where id = v_id) then return api._err(404, 'NOT_FOUND', 'Conversation not found'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'mine', x.sender_id = p_user, 'sender_id', x.sender_id,
           'body', case when x.deleted_at is not null or x.hidden_by_moderation then null else x.body end,
           'deleted', x.deleted_at is not null, 'hidden', x.hidden_by_moderation, 'created_at', x.created_at)
            order by x.id desc), '[]')
    into items
    from (select * from social.messages where conversation_id = v_id and (q->>'before' is null or id < (q->>'before')::bigint)
           order by id desc limit lim + 1) x;
  return api._ok(jsonb_build_object('conversation', api._conversation(v_id),
    'items', case when jsonb_array_length(items) > lim then items - lim else items end,
    'next_before', case when jsonb_array_length(items) > lim then items->(lim - 1)->'id' else 'null'::jsonb end));
end $$;
drop function if exists social.flag_message(bigint, uuid, jsonb);
drop function if exists app.moderation_decide(uuid, jsonb), app.moderation_list(uuid, jsonb), app._moderation_item(app.moderation_queue);
drop trigger if exists trg_report_enqueue on app.reports;
drop function if exists app.report_enqueue();
update app.reports set queue_id = null;
delete from app.moderation_queue where reason like 'report_%' or reason = 'trust_review';
drop index if exists app.moderation_open_once;
alter table app.moderation_queue drop column evidence, drop column message_id, drop column reports, drop column decision;
drop function if exists app.listing_submit(uuid, uuid), app.listing_submit(uuid, uuid, jsonb), app.listing_submit_check(uuid, uuid);
alter function app.listing_submit_direct(uuid, uuid) rename to listing_submit;
drop function if exists app.trust_store(uuid, jsonb), app.trust_score(jsonb), app.trust_facts(uuid), app.price_benchmark_for(uuid),
  app.refresh_price_benchmarks();
drop table if exists app.price_benchmarks;
delete from app.settings where key in ('trust.enabled', 'trust.agent_enabled', 'trust.agent_max_iterations', 'trust.num_ctx', 'trust.points',
  'trust.hard_signals', 'trust.benchmark_min', 'trust.price_ratio', 'trust.exif_far_m', 'trust.new_account');
