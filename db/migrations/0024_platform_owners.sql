-- migrate:up
-- Platform phase P3 (docs/PLATFORM_SPEC.md 3.5, 9 P3; DECISIONS D-102): owners post, check, publish and manage their
-- listings from the website.
--   * app.listing_readiness: what a draft still needs before it can be published, and which analysis issues still
--     apply after the owner's corrections.
--   * app.listing_submit: POST /v1/listings/{id}/submit. Checks, then publishes (the trust check replaces the
--     direct publication in P8).
--   * app.me_listings: GET /v1/me/listings, the owner's listings with what each still needs and what can be done.
--   * app.store_listing_extraction: a new analysis no longer overwrites a field the owner changed (open point of
--     D-077), and keeps the owner's change history and the publication record.
-- app.listings is a table from before the platform (n8n_worker reads it); the functions check the owner themselves
-- and answer 404 for anyone else's listing (PLATFORM_SPEC rule 2.5). They return {status, data} or {status, error}
-- like the api.* functions.

-- 1. Fields the owner changed (PATCH or a confirmed proposal), as stored columns. extraction.owner_changes holds
--    [{at, diff: [{field, before, after}]}] (app.listing_apply_changes, migration 0019).
create or replace function app.listing_owner_columns(p_extraction jsonb) returns text[]
language sql immutable as $$
  select coalesce(array_agg(distinct c), '{}') from (
    select unnest(case d->>'field'
      when 'rent' then array['rent_minor', 'currency']
      when 'deposit' then array['deposit_minor', 'currency']
      when 'place' then array['city', 'neighbourhood']
      else array[d->>'field'] end) as c
      from jsonb_array_elements(coalesce(p_extraction->'owner_changes', '[]'::jsonb)) oc,
           jsonb_array_elements(coalesce(oc->'diff', '[]'::jsonb)) d) x
$$;

