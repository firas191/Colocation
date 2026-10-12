-- migrate:up
-- Owner assistant (D-088): an owner changes a listing by conversation ("le loyer passe à 400", "enlève la photo 2",
-- "c'est loué"). An n8n AI Agent node reads the owner's listings and PROPOSES a change; nothing is written until the
-- owner confirms (Telegram button, or PATCH /v1/listings/:id with the proposal's change_id). The changes are checked
-- and applied here, the same way for the agent's proposals and for PATCH /v1/listings/:id (spec 2.4 journey B step 6).

-- 1. Settings ----------------------------------------------------------------------------
insert into app.settings (key, value, description) values
  ('owner.agent_enabled',          'true', 'Changes to an owner''s listings by conversation with the owner assistant (post_listing messages of users who have listings)'),
  ('owner.agent_max_iterations',   '4',    'Most model turns of the owner assistant for one message (each tool call is one)'),
  ('owner.agent_memory_turns',     '4',    'Window of the owner assistant''s chat memory (2 x N stored messages)'),
  ('owner.agent_answer_max_chars', '400',  'Longest owner assistant answer shown'),
  ('owner.change_minutes',         '30',   'How long a proposed change can be confirmed')
on conflict (key) do nothing;

-- 2. The owner's listings as numbered in the conversation, and the proposed changes --------
create table ai.owner_sessions (
  session_id  text primary key,                 -- 'owner:user:<uuid>'
  user_id     uuid not null references app.users(id) on delete cascade,
  listings    jsonb not null default '[]',      -- listing ids in the order shown (number 1 first)
  updated_at  timestamptz not null default now()
);
grant select, insert, update, delete on ai.owner_sessions to n8n_worker;

create table ai.listing_changes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references app.users(id) on delete cascade,
  listing_id  uuid not null references app.listings(id) on delete cascade,
  request_id  uuid,
  changes     jsonb not null,                   -- PATCH /v1/listings/:id body shape, main units
  diff        jsonb not null,                   -- [{field, before, after}] as checked when proposed
  status      text not null default 'pending' check (status in ('pending', 'applied', 'cancelled', 'superseded', 'failed')),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);
create index on ai.listing_changes (user_id, created_at desc);
grant select, insert, update, delete on ai.listing_changes to n8n_worker;

-- 3. Check a change of a listing: owner, fields, types, ranges, place, amenities, photos, status.
--    Input: PATCH body {rent, rent_period, deposit, bills_included, furnished, available_from, bedrooms, min_stay_months,
--    place, amenities_add, amenities_remove, house_rules, remove_photos, status}, amounts in the currency's main unit.
--    Output: {ok, found, errors [{field, issue}], diff [{field, before, after}], set {column: value} (storage form)}.
create or replace function app.listing_change_check(p_user uuid, p_listing uuid, p jsonb) returns jsonb
language plpgsql stable as $$
declare
  l app.listings; v_cur text; v_exp int; v_range jsonb; v_err jsonb := '[]'; v_diff jsonb := '[]'; v_set jsonb := '{}';
  k text; v jsonb; n numeric; d date; g jsonb; a text; v_am text[]; v_rules jsonb; v_vocab text[] := array['wifi', 'washing_machine',
  'air_conditioning', 'heating', 'parking', 'balcony', 'terrace', 'garden', 'elevator', 'dishwasher', 'equipped_kitchen',
  'private_bathroom', 'desk', 'fridge', 'oven', 'microwave', 'tv', 'pool', 'gym', 'security', 'concierge'];
  v_photos jsonb; v_monthly numeric; v_period text;
