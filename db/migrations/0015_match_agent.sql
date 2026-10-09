-- migrate:up
-- A3 Match agent (spec 8.2): an n8n AI Agent node with the local chat model, a chat memory per user and two tools
-- (search, details of one result). docs/DECISIONS.md D-084.

-- 1. Settings ----------------------------------------------------------------------------
insert into app.settings (key, value, description) values
  ('match.agent_enabled',       'true', 'Answer searches in the assistant with the A3 Match agent (AI Agent node); false = the fixed path P2 then search'),
  ('match.agent_max_iterations', '4',   'Most model turns of the agent for one message (each tool call is one)'),
  ('match.agent_memory_turns',  '6',    'Window of the chat memory: the agent sees the last 2 x N stored messages (a search takes 4: message, tool call, tool result, answer)'),
  ('match.agent_memory_days',   '30',   'Days a conversation is kept for the agent; older messages are deleted'),
  ('match.followup_minutes',    '30',   'After a search, how long a message the router does not classify as a search still goes to the agent (follow-ups such as "cheaper?")')
on conflict (key) do nothing;

-- 2. Conversation memory read and written by n8n's Postgres Chat Memory node ------------------
--    The node runs "create table if not exists" before each use, which needs CREATE on the schema even when the table
--    exists, so the table sits alone in its own schema. Messages are the masked copy of the text (Text service).
create schema if not exists agent_memory;
create table agent_memory.chat_histories (
  id          serial primary key,
  session_id  varchar(255) not null,          -- 'user:<uuid>'
  message     jsonb not null,                 -- LangChain stored message {type, content, ...}
  created_at  timestamptz not null default now()
);
create index on agent_memory.chat_histories (session_id, id);
create index on agent_memory.chat_histories (created_at);
grant usage, create on schema agent_memory to n8n_worker;
grant select, insert, delete on agent_memory.chat_histories to n8n_worker;
grant usage on sequence agent_memory.chat_histories_id_seq to n8n_worker;

-- 3. The last search of a conversation: what the details tool reads ("the second one") and where the assistant
--    response takes its result cards from. Listing ids and the understood profile only, no user text.
create table ai.match_sessions (
  session_id  text primary key,
  user_id     uuid not null references app.users(id) on delete cascade,
  request_id  uuid,                           -- the request whose agent ran the search
  results     jsonb not null default '[]',    -- [{id, distance_m, score}] in rank order
  profile     jsonb,
  anchor      jsonb,
  steps       jsonb not null default '[]',    -- trace steps of the tool (P2 call, search), copied into the request's trace
  updated_at  timestamptz not null default now()
);
grant select, insert, update, delete on ai.match_sessions to n8n_worker;

-- 4. Public cards of listings, same shape as app.search_public results (published listings only).
create or replace function app.public_cards(p_ids jsonb) returns jsonb
language sql stable as $$
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
    from jsonb_array_elements(coalesce(p_ids, '[]')) with ordinality r(e, ord)
    join app.listings l on l.id = (r.e->>'id')::uuid and l.status = 'published'
    left join app.currencies c on c.code = l.currency
$$;

