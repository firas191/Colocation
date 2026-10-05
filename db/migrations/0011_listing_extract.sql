-- migrate:up
-- Phase 4.4: listing extraction (P3) and agent steps of job workers. docs/DECISIONS.md D-076, D-077.

-- 1. Settings ------------------------------------------------------------------
insert into app.settings (key, value, description) values
  ('listing.rent_range', '{"TND": [30, 10000], "EUR": [50, 10000], "GBP": [50, 10000]}',
     'Plausible monthly rent per currency, main units [min, max]; outside it the extracted rent is set to null with an issue (spec 9.4, D-076). Chosen to catch power-of-ten errors, not a market statistic')
on conflict (key) do nothing;

-- 2. Rent scope (spec 9.4 P3 rent.scope): what the stored rent covers --------------
alter table app.listings
  add column rent_scope text check (rent_scope in ('per_room', 'per_person', 'whole_flat', 'unknown'));
grant select (rent_scope) on app.listings to api_user;

-- 3. The extraction context gives the rent ranges to the extractor and its evaluation -------
create or replace function app.extraction_context(p_jurisdiction text) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'jurisdiction', j.code, 'default_currency', j.default_currency, 'languages', to_jsonb(j.languages),
    'timezone', j.timezone,
    'allowed_preference_filters', coalesce(j.rules->'allowed_preference_filters',
       (select value from app.settings where key = 'profile.default_preference_filters')),
    'currencies', (select jsonb_object_agg(code, exponent) from app.currencies),
    'rent_ranges', coalesce((select value from app.settings where key = 'listing.rent_range'), '{}'::jsonb))
  from app.jurisdictions j where j.code = p_jurisdiction
$$;

-- 4. Store the result of wf.listing.extract. p: {fields: {kind, rent_minor, currency, rent_period, rent_scope,
--    deposit_minor, bills_included, available_from, bedrooms, furnished, amenities, house_rules, city,
--    neighbourhood}, description_lang, extraction: {...}}. Until owners can edit fields, the extraction is
--    the only writer of these columns and a new analysis replaces them (D-077). The listing must be a draft
--    or under processing; the exact address stays inside extraction (never a public column).
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

-- 4b. Agent steps of a job worker (spec 8.3, 9.1: every model call is traced with its prompt version).
--     One ai.executions row per call of this function, request_id = the job id, channel 'job'.
create or replace function app.record_job_steps(p_job uuid, p_workflow text, p_n8n_execution text, p_steps jsonb)
returns uuid
language plpgsql as $$
declare v_exec uuid; v_err text;
begin
  select string_agg(s->>'error', ' | ') into v_err from jsonb_array_elements(coalesce(p_steps, '[]')) s where s->>'error' is not null;
  insert into ai.executions (request_id, workflow, n8n_execution_id, channel, status, started_at, finished_at, latency_ms,
                             error, tokens_in, tokens_out)
  values (p_job, p_workflow, p_n8n_execution, 'job', case when v_err is null then 'succeeded' else 'failed' end,
          clock_timestamp() - make_interval(secs => coalesce((select sum((s->>'latency_ms')::numeric) from jsonb_array_elements(coalesce(p_steps, '[]')) s), 0) / 1000.0),
          clock_timestamp(), (select sum((s->>'latency_ms')::int) from jsonb_array_elements(coalesce(p_steps, '[]')) s),
          left(v_err, 1000),
          coalesce((select sum((s->>'tokens_in')::int) from jsonb_array_elements(coalesce(p_steps, '[]')) s), 0),
          coalesce((select sum((s->>'tokens_out')::int) from jsonb_array_elements(coalesce(p_steps, '[]')) s), 0))
  returning id into v_exec;
  insert into ai.agent_steps (execution_id, step_index, agent, prompt_version_id, model, input, output,
                              tool_calls, latency_ms, tokens_in, tokens_out, error)
  select v_exec, (ord - 1)::int, s->>'agent', app.try_uuid(s->>'prompt_version_id'), s->>'model',
         s->'input', s->'output', coalesce(s->'tool_calls', '[]'::jsonb), (s->>'latency_ms')::int,
         coalesce((s->>'tokens_in')::int, 0), coalesce((s->>'tokens_out')::int, 0), s->>'error'
  from jsonb_array_elements(coalesce(p_steps, '[]'::jsonb)) with ordinality x(s, ord);
  return v_exec;
end $$;