-- 2. The extraction keeps what the owner changed (D-077's open point, D-102). Same rules as before otherwise.
create or replace function app.store_listing_extraction(p_listing uuid, p jsonb) returns jsonb
language plpgsql as $$
declare l app.listings; f jsonb := coalesce(p->'fields', '{}'::jsonb); o text[];
begin
  select * into l from app.listings where id = p_listing for update;
  if l.id is null then
    return jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND');
  end if;
  if l.status not in ('draft', 'processing', 'pending_review') then
    return jsonb_build_object('ok', false, 'error_code', 'CONFLICT', 'message', 'listing is ' || l.status);
  end if;
  if f->>'currency' is not null and not exists (select 1 from app.currencies where code = f->>'currency') then
    return jsonb_build_object('ok', false, 'error_code', 'VALIDATION_FAILED', 'field', 'currency');
  end if;
  o := app.listing_owner_columns(l.extraction);
  update app.listings set
    kind            = coalesce(f->>'kind', kind),
    rent_minor      = case when 'rent_minor' = any(o) then rent_minor else (f->>'rent_minor')::bigint end,
    currency        = case when 'currency' = any(o) then currency else f->>'currency' end,
    rent_period     = case when 'rent_period' = any(o) or 'rent_minor' = any(o) then rent_period else coalesce(f->>'rent_period', 'month') end,
    rent_scope      = case when 'rent_minor' = any(o) then rent_scope else f->>'rent_scope' end,
    deposit_minor   = case when 'deposit_minor' = any(o) then deposit_minor else (f->>'deposit_minor')::bigint end,
    bills_included  = case when 'bills_included' = any(o) then bills_included else (f->>'bills_included')::boolean end,
    available_from  = case when 'available_from' = any(o) then available_from else (f->>'available_from')::date end,
    bedrooms        = case when 'bedrooms' = any(o) then bedrooms else (f->>'bedrooms')::smallint end,
    furnished       = case when 'furnished' = any(o) then furnished else (f->>'furnished')::boolean end,
    amenities       = case when 'amenities' = any(o) then amenities
                           else coalesce((select array_agg(x order by x) from jsonb_array_elements_text(f->'amenities') x), '{}') end,
    house_rules     = case when 'house_rules' = any(o) then house_rules else coalesce(f->'house_rules', '{}'::jsonb) end,
    city            = case when 'city' = any(o) then city else f->>'city' end,
    neighbourhood   = case when 'neighbourhood' = any(o) then neighbourhood else f->>'neighbourhood' end,
    description_lang = coalesce(p->>'description_lang', description_lang),
    -- the new analysis replaces the old one; the owner's changes and the publication record stay
    extraction      = coalesce(p->'extraction', '{}'::jsonb)
                      || jsonb_strip_nulls(jsonb_build_object('owner_changes', l.extraction->'owner_changes',
                                                              'publication', l.extraction->'publication'))
                      || jsonb_build_object('stored_at', now(), 'kept_owner_fields', to_jsonb(o)),
    updated_at      = now()
  where id = p_listing;
  return jsonb_build_object('ok', true, 'listing_id', p_listing, 'kept_owner_fields', to_jsonb(o));
end $$;

-- 3. What a listing still needs before publication, and the analysis issues that still apply.
--    missing (blocks submit): rent, place (found on the map), at least one photo that was not rejected.
--    issues (shown, do not block): the analysis issues that still apply. An issue goes away once the owner has set
--    the field it is about themselves (rent: scope, assumed currency, unknown range; deposit; date; furnished and
--    amenities against the photos), and the rent issues once there is a rent.
create or replace function app.listing_readiness(p_listing uuid) returns jsonb
language plpgsql stable as $$
declare l app.listings; v_missing jsonb := '[]'; g jsonb; o text[]; v_issues jsonb; v_photos int;
begin
  select * into l from app.listings where id = p_listing;
  if l.id is null then return null; end if;
  o := app.listing_owner_columns(l.extraction);
  if l.rent_minor is null or l.currency is null then
    v_missing := v_missing || jsonb_build_object('field', 'rent', 'issue', 'required');
  end if;
  if l.location is null then
    if l.neighbourhood is not null then g := app.geocode(l.neighbourhood, l.jurisdiction_code); end if;
    if (g is null or g->>'status' <> 'found') and l.city is not null then g := app.geocode(l.city, l.jurisdiction_code); end if;
    if g is null or g->>'status' <> 'found' then
      v_missing := v_missing || jsonb_build_object('field', 'place',
        'issue', case when l.city is null and l.neighbourhood is null then 'required' else 'place_not_found' end);
    end if;
  end if;
  select count(*) into v_photos from app.listing_media m where m.listing_id = l.id and m.kind = 'photo' and m.moderation <> 'rejected';
  if v_photos = 0 then
    v_missing := v_missing || jsonb_build_object('field', 'photos', 'issue', 'required');
  end if;
  select coalesce(jsonb_agg(i), '[]') into v_issues
    from jsonb_array_elements_text(coalesce(l.extraction->'issues', '[]'::jsonb)) i
   where not (l.rent_minor is not null and i in ('rent_missing', 'rent_out_of_range', 'rent_currency_unknown'))
     and not ('rent_minor' = any(o) and (i like 'rent_scope_%' or i in ('rent_currency_assumed', 'rent_range_unknown')))
     and not ('deposit_minor' = any(o) and i in ('deposit_currency_differs', 'deposit_out_of_range'))
     and not ('available_from' = any(o) and i = 'available_from_not_in_text')
     and not ('furnished' = any(o) and i = 'photos_contradict_furnished')
     and not ('amenities' = any(o) and i = 'photos_show_amenities_not_in_text');
  return jsonb_build_object('ready', jsonb_array_length(v_missing) = 0, 'missing', v_missing, 'issues', v_issues,
                            'photos', v_photos);
end $$;

-- The latest analysis job of a listing (the website shows its progress).
create or replace function app.listing_last_analysis(p_listing uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object('job_id', j.id, 'status', j.status, 'created_at', j.created_at, 'finished_at', j.finished_at)
    from app.jobs j
   where j.type = 'listing_analyze' and j.input->>'listing_id' = p_listing::text
   order by j.created_at desc limit 1
$$;

-- 4. POST /v1/listings/{id}/submit. Only a draft is submitted; submitting a published listing again gives the same
--    answer; an archived one is published again with PATCH status (D-088). From P8 the trust job replaces the direct
--    publication (PLATFORM_SPEC 3.5).
create or replace function app.listing_submit_answer(l app.listings) returns jsonb
language sql stable as $$
  select jsonb_build_object('listing_id', l.id, 'status', l.status, 'title', l.title, 'published_at', l.published_at,
                            'place', l.extraction#>'{publication,place}',
                            'checked', coalesce((l.extraction#>>'{publication,checked}')::boolean, false))
$$;

create or replace function app.listing_submit(p_user uuid, p_listing uuid) returns jsonb
language plpgsql as $$
declare l app.listings; rd jsonb; g jsonb; v_job jsonb; v_first text; v_title text; v_pub jsonb; v_loc geography;
begin
  select * into l from app.listings where id = p_listing for update;
  if l.id is null or l.owner_id is distinct from p_user then
    return jsonb_build_object('status', 404, 'error', jsonb_build_object('code', 'NOT_FOUND', 'message', 'Listing not found', 'details', '[]'::jsonb));
  end if;
  if l.status = 'published' then
    return jsonb_build_object('status', 200, 'data', app.listing_submit_answer(l));
  end if;
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
  v_loc := l.location;
  if v_loc is null then
    if l.neighbourhood is not null then g := app.geocode(l.neighbourhood, l.jurisdiction_code); end if;
    if (g is null or g->>'status' <> 'found') and l.city is not null then g := app.geocode(l.city, l.jurisdiction_code); end if;
    v_loc := public.st_setsrid(public.st_makepoint((g#>>'{place,lng}')::float, (g#>>'{place,lat}')::float), 4326)::geography;
  end if;
  v_first := btrim(split_part(coalesce(l.description, ''), E'\n', 1));
  v_title := coalesce(l.title, case when char_length(v_first) <= 80 then v_first
                                    else regexp_replace(left(v_first, 80), '\s+\S*$', '') || '…' end);
  v_pub := jsonb_build_object('mode', 'owner', 'published', true, 'checked', false, 'at', now(),
                              'place', coalesce(g#>'{place,name}', to_jsonb(coalesce(l.neighbourhood, l.city))),
                              'place_key', g#>'{place,place_key}', 'issues_at_submit', rd->'issues');
  update app.listings
     set status = 'published', published_at = coalesce(published_at, now()), title = v_title, location = v_loc,
         extraction = coalesce(extraction, '{}'::jsonb) || jsonb_build_object('publication', v_pub)
   where id = l.id returning * into l;
  insert into app.audit_log (actor_id, action, entity, entity_id) values (p_user, 'listing_submitted', 'listing', l.id::text);
  perform api.notify_emit(p_user, 'listing_published', jsonb_build_object('title', l.title), 'listing', l.id::text);
  return jsonb_build_object('status', 200, 'data', app.listing_submit_answer(l),
    'embed_text', concat_ws(E'\n', l.title, l.description, nullif(concat_ws(', ', l.neighbourhood, l.city), '')),
    'embed', (select jsonb_object_agg(key, value #>> '{}') from app.settings
               where key in ('ollama.base_url', 'ollama.embed_model', 'llm.keep_alive')));
end $$;

-- 5. GET /v1/me/listings: the owner's listings, newest first, with what each needs and which actions apply.
--    number: the listing's number for the owner assistant ("annonce 2"), the same order as app.owner_listings
--    (newest first, rejected ones left out, first 10). Cover photo: the first processed photo's key, which the
--    workflow turns into a signed URL and drops. Paging: cursor "<created_at in microseconds>_<id>".
create or replace function app.me_listings(p_user uuid, p jsonb) returns jsonb
language plpgsql stable as $$
declare
  q jsonb := coalesce(p->'query', '{}'::jsonb);
  lim int := least(greatest(coalesce((q->>'limit')::int, 20), 1), 50);
  v_status text := q->>'status';
  v_id uuid := (q->>'listing_id')::uuid;
  v_cur_t timestamptz; v_cur_id uuid; items jsonb; v_next text;
begin
  if q->>'cursor' is not null then
    v_cur_t := 'epoch'::timestamptz + split_part(q->>'cursor', '_', 1)::bigint * interval '1 microsecond';
    v_cur_id := split_part(q->>'cursor', '_', 2)::uuid;
  end if;
  with mine as (
    select l.*, case when l.status <> 'rejected' then row_number() over (partition by l.status = 'rejected'
                                                                        order by l.created_at desc, l.id) end as n
      from app.listings l where l.owner_id = p_user
  ), page as (
    select * from mine m
     where (v_status is null or m.status = v_status) and (v_id is null or m.id = v_id)
       and (v_cur_t is null or m.created_at < v_cur_t or (m.created_at = v_cur_t and m.id > v_cur_id))
     order by m.created_at desc, m.id limit lim + 1
  )
  select coalesce(jsonb_agg(x.item order by x.created_at desc, x.id), '[]') into items from (
    select pg.created_at, pg.id, jsonb_build_object(
      'listing_id', pg.id, 'status', pg.status, 'number', case when pg.n <= 10 then pg.n end,
      'kind', pg.kind, 'title', pg.title,
      'display_title', coalesce(pg.title, nullif(left(btrim(split_part(coalesce(pg.description, ''), E'\n', 1)), 80), '')),
      'jurisdiction_code', pg.jurisdiction_code,
      'rent', jsonb_build_object('amount_minor', pg.rent_minor, 'currency', pg.currency, 'period', coalesce(pg.rent_period, 'month'),
                                 'monthly_minor', pg.rent_monthly_minor,
                                 'exponent', (select c.exponent from app.currencies c where c.code = pg.currency)),
      'rent_scope', pg.rent_scope,
      'city', pg.city, 'neighbourhood', pg.neighbourhood,
      'created_at', pg.created_at, 'updated_at', pg.updated_at, 'published_at', pg.published_at,
      'analysis', app.listing_last_analysis(pg.id),
      'readiness', case when pg.status = 'draft' then app.listing_readiness(pg.id) end,
      'photo_count', (select count(*) from app.listing_media m where m.listing_id = pg.id and m.kind = 'photo' and m.moderation <> 'rejected'),
      'cover_key', (select m.storage_key from app.listing_media m where m.listing_id = pg.id and m.kind = 'photo'
                      and m.moderation <> 'rejected' order by m.created_at, m.id limit 1),
      'actions', jsonb_build_object(
        'edit', pg.status <> 'rejected',
        'analyze', pg.status in ('draft', 'processing', 'pending_review'),
        'submit', pg.status = 'draft' and coalesce((app.listing_readiness(pg.id)->>'ready')::boolean, false)
                  and coalesce(app.listing_last_analysis(pg.id)->>'status', '') not in ('queued', 'running'),
        'archive', pg.status in ('published', 'draft', 'pending_review'),
        'republish', pg.status = 'archived' and pg.published_at is not null,
        'view', pg.status = 'published')) as item
      from page pg) x;
  if jsonb_array_length(items) > lim then
    v_next := (select floor(extract(epoch from (e->>'created_at')::timestamptz) * 1e6)::bigint::text || '_' || (e->>'listing_id')
                 from (select items->(lim - 1) as e) z);
    items := items - lim;
  end if;
  return jsonb_build_object('status', 200,
    'data', jsonb_build_object('items', items,
      'counts', (select jsonb_build_object(
                   'all', count(*), 'draft', count(*) filter (where status = 'draft'),
                   'published', count(*) filter (where status = 'published'),
                   'archived', count(*) filter (where status = 'archived'))
                   from app.listings where owner_id = p_user)),
    'meta', jsonb_build_object('next_cursor', v_next));
end $$;

-- 6. Grants (n8n only; PUBLIC loses the default EXECUTE, D-013) --------------------
revoke execute on function app.listing_owner_columns(jsonb), app.listing_readiness(uuid), app.listing_last_analysis(uuid),
  app.listing_submit_answer(app.listings), app.listing_submit(uuid, uuid), app.me_listings(uuid, jsonb) from public;
grant execute on function app.listing_owner_columns(jsonb), app.listing_readiness(uuid), app.listing_last_analysis(uuid),
  app.listing_submit_answer(app.listings), app.listing_submit(uuid, uuid), app.me_listings(uuid, jsonb) to n8n_worker;

-- migrate:down
drop function if exists app.me_listings(uuid, jsonb);
drop function if exists app.listing_submit(uuid, uuid);
drop function if exists app.listing_submit_answer(app.listings);
drop function if exists app.listing_last_analysis(uuid);
drop function if exists app.listing_readiness(uuid);
-- app.store_listing_extraction goes back to its 0011 version
create or replace function app.store_listing_extraction(p_listing uuid, p jsonb) returns jsonb
language plpgsql as $$
declare l app.listings; f jsonb := coalesce(p->'fields', '{}'::jsonb);
begin
  select * into l from app.listings where id = p_listing for update;
  if l.id is null then
    return jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND');
  end if;
  if l.status not in ('draft', 'processing', 'pending_review') then
    return jsonb_build_object('ok', false, 'error_code', 'CONFLICT', 'message', 'listing is ' || l.status);
  end if;
  if f->>'currency' is not null and not exists (select 1 from app.currencies where code = f->>'currency') then
    return jsonb_build_object('ok', false, 'error_code', 'VALIDATION_FAILED', 'field', 'currency');
  end if;
  update app.listings set
    kind            = coalesce(f->>'kind', kind),
    rent_minor      = (f->>'rent_minor')::bigint,
    currency        = f->>'currency',
    rent_period     = coalesce(f->>'rent_period', 'month'),
    rent_scope      = f->>'rent_scope',
    deposit_minor   = (f->>'deposit_minor')::bigint,
    bills_included  = (f->>'bills_included')::boolean,
    available_from  = (f->>'available_from')::date,
    bedrooms        = (f->>'bedrooms')::smallint,
    furnished       = (f->>'furnished')::boolean,
    amenities       = coalesce((select array_agg(x order by x) from jsonb_array_elements_text(f->'amenities') x), '{}'),
    house_rules     = coalesce(f->'house_rules', '{}'::jsonb),
    city            = f->>'city',
    neighbourhood   = f->>'neighbourhood',
    description_lang = coalesce(p->>'description_lang', description_lang),
    extraction      = coalesce(p->'extraction', '{}'::jsonb) || jsonb_build_object('stored_at', now()),
    updated_at      = now()
  where id = p_listing;
  return jsonb_build_object('ok', true, 'listing_id', p_listing);
end $$;
drop function if exists app.listing_owner_columns(jsonb);
