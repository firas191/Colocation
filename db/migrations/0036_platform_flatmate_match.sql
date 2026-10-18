-- migrate:up
-- Platform P12 (D-115): the parts of Yosr's roommate matching (branch roommate-matching, 2026-10-16) that our P7 did not
-- have, rebuilt on the platform: contact between flatmates only when both agree, a sentence explaining a match, a
-- profile built by chatting with an agent, and a living plan for a household. Her prototype ran on n8n Cloud with cloud
-- models, Gmail and n8n data tables; here everything is PostgreSQL behind the row-level layer, the local model, and the
-- notification channels of P11.

insert into app.settings (key, value, description) values
  ('contact.requests_per_day', '10', 'Most contact requests a person may send in 24 hours (D-115)'),
  ('contact.request_days', '14', 'A contact request nobody answered is closed after this many days (D-115)'),
  ('flatmate_agent.enabled', 'true', 'Use the profile agent (A7, P13_flatmate_onboarding). Off: the endpoint answers 503 agent_off'),
  ('flatmate_agent.max_iterations', '6', 'Most model turns of the profile agent for one message'),
  ('flatmate_agent.memory_turns', '8', 'Turns of the conversation the profile agent remembers (agent_memory.chat_histories, session flatmate:<user>, as the Document agent)'),
  ('flatmate_agent.num_ctx', '8192', 'Context window of the profile agent'),
  ('flatmate_explain.enabled', 'true', 'Write a sentence for a match with the local model (P12_match_explainer); off: the sentence written by code')
on conflict (key) do nothing;