begin
  select * into l from app.listings where id = p_listing;
  if l.id is null or l.owner_id is distinct from p_user then
    return jsonb_build_object('ok', false, 'found', false, 'errors', jsonb_build_array(jsonb_build_object('field', 'id', 'issue', 'not_found')));
  end if;
  if p is null or jsonb_typeof(p) <> 'object' or p = '{}'::jsonb then
    return jsonb_build_object('ok', false, 'found', true, 'errors', jsonb_build_array(jsonb_build_object('field', 'body', 'issue', 'no_change')));
  end if;
  v_cur := coalesce(l.currency, (select default_currency from app.jurisdictions where code = l.jurisdiction_code));
  v_exp := coalesce((select exponent from app.currencies where code = v_cur), 2);
  v_range := (select value -> v_cur from app.settings where key = 'listing.rent_range');
  v_am := l.amenities;
  v_rules := l.house_rules;

  for k, v in select * from jsonb_each(p) loop
    case k
    when 'rent', 'deposit' then
      if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric < 0 then
        v_err := v_err || jsonb_build_object('field', k, 'issue', 'invalid_number'); continue;
      end if;
      n := (v #>> '{}')::numeric;
      v_period := coalesce(p->>'rent_period', l.rent_period, 'month');
      v_monthly := case when k = 'rent' and v_period = 'week' then n * 52 / 12 else n end;
      if v_range is not null and not (k = 'deposit' and n = 0)
         and (v_monthly < (v_range->>0)::numeric or v_monthly > (v_range->>1)::numeric) then
        v_err := v_err || jsonb_build_object('field', k, 'issue', 'out_of_range', 'min', v_range->0, 'max', v_range->1, 'currency', v_cur);
        continue;
      end if;
      if k = 'rent' then
        v_set := v_set || jsonb_build_object('rent_minor', round(n * power(10::numeric, v_exp))::bigint, 'currency', v_cur);
        v_diff := v_diff || jsonb_build_object('field', 'rent', 'currency', v_cur,
          'before', case when l.rent_minor is null then null else l.rent_minor / power(10::numeric, v_exp) end, 'after', n);
      else
        v_set := v_set || jsonb_build_object('deposit_minor', round(n * power(10::numeric, v_exp))::bigint, 'currency', v_cur);
        v_diff := v_diff || jsonb_build_object('field', 'deposit', 'currency', v_cur,
          'before', case when l.deposit_minor is null then null else l.deposit_minor / power(10::numeric, v_exp) end, 'after', n);
      end if;
    when 'rent_period' then
      if v #>> '{}' not in ('month', 'week') then v_err := v_err || jsonb_build_object('field', k, 'issue', 'invalid_value'); continue; end if;
      v_set := v_set || jsonb_build_object('rent_period', v #>> '{}');
      v_diff := v_diff || jsonb_build_object('field', k, 'before', l.rent_period, 'after', v #>> '{}');
    when 'bills_included', 'furnished' then
      if jsonb_typeof(v) <> 'boolean' then v_err := v_err || jsonb_build_object('field', k, 'issue', 'invalid_boolean'); continue; end if;
      v_set := v_set || jsonb_build_object(k, v);
      v_diff := v_diff || jsonb_build_object('field', k, 'before', case k when 'furnished' then to_jsonb(l.furnished) else to_jsonb(l.bills_included) end,
                                             'after', v);
    when 'available_from' then
      begin d := (v #>> '{}')::date; exception when others then d := null; end;
      if d is null or d < current_date - 1 or d > current_date + 730 then
        v_err := v_err || jsonb_build_object('field', k, 'issue', 'invalid_date'); continue;
      end if;
      v_set := v_set || jsonb_build_object('available_from', d);
      v_diff := v_diff || jsonb_build_object('field', k, 'before', l.available_from, 'after', d);
    when 'bedrooms', 'min_stay_months' then
      if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric)
         or (v #>> '{}')::int < 0 or (v #>> '{}')::int > (case k when 'bedrooms' then 20 else 60 end) then
        v_err := v_err || jsonb_build_object('field', k, 'issue', 'invalid_number'); continue;
      end if;
      v_set := v_set || jsonb_build_object(k, (v #>> '{}')::int);
      v_diff := v_diff || jsonb_build_object('field', k, 'before', case k when 'bedrooms' then to_jsonb(l.bedrooms) else to_jsonb(l.min_stay_months) end,
                                             'after', (v #>> '{}')::int);
    when 'place' then
      g := case when jsonb_typeof(v) = 'string' and btrim(v #>> '{}') <> '' then app.geocode(v #>> '{}', l.jurisdiction_code) end;
      if g is null or g->>'status' <> 'found' then
        v_err := v_err || jsonb_build_object('field', k, 'issue', case when g->>'status' = 'ambiguous' then 'place_ambiguous' else 'place_not_found' end,
                                             'candidates', coalesce(jsonb_path_query_array(g->'candidates', '$[*].name'), '[]'));
        continue;
      end if;
      v_set := v_set || jsonb_build_object('neighbourhood', case when g#>>'{place,kind}' = 'neighbourhood' then g#>>'{place,name}' end,
                                           'city', coalesce(g#>>'{place,city}', case when g#>>'{place,kind}' <> 'neighbourhood' then g#>>'{place,name}' end),
                                           'lat', g#>'{place,lat}', 'lng', g#>'{place,lng}');
      v_diff := v_diff || jsonb_build_object('field', 'place', 'before', nullif(concat_ws(', ', l.neighbourhood, l.city), ''),
                                             'after', concat_ws(', ', case when g#>>'{place,kind}' = 'neighbourhood' then g#>>'{place,name}' end,
                                                                coalesce(g#>>'{place,city}', g#>>'{place,name}')));
    when 'amenities_add', 'amenities_remove' then
      if jsonb_typeof(v) <> 'array' then v_err := v_err || jsonb_build_object('field', k, 'issue', 'invalid_list'); continue; end if;
      for a in select jsonb_array_elements_text(v) loop
        if not a = any(v_vocab) then v_err := v_err || jsonb_build_object('field', k, 'issue', 'unknown_amenity', 'value', a); continue; end if;
        if k = 'amenities_add' then v_am := array(select distinct x from unnest(v_am || a) x order by x);
        else v_am := array_remove(v_am, a); end if;
      end loop;
    when 'house_rules' then
      if jsonb_typeof(v) <> 'object' or exists (select 1 from jsonb_each(v) e where e.key not in ('smoking', 'pets', 'guests', 'parties')
                                                  or e.value #>> '{}' not in ('yes', 'no')) then
        v_err := v_err || jsonb_build_object('field', k, 'issue', 'invalid_rules'); continue;
      end if;
      v_rules := v_rules || v;
    when 'remove_photos' then
      v_photos := (select coalesce(jsonb_agg(jsonb_build_object('n', x.n, 'media_id', x.id, 'key', x.storage_key)), '[]') from (
                     select row_number() over (order by m.created_at, m.id) as n, m.id, m.storage_key from app.listing_media m
                      where m.listing_id = l.id and m.kind = 'photo' and m.moderation <> 'rejected') x
                    where jsonb_typeof(v) = 'array' and x.n in (select (e #>> '{}')::int from jsonb_array_elements(v) e
                                                                 where jsonb_typeof(e) = 'number'));
      if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) = 0 or jsonb_array_length(v_photos) <> (select count(distinct e) from jsonb_array_elements(v) e) then
        v_err := v_err || jsonb_build_object('field', k, 'issue', 'no_such_photo',
                                             'photos', (select count(*) from app.listing_media m where m.listing_id = l.id and m.kind = 'photo'
                                                          and m.moderation <> 'rejected'));
        continue;
      end if;
      v_set := v_set || jsonb_build_object('remove_media', v_photos);
      v_diff := v_diff || jsonb_build_object('field', 'remove_photos', 'before', null, 'after', jsonb_path_query_array(v_photos, '$[*].n'));
    when 'status' then
      -- archived: no longer shown (rented, withdrawn); published again only a listing that was published before
      if not ((v #>> '{}' = 'archived' and l.status in ('published', 'draft', 'pending_review'))
              or (v #>> '{}' = 'published' and l.status = 'archived' and l.published_at is not null)) then
        v_err := v_err || jsonb_build_object('field', k, 'issue', 'status_not_allowed', 'current', l.status); continue;
      end if;
      v_set := v_set || jsonb_build_object('status', v #>> '{}');
      v_diff := v_diff || jsonb_build_object('field', 'status', 'before', l.status, 'after', v #>> '{}');
    else
      v_err := v_err || jsonb_build_object('field', k, 'issue', 'unknown_field');
    end case;
  end loop;
  if v_am is distinct from l.amenities then
    v_set := v_set || jsonb_build_object('amenities', to_jsonb(v_am));
    v_diff := v_diff || jsonb_build_object('field', 'amenities', 'before', to_jsonb(l.amenities), 'after', to_jsonb(v_am));
  end if;
  if v_rules is distinct from l.house_rules then
    v_set := v_set || jsonb_build_object('house_rules', v_rules);
    v_diff := v_diff || jsonb_build_object('field', 'house_rules', 'before', l.house_rules, 'after', v_rules);
  end if;
  -- nothing would change (same values): say so rather than propose an empty change
  v_diff := coalesce((select jsonb_agg(e) from jsonb_array_elements(v_diff) e where e->'before' is distinct from e->'after'), '[]');
  if jsonb_array_length(v_err) = 0 and jsonb_array_length(v_diff) = 0 then
    v_err := jsonb_build_array(jsonb_build_object('field', 'body', 'issue', 'no_change'));
  end if;
  return jsonb_build_object('ok', jsonb_array_length(v_err) = 0, 'found', true, 'listing_id', l.id, 'status', l.status,
                            'errors', v_err, 'diff', v_diff, 'set', v_set);
end $$;

-- 4. Apply a change (PATCH /v1/listings/:id, or a confirmed proposal). Checks again, then writes. A draft is then
--    tried for automatic publication (app.listing_auto_publish, only when that setting is on). Returns what the
--    workflow must do next: delete the removed photos from storage, embed the listing again.
create or replace function app.listing_apply_changes(p_user uuid, p_listing uuid, p jsonb) returns jsonb
language plpgsql as $$
declare c jsonb; s jsonb; l app.listings; v_pub jsonb; v_keys jsonb := '[]'; v_reembed boolean := false;
begin
  perform 1 from app.listings where id = p_listing for update;
  c := app.listing_change_check(p_user, p_listing, p);
  if not (c->>'ok')::boolean then return c; end if;
  s := c->'set';
  if s ? 'remove_media' then
    v_keys := coalesce((select jsonb_agg(e->>'key') from jsonb_array_elements(s->'remove_media') e), '[]');
    delete from app.listing_media where id in (select (e->>'media_id')::uuid from jsonb_array_elements(s->'remove_media') e);
  end if;
  update app.listings set
    rent_minor = case when s ? 'rent_minor' then (s->>'rent_minor')::bigint else rent_minor end,
    deposit_minor = case when s ? 'deposit_minor' then (s->>'deposit_minor')::bigint else deposit_minor end,
    currency = case when s ? 'currency' then s->>'currency' else currency end,
    rent_period = case when s ? 'rent_period' then s->>'rent_period' else rent_period end,
    rent_scope = case when s ? 'rent_minor' then coalesce(rent_scope, 'unknown') else rent_scope end,
    bills_included = case when s ? 'bills_included' then (s->>'bills_included')::boolean else bills_included end,
    furnished = case when s ? 'furnished' then (s->>'furnished')::boolean else furnished end,
    available_from = case when s ? 'available_from' then (s->>'available_from')::date else available_from end,
    bedrooms = case when s ? 'bedrooms' then (s->>'bedrooms')::smallint else bedrooms end,
    min_stay_months = case when s ? 'min_stay_months' then (s->>'min_stay_months')::smallint else min_stay_months end,
    neighbourhood = case when s ? 'lat' then s->>'neighbourhood' else neighbourhood end,
    city = case when s ? 'lat' then s->>'city' else city end,
    location = case when s ? 'lat' then public.st_setsrid(public.st_makepoint((s->>'lng')::float, (s->>'lat')::float), 4326)::geography
                    else location end,
    amenities = case when s ? 'amenities' then array(select jsonb_array_elements_text(s->'amenities')) else amenities end,
    house_rules = case when s ? 'house_rules' then s->'house_rules' else house_rules end,
    status = case when s ? 'status' then s->>'status' else status end,
    extraction = coalesce(extraction, '{}'::jsonb) || jsonb_build_object('owner_changes',
                   coalesce(extraction->'owner_changes', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('at', now(), 'diff', c->'diff')))
  where id = p_listing returning * into l;
  insert into app.audit_log (actor_id, action, entity, entity_id) values (p_user, 'listing_changed_by_owner', 'listing', p_listing::text);
  if l.status = 'draft' then
    v_pub := app.listing_auto_publish(p_listing);
  end if;
  select * into l from app.listings where id = p_listing;
  v_reembed := l.status = 'published' and (s ? 'lat' or coalesce((v_pub->>'published')::boolean, false));
  return jsonb_build_object('ok', true, 'found', true, 'listing_id', l.id, 'status', l.status, 'diff', c->'diff',
    'publication', v_pub, 'deleted_keys', v_keys, 'reembed', v_reembed,
    'embed_text', case when v_reembed then concat_ws(E'\n', l.title, l.description, nullif(concat_ws(', ', l.neighbourhood, l.city), '')) end,
    'embed', case when v_reembed then (select jsonb_object_agg(key, value #>> '{}') from app.settings
                                        where key in ('ollama.base_url', 'ollama.embed_model', 'llm.keep_alive')) end,
    'media_url', (select value #>> '{}' from app.settings where key = 'services.media_url'));
end $$;

-- PATCH with {"change_id": ...}: applies a pending proposal of this owner (same checks, done again now).
create or replace function app.listing_change_confirm(p_user uuid, p_listing uuid, p_change uuid) returns jsonb
language plpgsql as $$
declare ch ai.listing_changes; r jsonb; v_min int;
begin
  v_min := coalesce((select (value #>> '{}')::int from app.settings where key = 'owner.change_minutes'), 30);
  select * into ch from ai.listing_changes where id = p_change and user_id = p_user and listing_id = p_listing for update;
  if ch.id is null then
    return jsonb_build_object('ok', false, 'found', false, 'errors', jsonb_build_array(jsonb_build_object('field', 'change_id', 'issue', 'not_found')));
  end if;
  if ch.status <> 'pending' or ch.created_at < now() - make_interval(mins => v_min) then
    return jsonb_build_object('ok', false, 'found', true, 'errors', jsonb_build_array(jsonb_build_object('field', 'change_id',
      'issue', case when ch.status = 'pending' then 'expired' else 'already_' || ch.status end)));
  end if;
  r := app.listing_apply_changes(p_user, p_listing, ch.changes);
  update ai.listing_changes set status = case when (r->>'ok')::boolean then 'applied' else 'failed' end, decided_at = now()
   where id = ch.id;
  return r;
end $$;

create or replace function app.listing_change_cancel(p_user uuid, p_change uuid) returns jsonb
language sql as $$
  with u as (update ai.listing_changes set status = 'cancelled', decided_at = now()
              where id = p_change and user_id = p_user and status = 'pending' returning id)
  select jsonb_build_object('cancelled', exists (select 1 from u))
$$;

-- 5. Owner assistant: context, the owner's listings (numbered), a proposal, the proposal of a request.
create or replace function app.owner_agent_context(p_user uuid) returns jsonb
language plpgsql as $$
declare s jsonb; v record; v_days int; v_session text := 'owner:user:' || p_user::text;
begin
  select jsonb_object_agg(key, value #>> '{}') into s from app.settings
   where key in ('owner.agent_enabled', 'owner.agent_max_iterations', 'owner.agent_memory_turns', 'owner.agent_answer_max_chars',
                 'match.agent_memory_days', 'llm.default_model', 'llm.keep_alive', 'llm.num_ctx');
  v_days := coalesce((s->>'match.agent_memory_days')::int, 30);
  delete from agent_memory.chat_histories where created_at < now() - make_interval(days => v_days);
  select pv.id, pv.version, pv.template, pv.params, pv.model into v
    from ai.prompt_versions pv join ai.prompts p on p.id = pv.prompt_id
   where p.name = 'P11_owner_assistant' and pv.status = 'active';
  return jsonb_build_object(
    'agent', 'A1_owner_agent',
    'enabled', coalesce(s->>'owner.agent_enabled', 'true') = 'true',
    'max_iterations', coalesce((s->>'owner.agent_max_iterations')::int, 4),
    'answer_max_chars', coalesce((s->>'owner.agent_answer_max_chars')::int, 400),
    'memory_turns', coalesce((s->>'owner.agent_memory_turns')::int, 4),
    'model', coalesce(v.model, s->>'llm.default_model'),
    'keep_alive', coalesce(s->>'llm.keep_alive', '10m'),
    'num_ctx', coalesce((s->>'llm.num_ctx')::int, 4096),
    'session_id', v_session,
    'memory_messages', (select count(*) from agent_memory.chat_histories where session_id = v_session),
    'memory_text', (select coalesce(string_agg(m.message::text, ' ' order by m.id), '') from (
                      select id, message from agent_memory.chat_histories where session_id = v_session
                       order by id desc limit 2 * coalesce((s->>'owner.agent_memory_turns')::int, 4)) m),
    'prompt', case when v.id is null then null else
      jsonb_build_object('version_id', v.id, 'version', v.version, 'template', v.template, 'params', v.params) end);
end $$;

-- The owner's listings, most recent first (at most 10, rejected ones left out), numbered; fields only, no owner
-- prose (the title and description stay out of the model's context). The numbering is kept for the conversation.
create or replace function app.owner_listings(p_session text, p_user uuid) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'number', x.n, 'status', x.status, 'kind', x.kind,
           'rent', case when x.rent_minor is null then null else round(x.rent_minor / power(10::numeric, x.e), x.e) end,
           'currency', x.currency, 'period', x.rent_period,
           'deposit', case when x.deposit_minor is null then null else round(x.deposit_minor / power(10::numeric, x.e), x.e) end,
           'bills_included', x.bills_included, 'furnished', x.furnished, 'available_from', x.available_from,
           'bedrooms', x.bedrooms, 'min_stay_months', x.min_stay_months, 'neighbourhood', x.neighbourhood, 'city', x.city,
           'amenities', to_jsonb(x.amenities), 'house_rules', x.house_rules, 'photos', x.photos,
           'missing', to_jsonb(array_remove(array[case when x.rent_minor is null then 'rent' end,
                                                 case when x.location is null then 'place' end], null)),
           'id', x.id) order by x.n), '[]') into v
    from (select l.*, row_number() over (order by l.created_at desc, l.id) as n, coalesce(c.exponent, 2) as e,
                 (select count(*) from app.listing_media m where m.listing_id = l.id and m.kind = 'photo' and m.moderation <> 'rejected') as photos
            from app.listings l left join app.currencies c on c.code = l.currency
           where l.owner_id = p_user and l.status <> 'rejected'
           order by l.created_at desc, l.id limit 10) x;
  insert into ai.owner_sessions (session_id, user_id, listings, updated_at)
  values (p_session, p_user, coalesce((select jsonb_agg(e->'id' order by (e->>'number')::int) from jsonb_array_elements(v) e), '[]'), now())
  on conflict (session_id) do update set listings = excluded.listings, user_id = excluded.user_id, updated_at = now();
  return jsonb_build_object('count', jsonb_array_length(v),
                            'listings', coalesce((select jsonb_agg(e - 'id' order by (e->>'number')::int) from jsonb_array_elements(v) e), '[]'));
end $$;

-- A proposal: listing by its number in the conversation (0 or null: the owner's only listing, or the most recent one
-- when the agent has not listed them), checked, stored as pending. Another pending proposal of the user is replaced.
create or replace function app.owner_change_propose(p_session text, p_user uuid, p_request uuid, p_number int, p jsonb) returns jsonb
language plpgsql as $$
declare v_ids jsonb; v_listing uuid; c jsonb; v_id uuid; v_n int := coalesce(nullif(p_number, 0), 1);
begin
  select listings into v_ids from ai.owner_sessions where session_id = p_session;
  if v_ids is null or jsonb_array_length(v_ids) = 0 then
    v_ids := coalesce((select jsonb_agg(id order by created_at desc, id) from (select id, created_at from app.listings
                        where owner_id = p_user and status <> 'rejected' order by created_at desc, id limit 10) x), '[]');
  end if;
  if v_n < 1 or v_n > jsonb_array_length(v_ids) then
    return jsonb_build_object('ok', false, 'errors', jsonb_build_array(jsonb_build_object('field', 'listing', 'issue', 'no_such_listing',
                                                                                         'listings', jsonb_array_length(v_ids))));
  end if;
  v_listing := (v_ids ->> (v_n - 1))::uuid;
  c := app.listing_change_check(p_user, v_listing, p);
  if not (c->>'ok')::boolean then
    return jsonb_build_object('ok', false, 'listing', v_n, 'errors', c->'errors');
  end if;
  update ai.listing_changes set status = 'superseded', decided_at = now() where user_id = p_user and status = 'pending';
  insert into ai.listing_changes (user_id, listing_id, request_id, changes, diff)
  values (p_user, v_listing, p_request, p, c->'diff') returning id into v_id;
  insert into ai.owner_sessions (session_id, user_id, listings) values (p_session, p_user, v_ids)
  on conflict (session_id) do update set updated_at = now();
  return jsonb_build_object('ok', true, 'proposed', true, 'listing', v_n, 'diff', c->'diff');
end $$;

-- The proposal a request made (the latest), for the assistant's response: the channel shows it from here, not from
-- the model's words.
create or replace function app.owner_change_of_request(p_user uuid, p_request uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object('change_id', c.id, 'listing_id', c.listing_id, 'changes', c.changes, 'diff', c.diff,
                            'expires_at', c.created_at + make_interval(mins => coalesce(
                              (select (value #>> '{}')::int from app.settings where key = 'owner.change_minutes'), 30)),
                            'listing_number', (select (o.ord)::int from ai.owner_sessions s,
                                                 jsonb_array_elements_text(s.listings) with ordinality o(id, ord)
                                                where s.session_id = 'owner:user:' || p_user::text and o.id = c.listing_id::text))
    from ai.listing_changes c
   where c.user_id = p_user and c.request_id = p_request and c.status = 'pending'
   order by c.created_at desc limit 1
$$;

-- 6. Follow-ups: the most recent of the three conversations (search, legal, owner) within match.followup_minutes.
--    A listing the user created or changed in that time counts as an open owner conversation ("le loyer est 350").
create or replace function app.agent_followup(p_user uuid) returns text
language sql stable as $$
  with w as (select make_interval(mins => coalesce((select (value #>> '{}')::int from app.settings
                                                     where key = 'match.followup_minutes'), 30)) as i),
  o as (select greatest((select max(updated_at) from ai.owner_sessions where session_id = 'owner:user:' || p_user::text),
                         (select max(updated_at) from app.listings where owner_id = p_user)) as ts),
  c as (
    select 'match' as agent, (select max(updated_at) from ai.match_sessions where session_id = 'user:' || p_user::text) as ts
    union all
    select 'legal', (select max(updated_at) from ai.legal_sessions where session_id = 'legal:user:' || p_user::text)
    union all
    select 'owner', o.ts from o)
  select c.agent from c, w where c.ts > now() - w.i order by c.ts desc, c.agent limit 1
$$;

-- Whether the user has listings the owner assistant can work on.
create or replace function app.owner_has_listings(p_user uuid) returns boolean
language sql stable as $$
  select exists (select 1 from app.listings where owner_id = p_user and status <> 'rejected')
$$;

-- 7. Withdrawing consent deletes the three conversations (spec 13.4).
create or replace function app.forget_conversation() returns trigger
language plpgsql as $$
begin
  if not new.granted and new.purpose in ('terms', 'privacy') then
    delete from agent_memory.chat_histories
     where session_id in ('user:' || new.user_id::text, 'legal:user:' || new.user_id::text, 'owner:user:' || new.user_id::text);
    delete from ai.match_sessions where user_id = new.user_id;
    delete from ai.legal_sessions where user_id = new.user_id;
    delete from ai.owner_sessions where user_id = new.user_id;
    update ai.listing_changes set status = 'cancelled', decided_at = now() where user_id = new.user_id and status = 'pending';
  end if;
  return new;
end $$;

revoke execute on function app.listing_change_check(uuid, uuid, jsonb), app.listing_apply_changes(uuid, uuid, jsonb),
  app.listing_change_confirm(uuid, uuid, uuid), app.listing_change_cancel(uuid, uuid), app.owner_agent_context(uuid),
  app.owner_listings(text, uuid), app.owner_change_propose(text, uuid, uuid, int, jsonb), app.owner_change_of_request(uuid, uuid),
  app.owner_has_listings(uuid) from public;
grant execute on function app.listing_change_check(uuid, uuid, jsonb), app.listing_apply_changes(uuid, uuid, jsonb),
  app.listing_change_confirm(uuid, uuid, uuid), app.listing_change_cancel(uuid, uuid), app.owner_agent_context(uuid),
  app.owner_listings(text, uuid), app.owner_change_propose(text, uuid, uuid, int, jsonb), app.owner_change_of_request(uuid, uuid),
  app.owner_has_listings(uuid) to n8n_worker;

-- migrate:down
create or replace function app.forget_conversation() returns trigger
language plpgsql as $$
begin
  if not new.granted and new.purpose in ('terms', 'privacy') then
    delete from agent_memory.chat_histories where session_id in ('user:' || new.user_id::text, 'legal:user:' || new.user_id::text);
    delete from ai.match_sessions where user_id = new.user_id;
    delete from ai.legal_sessions where user_id = new.user_id;
  end if;
  return new;
end $$;
create or replace function app.agent_followup(p_user uuid) returns text
language sql stable as $$
  with w as (select make_interval(mins => coalesce((select (value #>> '{}')::int from app.settings
                                                     where key = 'match.followup_minutes'), 30)) as i),
  m as (select max(updated_at) as t from ai.match_sessions, w where session_id = 'user:' || p_user::text and updated_at > now() - w.i),
  l as (select max(updated_at) as t from ai.legal_sessions, w where session_id = 'legal:user:' || p_user::text and updated_at > now() - w.i)
  select case when m.t is null and l.t is null then null
              when l.t is not null and (m.t is null or l.t > m.t) then 'legal' else 'match' end
    from m, l
$$;
drop function if exists app.owner_has_listings(uuid);
drop function if exists app.owner_change_of_request(uuid, uuid);
drop function if exists app.owner_change_propose(text, uuid, uuid, int, jsonb);
drop function if exists app.owner_listings(text, uuid);
drop function if exists app.owner_agent_context(uuid);
drop function if exists app.listing_change_cancel(uuid, uuid);
drop function if exists app.listing_change_confirm(uuid, uuid, uuid);
drop function if exists app.listing_apply_changes(uuid, uuid, jsonb);
drop function if exists app.listing_change_check(uuid, uuid, jsonb);
drop table if exists ai.listing_changes;
drop table if exists ai.owner_sessions;
delete from app.settings where key in ('owner.agent_enabled', 'owner.agent_max_iterations', 'owner.agent_memory_turns',
  'owner.agent_answer_max_chars', 'owner.change_minutes');