-- 5. The owner's view shows the rent scope --------------------------------------
create or replace function app.listing_owner_view(p_user uuid, p_listing uuid) returns jsonb
language sql stable as $$
  select case when l.id is null or l.owner_id is distinct from p_user then null else jsonb_build_object(
    'listing_id', l.id, 'status', l.status, 'jurisdiction_code', l.jurisdiction_code, 'kind', l.kind,
    'title', l.title, 'description', l.description, 'rent_minor', l.rent_minor, 'currency', l.currency,
    'rent_period', l.rent_period, 'rent_scope', l.rent_scope, 'deposit_minor', l.deposit_minor, 'bills_included', l.bills_included,
    'available_from', l.available_from, 'bedrooms', l.bedrooms, 'furnished', l.furnished, 'amenities', l.amenities,
    'house_rules', l.house_rules, 'city', l.city, 'neighbourhood', l.neighbourhood, 'extraction', l.extraction,
    'created_at', l.created_at, 'updated_at', l.updated_at,
    'media', coalesce((select jsonb_agg(jsonb_build_object('media_id', m.id, 'kind', m.kind, 'width', m.width, 'height', m.height,
                                                          'bytes', m.bytes, 'moderation', m.moderation, 'analysis', m.analysis,
                                                          'transcript', m.transcript, 'transcript_lang', m.transcript_lang,
                                                          'created_at', m.created_at) order by m.created_at)
                       from app.listing_media m where m.listing_id = l.id), '[]'::jsonb),
    'uploads', coalesce((select jsonb_agg(jsonb_build_object('upload_id', u.id, 'kind', u.kind, 'status', u.status,
                                                            'error_code', u.error_code, 'media_id', u.media_id) order by u.created_at)
                         from app.media_uploads u where u.listing_id = l.id and u.status <> 'processed'), '[]'::jsonb))
  end
  from (select p_listing as id) k left join app.listings l on l.id = k.id
$$;

-- 6. Grants (n8n only; PUBLIC loses the default EXECUTE, D-013) --------------------
revoke execute on function app.store_listing_extraction(uuid, jsonb), app.record_job_steps(uuid, text, text, jsonb) from public;
grant execute on function app.store_listing_extraction(uuid, jsonb), app.record_job_steps(uuid, text, text, jsonb) to n8n_worker;

-- migrate:down
create or replace function app.listing_owner_view(p_user uuid, p_listing uuid) returns jsonb
language sql stable as $$
  select case when l.id is null or l.owner_id is distinct from p_user then null else jsonb_build_object(
    'listing_id', l.id, 'status', l.status, 'jurisdiction_code', l.jurisdiction_code, 'kind', l.kind,
    'title', l.title, 'description', l.description, 'rent_minor', l.rent_minor, 'currency', l.currency,
    'rent_period', l.rent_period, 'deposit_minor', l.deposit_minor, 'bills_included', l.bills_included,
    'available_from', l.available_from, 'bedrooms', l.bedrooms, 'furnished', l.furnished, 'amenities', l.amenities,
    'house_rules', l.house_rules, 'city', l.city, 'neighbourhood', l.neighbourhood, 'extraction', l.extraction,
    'created_at', l.created_at, 'updated_at', l.updated_at,
    'media', coalesce((select jsonb_agg(jsonb_build_object('media_id', m.id, 'kind', m.kind, 'width', m.width, 'height', m.height,
                                                          'bytes', m.bytes, 'moderation', m.moderation, 'analysis', m.analysis,
                                                          'transcript', m.transcript, 'transcript_lang', m.transcript_lang,
                                                          'created_at', m.created_at) order by m.created_at)
                       from app.listing_media m where m.listing_id = l.id), '[]'::jsonb),
    'uploads', coalesce((select jsonb_agg(jsonb_build_object('upload_id', u.id, 'kind', u.kind, 'status', u.status,
                                                            'error_code', u.error_code, 'media_id', u.media_id) order by u.created_at)
                         from app.media_uploads u where u.listing_id = l.id and u.status <> 'processed'), '[]'::jsonb))
  end
  from (select p_listing as id) k left join app.listings l on l.id = k.id
$$;

drop function if exists app.record_job_steps(uuid, text, text, jsonb);
drop function if exists app.store_listing_extraction(uuid, jsonb);
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

alter table app.listings drop column if exists rent_scope;
delete from app.settings where key = 'listing.rent_range';