-- 1. Contact requests ------------------------------------------------------------------------------------------------------
-- A asks B; B accepts (a direct conversation opens, the first message is A's note if there is one) or refuses. Nothing of
-- B is shown to A beyond the visible profile until B accepts. One open request per pair, either direction.
create table social.contact_requests (
  id              uuid primary key default gen_random_uuid(),
  from_user       uuid not null references app.users(id) on delete cascade,
  to_user         uuid not null references app.users(id) on delete cascade,
  note            text check (char_length(note) <= 500),
  status          text not null default 'pending' check (status in ('pending', 'accepted', 'refused', 'cancelled', 'expired')),
  conversation_id uuid references social.conversations(id) on delete set null,
  created_at      timestamptz not null default now(),
  decided_at      timestamptz,
  check (from_user <> to_user)
);
create unique index contact_requests_open_pair on social.contact_requests (least(from_user, to_user), greatest(from_user, to_user))
  where status = 'pending';
create index contact_requests_to on social.contact_requests (to_user, created_at desc);
create index contact_requests_from on social.contact_requests (from_user, created_at desc);
alter table social.contact_requests enable row level security;
alter table social.contact_requests force row level security;
create policy cr_parties on social.contact_requests for select using (app.current_user_id() in (from_user, to_user));
create policy cr_insert on social.contact_requests for insert with check (from_user = app.current_user_id());
create policy cr_update on social.contact_requests for update
  using (app.current_user_id() in (from_user, to_user)) with check (app.current_user_id() in (from_user, to_user));
grant select, insert, update on social.contact_requests to app_rls;

create or replace function api._cr_json(c social.contact_requests) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('request_id', c.id,
    'direction', case when c.from_user = app.current_user_id() then 'sent' else 'received' end,
    'other', api._name(case when c.from_user = app.current_user_id() then c.to_user else c.from_user end),
    'note', c.note, 'status', c.status, 'conversation_id', c.conversation_id, 'created_at', c.created_at, 'decided_at', c.decided_at,
    'actions', jsonb_build_object(
      'accept', c.status = 'pending' and c.to_user = app.current_user_id(),
      'refuse', c.status = 'pending' and c.to_user = app.current_user_id(),
      'cancel', c.status = 'pending' and c.from_user = app.current_user_id()))
$$;

-- POST /v1/flatmates/{user_id}/contact-requests {note}: only to a visible profile (the row-level policy of P7 decides),
-- never between people who blocked each other, once per pair while it is open, at most contact.requests_per_day a day.
create or replace function api.contact_request_create(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_to uuid := (p#>>'{params,user_id}')::uuid; v_note text := nullif(btrim(coalesce(p#>>'{body,note}', '')), ''); c social.contact_requests;
  n int; v_lim int := api._setting_int('contact.requests_per_day', 10);
begin
  perform api._as(p_user);
  if v_to is null or v_to = p_user or not exists (select 1 from social.flatmate_profiles where user_id = v_to and visible) then
    return api._err(404, 'NOT_FOUND', 'Profile not found');
  end if;
  if api._blocked(p_user, v_to) then return api._err(404, 'NOT_FOUND', 'Profile not found'); end if;
  if exists (select 1 from social.contact_requests where status = 'pending'
              and least(from_user, to_user) = least(p_user, v_to) and greatest(from_user, to_user) = greatest(p_user, v_to)) then
    return api._err(409, 'CONFLICT', 'A request is already open', '[{"issue": "already_requested"}]');
  end if;
  select count(*) into n from social.contact_requests where from_user = p_user and created_at > now() - interval '1 day';
  if n >= v_lim then return api._too_many(p_user, n, v_lim, 86400); end if;
  insert into social.contact_requests (from_user, to_user, note) values (p_user, v_to, v_note) returning * into c;
  perform api.notify_emit(v_to, 'contact_request_received', jsonb_build_object('from', api._name(p_user)->>'display_name'),
                          'contact_request', c.id::text);
  return api._ok(api._cr_json(c), 201);
end $$;

-- GET /v1/me/contact-requests?direction=received|sent: newest first; requests left open too long are closed first
create or replace function api.contact_requests_list(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_dir text := p#>>'{query,direction}';
begin
  perform api._as(p_user);
  update social.contact_requests set status = 'expired', decided_at = now()
   where status = 'pending' and created_at < now() - make_interval(days => api._setting_int('contact.request_days', 14));
  return api._ok(jsonb_build_object('items', coalesce((
    select jsonb_agg(api._cr_json(c) order by c.created_at desc) from (
      select * from social.contact_requests c
       where (v_dir is null or (v_dir = 'sent' and from_user = p_user) or (v_dir = 'received' and to_user = p_user))
         and not exists (select 1 from app.users u where u.id in (c.from_user, c.to_user) and u.deleted_at is not null)
       order by created_at desc limit 50) c), '[]')));
end $$;

-- POST /v1/contact-requests/{id}/decision {action: accept | refuse | cancel}. accept: a direct conversation opens between
-- the two (the note, if any, is its first message, from the person who asked) and the person who asked is told.
create or replace function api.contact_request_decide(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare c social.contact_requests; v_act text := p#>>'{body,action}'; v_conv uuid;
begin
  perform api._as(p_user);
  select * into c from social.contact_requests where id = (p#>>'{params,id}')::uuid;       -- the policy: parties only
  if c.id is null then return api._err(404, 'NOT_FOUND', 'Request not found'); end if;
  if c.status <> 'pending' then
    return api._err(409, 'CONFLICT', 'The request is closed', jsonb_build_array(jsonb_build_object('issue', 'not_pending', 'status', c.status)));
  end if;
  if v_act is null or v_act not in ('accept', 'refuse', 'cancel') then
    return api._err(422, 'VALIDATION_FAILED', 'Request is invalid', '[{"field": "action", "issue": "invalid"}]');
  end if;
  if (v_act in ('accept', 'refuse') and c.to_user <> p_user) or (v_act = 'cancel' and c.from_user <> p_user) then
    return api._err(403, 'FORBIDDEN', 'Not yours to decide');
  end if;
  if v_act = 'accept' then
    if api._blocked(c.from_user, c.to_user) then return api._err(409, 'CONFLICT', 'Blocked', '[{"issue": "blocked"}]'); end if;
    v_conv := gen_random_uuid();
    insert into social.conversations (id, kind, created_by) values (v_conv, 'direct', p_user);
    insert into social.conversation_members (conversation_id, user_id, last_read_at) values (v_conv, p_user, now()), (v_conv, c.from_user, null);
    if c.note is not null then                    -- written as the person who asked, as the row-level rule on messages wants
      perform set_config('app.user_id', c.from_user::text, true);
      insert into social.messages (conversation_id, sender_id, body) values (v_conv, c.from_user, c.note);
      perform set_config('app.user_id', p_user::text, true);
    end if;
    update social.contact_requests set status = 'accepted', decided_at = now(), conversation_id = v_conv where id = c.id returning * into c;
    perform api.notify_emit(c.from_user, 'contact_request_accepted', jsonb_build_object('from', api._name(p_user)->>'display_name'),
                            'conversation', v_conv::text);
  else
    update social.contact_requests set status = case v_act when 'refuse' then 'refused' else 'cancelled' end, decided_at = now()
     where id = c.id returning * into c;
  end if;
  return api._ok(api._cr_json(c));
end $$;

-- 2. A sentence for a match: what the website may tell about the pair, never the other person's answers -----------------
create or replace function api.flatmate_explain_facts(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare f social.flatmate_profiles; cmp jsonb;
begin
  perform api._as(p_user);
  select * into f from social.flatmate_profiles where user_id = (p#>>'{params,user_id}')::uuid and visible and user_id <> p_user;
  if f.user_id is null then return api._err(404, 'NOT_FOUND', 'Profile not found'); end if;
  cmp := social.compatibility(p_user, f.user_id);
  return api._ok(jsonb_build_object('other', api._name(f.user_id), 'compatibility', cmp,
    'enabled', coalesce((select value #>> '{}' from app.settings where key = 'flatmate_explain.enabled'), 'true') = 'true'));
end $$;

-- 3. The profile agent (A7): what is already known, and applying what the person confirmed ---------------------------------
-- Superuser-owned: app.profiles is written by the workflows of the search profile (P2), not by the row-level role.
create or replace function app.flatmate_onboarding_state(p_user uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object(
    'user', jsonb_build_object('display_name', u.display_name, 'jurisdiction_code', u.jurisdiction_code,
                               'currency', (select default_currency from app.jurisdictions where code = u.jurisdiction_code),
                               'exponent', (select c.exponent from app.currencies c join app.jurisdictions j on j.default_currency = c.code
                                             where j.code = u.jurisdiction_code)),
    'lifestyle', coalesce(p.declared_preferences, '{}'),
    'budget', jsonb_build_object('min_minor', p.budget_min_minor, 'max_minor', p.budget_max_minor, 'currency', p.currency),
    'languages', coalesce(to_jsonb(p.languages), '[]'),
    'profile', case when f.user_id is null then null else jsonb_build_object('visible', f.visible, 'headline', f.headline,
               'seeking', f.seeking, 'areas', to_jsonb(f.areas), 'move_in_from', f.move_in_from) end,
    'missing', (select coalesce(jsonb_agg(k), '[]') from unnest(array['schedule', 'cleanliness', 'smoking', 'pets', 'guests', 'quiet_hours']) k
                 where coalesce(p.declared_preferences, '{}')->>k is null)
      || case when p.budget_max_minor is null then '["budget"]'::jsonb else '[]' end
      || case when f.areas is null or cardinality(f.areas) = 0 then '["areas"]'::jsonb else '[]' end
      || case when coalesce(f.move_in_from, p.move_in_from) is null then '["move_in_from"]'::jsonb else '[]' end
      || case when f.headline is null then '["headline"]'::jsonb else '[]' end)
  from app.users u left join app.profiles p on p.user_id = u.id left join social.flatmate_profiles f on f.user_id = u.id
  where u.id = p_user and u.deleted_at is null
$$;

-- p: {lifestyle: {schedule, cleanliness, smoking, pets, guests, quiet_hours}, budget_max, budget_min, languages, headline,
--     seeking, areas, move_in_from, visible}; only the fields given change; amounts in main units of the country's currency.
create or replace function app.flatmate_onboarding_apply(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare st jsonb := app.flatmate_onboarding_state(p_user); v_exp int; v_cur text; ls jsonb;
begin
  p := coalesce(p->'body', p);                  -- called by the endpoint with {params, query, body}, or with the fields
  ls := coalesce(p->'lifestyle', '{}');
  if st is null then return jsonb_build_object('status', 404, 'error', jsonb_build_object('code', 'NOT_FOUND', 'message', 'User not found', 'details', '[]'::jsonb)); end if;
  v_cur := coalesce(st#>>'{budget,currency}', st#>>'{user,currency}');
  v_exp := coalesce((select exponent from app.currencies where code = v_cur), 2);
  insert into app.profiles (user_id, jurisdiction_code, currency) values (p_user, st#>>'{user,jurisdiction_code}', v_cur)
  on conflict (user_id) do nothing;
  update app.profiles set
    declared_preferences = declared_preferences || (select coalesce(jsonb_object_agg(k, v), '{}') from jsonb_each_text(ls) x(k, v)
                                                     where k in ('schedule', 'cleanliness', 'smoking', 'pets', 'guests', 'quiet_hours')),
    budget_min_minor = case when p ? 'budget_min' then round((p->>'budget_min')::numeric * 10 ^ v_exp)::bigint else budget_min_minor end,
    budget_max_minor = case when p ? 'budget_max' then round((p->>'budget_max')::numeric * 10 ^ v_exp)::bigint else budget_max_minor end,
    currency = coalesce(currency, v_cur),
    languages = case when p ? 'languages' then array(select jsonb_array_elements_text(p->'languages')) else languages end,
    move_in_from = case when p ? 'move_in_from' then (p->>'move_in_from')::date else move_in_from end,
    updated_at = now()
  where user_id = p_user;
  insert into social.flatmate_profiles (user_id, visible, headline, seeking, areas, move_in_from)
  values (p_user, coalesce((p->>'visible')::boolean, false), nullif(btrim(coalesce(p->>'headline', '')), ''), coalesce(p->>'seeking', 'both'),
          coalesce(array(select btrim(x) from jsonb_array_elements_text(p->'areas') x), '{}'), (p->>'move_in_from')::date)
  on conflict (user_id) do update set
    visible = case when p ? 'visible' then (p->>'visible')::boolean else social.flatmate_profiles.visible end,
    headline = case when p ? 'headline' then nullif(btrim(p->>'headline'), '') else social.flatmate_profiles.headline end,
    seeking = case when p ? 'seeking' then p->>'seeking' else social.flatmate_profiles.seeking end,
    areas = case when p ? 'areas' then array(select btrim(x) from jsonb_array_elements_text(p->'areas') x) else social.flatmate_profiles.areas end,
    move_in_from = case when p ? 'move_in_from' then (p->>'move_in_from')::date else social.flatmate_profiles.move_in_from end,
    updated_at = now();
  return jsonb_build_object('status', 200, 'data', app.flatmate_onboarding_state(p_user));
end $$;

-- 4. Living plan for a household (GLOBAL template living_plan) ------------------------------------------------------------
alter table home.documents drop constraint documents_kind_check;
alter table home.documents add constraint documents_kind_check
  check (kind in ('flatmate_agreement', 'inventory_entry', 'inventory_exit', 'rent_receipt', 'house_rules', 'living_plan'));

-- How the active flatmates live, per topic: agreed (everyone said the same, with the answer), to_discuss (answers differ)
-- or not_said (someone did not answer). Never who said what. Superuser-owned: it reads the members' lifestyle answers,
-- which the row-level role may not.
create or replace function home.living_plan_habits(p_household uuid, p_lang text) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  with m as (select coalesce(p.declared_preferences, '{}') dp from home.household_members hm left join app.profiles p on p.user_id = hm.user_id
              where hm.household_id = p_household and hm.role = 'flatmate' and hm.status = 'active'),
  k as (select * from (values (1, 'schedule'), (2, 'cleanliness'), (3, 'smoking'), (4, 'pets'), (5, 'guests'), (6, 'quiet_hours')) v(o, k)),
  s as (select k.o, k.k, count(*) filter (where m.dp->>k.k is null) as unknown, count(distinct m.dp->>k.k) as answers,
               min(m.dp->>k.k) as answer from k cross join m group by k.o, k.k),
  lbl(lang, code, txt) as (values
    ('fr', 'schedule', 'Horaires'), ('fr', 'cleanliness', 'Propreté'), ('fr', 'smoking', 'Tabac'), ('fr', 'pets', 'Animaux'),
    ('fr', 'guests', 'Invités'), ('fr', 'quiet_hours', 'Heures calmes'),
    ('en', 'schedule', 'Schedule'), ('en', 'cleanliness', 'Cleanliness'), ('en', 'smoking', 'Smoking'), ('en', 'pets', 'Pets'),
    ('en', 'guests', 'Guests'), ('en', 'quiet_hours', 'Quiet hours'),
    ('ar', 'schedule', 'المواعيد'), ('ar', 'cleanliness', 'النظافة'), ('ar', 'smoking', 'التدخين'), ('ar', 'pets', 'الحيوانات'),
    ('ar', 'guests', 'الضيوف'), ('ar', 'quiet_hours', 'أوقات الهدوء'),
    ('fr', 'early', 'tôt'), ('fr', 'late', 'tard'), ('fr', 'irregular', 'variables'), ('fr', 'high', 'très soignée'),
    ('fr', 'medium', 'normale'), ('fr', 'relaxed', 'détendue'), ('fr', 'yes', 'oui'), ('fr', 'no', 'non'),
    ('en', 'early', 'early'), ('en', 'late', 'late'), ('en', 'irregular', 'irregular'), ('en', 'high', 'very tidy'),
    ('en', 'medium', 'normal'), ('en', 'relaxed', 'relaxed'), ('en', 'yes', 'yes'), ('en', 'no', 'no'),
    ('ar', 'early', 'مبكرة'), ('ar', 'late', 'متأخرة'), ('ar', 'irregular', 'متغيرة'), ('ar', 'high', 'عالية جدا'),
    ('ar', 'medium', 'عادية'), ('ar', 'relaxed', 'مرنة'), ('ar', 'yes', 'نعم'), ('ar', 'no', 'لا'),
    ('fr', 'agreed', 'D''accord : '), ('fr', 'to_discuss', 'À discuter : les réponses diffèrent'), ('fr', 'not_said', 'Pas encore dit par tout le monde'),
    ('en', 'agreed', 'Agreed: '), ('en', 'to_discuss', 'To discuss: the answers differ'), ('en', 'not_said', 'Not said by everyone yet'),
    ('ar', 'agreed', 'متفق: '), ('ar', 'to_discuss', 'للنقاش: الإجابات مختلفة'), ('ar', 'not_said', 'لم يجب الجميع بعد'))
  select coalesce(jsonb_agg(jsonb_build_object('topic', (select txt from lbl where lang = p_lang and code = s.k),
    'agreement', case when s.unknown > 0 then (select txt from lbl where lang = p_lang and code = 'not_said')
                      when s.answers > 1 then (select txt from lbl where lang = p_lang and code = 'to_discuss')
                      else (select txt from lbl where lang = p_lang and code = 'agreed') || (select txt from lbl where lang = p_lang and code = s.answer) end)
    order by s.o), '[]')
  from s
$$;

alter function api.document_facts(uuid, jsonb) rename to document_facts_base;
create or replace function api.document_facts(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare r jsonb := api.document_facts_base(p_user, p); v_id uuid := (p#>>'{params,id}')::uuid; v_lang text := coalesce(p#>>'{body,language}', 'fr');
  v_exp int; v_cur text; n int;
begin
  -- the living plan's facts go with every kind: the Document agent reads the facts once, before it knows the kind
  if (r->>'status')::int <> 200 then return r; end if;
  if v_lang not in ('fr', 'en', 'ar') then v_lang := 'fr'; end if;
  v_cur := r#>>'{data,currency}'; v_exp := (r#>>'{data,exponent}')::int;
  select greatest(count(*), 1) into n from home.household_members where household_id = v_id and role = 'flatmate' and status = 'active';
  return jsonb_set(r, '{data,facts}', (r#>'{data,facts}') || jsonb_build_object(
    'costs', (select coalesce(jsonb_agg(jsonb_build_object('label', ri.label,
                 'amount', case when ri.amount_minor is null then '' else rtrim(to_char(ri.amount_minor / 10.0 ^ v_exp, 'FM999999990.' || repeat('0', v_exp)), '.') || ' ' || v_cur end,
                 'due_day', ri.due_day::text,
                 'share', case when ri.amount_minor is null then '' else rtrim(to_char(ri.amount_minor / 10.0 ^ v_exp / n, 'FM999999990.' || repeat('0', v_exp)), '.') || ' ' || v_cur end)
                 order by ri.kind desc, ri.label), '[]')
                from home.recurring_items ri where ri.household_id = v_id and ri.active),
    'chores', (select coalesce(jsonb_agg(jsonb_build_object('title', c.title, 'frequency', c.frequency, 'next', c.next_due_on::text)
                 order by c.title), '[]') from home.chores c where c.household_id = v_id and c.active),
    'habits', home.living_plan_habits(v_id, v_lang),
    'habits_fr', home.living_plan_habits(v_id, 'fr'), 'habits_en', home.living_plan_habits(v_id, 'en'),
    'habits_ar', home.living_plan_habits(v_id, 'ar')));
end $$;

do $$
declare f text;
  internal text[] := array['api._cr_json(social.contact_requests)'];
  public_ text[] := array['api.contact_request_create(uuid, jsonb)', 'api.contact_requests_list(uuid, jsonb)', 'api.contact_request_decide(uuid, jsonb)',
    'api.flatmate_explain_facts(uuid, jsonb)', 'api.document_facts(uuid, jsonb)'];
begin
  foreach f in array internal || public_ loop
    execute format('alter function %s owner to app_rls', f);
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to app_rls', f);
  end loop;
  foreach f in array public_ loop execute format('grant execute on function %s to n8n_worker', f); end loop;
end $$;
revoke execute on function app.flatmate_onboarding_state(uuid), app.flatmate_onboarding_apply(uuid, jsonb),
  home.living_plan_habits(uuid, text) from public;
grant execute on function app.flatmate_onboarding_state(uuid), app.flatmate_onboarding_apply(uuid, jsonb) to n8n_worker;
grant execute on function home.living_plan_habits(uuid, text) to app_rls, n8n_worker;

-- erasure: open requests of a person who leaves are closed
create or replace function app.platform_contact_requests_on_user_erased() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update social.contact_requests set status = 'cancelled', decided_at = now(), note = null
     where status = 'pending' and new.id in (from_user, to_user);
    update social.contact_requests set note = null where new.id = from_user;
    delete from agent_memory.chat_histories where session_id = 'flatmate:' || new.id::text;
  end if;
  return new;
end $$;
create trigger trg_platform_contact_requests_erased after update of deleted_at on app.users
  for each row execute function app.platform_contact_requests_on_user_erased();
revoke execute on function app.platform_contact_requests_on_user_erased() from public;

-- migrate:down
drop trigger if exists trg_platform_contact_requests_erased on app.users;
drop function if exists app.platform_contact_requests_on_user_erased();
drop function api.document_facts(uuid, jsonb);
alter function api.document_facts_base(uuid, jsonb) rename to document_facts;
drop function if exists home.living_plan_habits(uuid, text);
delete from home.documents where kind = 'living_plan';
alter table home.documents drop constraint documents_kind_check;
alter table home.documents add constraint documents_kind_check
  check (kind in ('flatmate_agreement', 'inventory_entry', 'inventory_exit', 'rent_receipt', 'house_rules'));
drop function if exists app.flatmate_onboarding_apply(uuid, jsonb), app.flatmate_onboarding_state(uuid),
  api.flatmate_explain_facts(uuid, jsonb), api.contact_request_decide(uuid, jsonb), api.contact_requests_list(uuid, jsonb),
  api.contact_request_create(uuid, jsonb), api._cr_json(social.contact_requests);
drop table if exists social.contact_requests;
delete from app.settings where key in ('contact.requests_per_day', 'contact.request_days', 'flatmate_agent.enabled',
  'flatmate_agent.max_iterations', 'flatmate_agent.memory_turns', 'flatmate_agent.num_ctx', 'flatmate_explain.enabled');