-- 5. What the agent workflow needs at its start: settings, the active P6 prompt, and old memory removed.
create or replace function app.match_agent_context(p_user uuid) returns jsonb
language plpgsql as $$
declare s jsonb; v record; v_days int;
begin
  select jsonb_object_agg(key, value #>> '{}') into s from app.settings
   where key in ('match.agent_enabled', 'match.agent_max_iterations', 'match.agent_memory_turns', 'match.agent_memory_days',
                 'llm.default_model', 'llm.keep_alive', 'llm.num_ctx');
  v_days := coalesce((s->>'match.agent_memory_days')::int, 30);
  delete from agent_memory.chat_histories where created_at < now() - make_interval(days => v_days);
  select pv.id, pv.version, pv.template, pv.params, pv.model into v
    from ai.prompt_versions pv join ai.prompts p on p.id = pv.prompt_id
   where p.name = 'P6_match_agent' and pv.status = 'active';
  return jsonb_build_object(
    'enabled', coalesce(s->>'match.agent_enabled', 'true') = 'true',
    'max_iterations', coalesce((s->>'match.agent_max_iterations')::int, 4),
    'memory_turns', coalesce((s->>'match.agent_memory_turns')::int, 6),
    'model', coalesce(v.model, s->>'llm.default_model'),
    'keep_alive', coalesce(s->>'llm.keep_alive', '10m'),
    'num_ctx', coalesce((s->>'llm.num_ctx')::int, 4096),
    'session_id', 'user:' || p_user::text,
    'memory_messages', (select count(*) from agent_memory.chat_histories where session_id = 'user:' || p_user::text),
    -- what the model can see of earlier turns: numbers in its answer may come from there too (answer check, D-084)
    'memory_text', (select coalesce(string_agg(m.message::text, ' ' order by m.id), '') from (
                      select id, message from agent_memory.chat_histories where session_id = 'user:' || p_user::text
                       order by id desc limit 2 * coalesce((s->>'match.agent_memory_turns')::int, 6)) m),
    'prompt', case when v.id is null then null else
      jsonb_build_object('version_id', v.id, 'version', v.version, 'template', v.template, 'params', v.params) end);
end $$;

-- 6. The search tool stores its result for the conversation; the details tool reads one result by its number.
create or replace function app.match_session_store(p_session text, p_user uuid, p_request uuid, p jsonb) returns jsonb
language sql as $$
  insert into ai.match_sessions (session_id, user_id, request_id, results, profile, anchor, steps, updated_at)
  values (p_session, p_user, p_request, coalesce(p->'results', '[]'), p->'profile', p->'anchor', coalesce(p->'steps', '[]'), now())
  on conflict (session_id) do update set user_id = excluded.user_id, request_id = excluded.request_id, results = excluded.results,
    profile = excluded.profile, anchor = excluded.anchor, steps = excluded.steps, updated_at = now()
  returning jsonb_build_object('stored', jsonb_array_length(results))
$$;

-- Fields of one listing of the last search, for the model: no title or description (owner prose, spec 8.2 A3 guardrail).
create or replace function app.match_session_listing(p_session text, p_number int) returns jsonb
language sql stable as $$
  with s as (select results from ai.match_sessions where session_id = p_session),
  e as (select r.e from s, jsonb_array_elements(s.results) with ordinality r(e, ord) where r.ord = p_number)
  select case
    when not exists (select 1 from s) then jsonb_build_object('found', false, 'reason', 'no_search_yet')
    when not exists (select 1 from e) then jsonb_build_object('found', false, 'reason', 'no_such_number',
                                                               'results', (select jsonb_array_length(results) from s))
    else coalesce((select jsonb_build_object('found', true, 'number', p_number, 'kind', l.kind,
        'rent', round(l.rent_minor::numeric / power(10::numeric, coalesce(c.exponent, 2)), coalesce(c.exponent, 2)),
        'currency', l.currency, 'period', l.rent_period, 'bills_included', l.bills_included,
        'deposit', round(l.deposit_minor::numeric / power(10::numeric, coalesce(c.exponent, 2)), coalesce(c.exponent, 2)),
        'available_from', l.available_from, 'min_stay_months', l.min_stay_months, 'bedrooms', l.bedrooms,
        'furnished', l.furnished, 'current_flatmates', l.current_flatmates, 'amenities', to_jsonb(l.amenities),
        'house_rules', l.house_rules, 'neighbourhood', l.neighbourhood, 'city', l.city,
        'distance_km', round((e.e->>'distance_m')::numeric / 1000, 1))
      from e join app.listings l on l.id = (e.e->>'id')::uuid and l.status = 'published'
      left join app.currencies c on c.code = l.currency), jsonb_build_object('found', false, 'reason', 'not_published'))
  end
$$;

-- The cards, profile and tool steps of the search a request ran (null when this request ran no search).
create or replace function app.match_session_result(p_session text, p_request uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object('searched', true, 'results', app.public_cards(results), 'profile', profile, 'anchor', anchor,
                            'steps', steps)
    from ai.match_sessions where session_id = p_session and request_id = p_request
$$;

-- Whether a message the router did not classify as a search may be a follow-up of a recent search.
create or replace function app.match_followup_open(p_user uuid) returns boolean
language sql stable as $$
  select exists (select 1 from ai.match_sessions
                  where session_id = 'user:' || p_user::text
                    and updated_at > now() - make_interval(mins => coalesce(
                          (select (value #>> '{}')::int from app.settings where key = 'match.followup_minutes'), 30)))
$$;

-- 7. Withdrawing consent deletes the conversation (spec 13.4).
create or replace function app.forget_conversation() returns trigger
language plpgsql as $$
begin
  if not new.granted and new.purpose in ('terms', 'privacy') then
    delete from agent_memory.chat_histories where session_id = 'user:' || new.user_id::text;
    delete from ai.match_sessions where user_id = new.user_id;
  end if;
  return new;
end $$;
create trigger consents_forget_conversation after insert on app.consents
  for each row execute function app.forget_conversation();

revoke execute on function app.public_cards(jsonb), app.match_agent_context(uuid), app.match_session_store(text, uuid, uuid, jsonb),
  app.match_session_listing(text, int), app.match_session_result(text, uuid), app.match_followup_open(uuid),
  app.forget_conversation() from public;
grant execute on function app.public_cards(jsonb), app.match_agent_context(uuid), app.match_session_store(text, uuid, uuid, jsonb),
  app.match_session_listing(text, int), app.match_session_result(text, uuid), app.match_followup_open(uuid) to n8n_worker;

-- migrate:down
drop trigger if exists consents_forget_conversation on app.consents;
drop function if exists app.forget_conversation();
drop function if exists app.match_followup_open(uuid);
drop function if exists app.match_session_result(text, uuid);
drop function if exists app.match_session_listing(text, int);
drop function if exists app.match_session_store(text, uuid, uuid, jsonb);
drop function if exists app.match_agent_context(uuid);
drop function if exists app.public_cards(jsonb);
drop table if exists ai.match_sessions;
drop schema if exists agent_memory cascade;
delete from app.settings where key in ('match.agent_enabled', 'match.agent_max_iterations', 'match.agent_memory_turns',
                                       'match.agent_memory_days', 'match.followup_minutes');
