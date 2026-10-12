-- migrate:up
-- A5 Legal agent (spec 8.2, 10.6): an n8n AI Agent node with the local chat model, its own chat memory per user and one
-- tool that searches the knowledge base of the user's country (plus global sources). Answers only from the numbered
-- excerpts it retrieved, cites them as [n], says when the excerpts do not answer and when sources disagree.
-- docs/DECISIONS.md D-087.

-- 1. Settings ----------------------------------------------------------------------------
insert into app.settings (key, value, description) values
  ('legal.agent_enabled',          'true', 'Answer legal questions in the assistant with the A5 Legal agent; false = "not available yet"'),
  ('legal.agent_max_iterations',   '4',    'Most model turns of the Legal agent for one message (each tool call is one)'),
  ('legal.agent_memory_turns',     '2',    'Window of the Legal agent''s chat memory (2 x N stored messages; a turn with a search stores 4, excerpts included)'),
  ('legal.num_ctx',                '8192', 'Context window of the Legal agent''s model calls: five excerpts of up to 500 tokens do not fit in llm.num_ctx (4096)'),
  ('legal.retrieval',              '{"model": "bge-m3", "strategy": "fixed_500_50", "mode": "dense", "k": 5, "min_reliability": 1, "candidates": 50}',
                                   'Knowledge-base search of the Legal agent: the best configuration of RETRIEVAL_EVAL (T-21: config A, dense)'),
  ('legal.min_similarity',         '0',    'Abstention threshold: excerpts are given to the model only when the best cosine similarity reaches it. 0 = off until tuned on tn_retrieval (scripts/legal_bench.py)'),
  ('legal.excerpt_chars',          '0',    'Longest excerpt given to the model, in characters; 0 = the whole chunk'),
  ('legal.agent_answer_max_chars', '900',  'Longest Legal agent answer shown; a longer one is cut at the last sentence that fits')
on conflict (key) do nothing;

-- 2. Excerpts retrieved in a conversation, numbered. The numbers continue across the messages of a conversation, so an
--    answer citing [n] can be checked against what was retrieved, and a number seen in the memory keeps its meaning.
--    Only the excerpts of the current and the previous request are kept.
create table ai.legal_sessions (
  session_id  text primary key,                -- 'legal:user:<uuid>'
  user_id     uuid not null references app.users(id) on delete cascade,
  request_id  uuid,                            -- the last request that searched
  sources     jsonb not null default '[]',     -- [{n, request_id, chunk_id, document_id, start_char, end_char, source_key,
                                               --   title, url, source_type, reliability, article, retrieved_at, similarity}]
  searches    int not null default 0,          -- searches of the last request
  best_similarity double precision,            -- best dense similarity of the last request's searches
  updated_at  timestamptz not null default now()
);
grant select, insert, update, delete on ai.legal_sessions to n8n_worker;

-- 3. What the agent workflow needs at its start (same shape as app.match_agent_context).
create or replace function app.legal_agent_context(p_user uuid) returns jsonb
language plpgsql as $$
declare s jsonb; v record; v_days int; v_session text := 'legal:user:' || p_user::text;
begin
  select jsonb_object_agg(key, value #>> '{}') into s from app.settings
   where key in ('legal.agent_enabled', 'legal.agent_max_iterations', 'legal.agent_memory_turns', 'legal.num_ctx',
                 'legal.agent_answer_max_chars', 'legal.notice_version', 'match.agent_memory_days',
                 'llm.default_model', 'llm.keep_alive');
  v_days := coalesce((s->>'match.agent_memory_days')::int, 30);
  delete from agent_memory.chat_histories where created_at < now() - make_interval(days => v_days);
  select pv.id, pv.version, pv.template, pv.params, pv.model into v
    from ai.prompt_versions pv join ai.prompts p on p.id = pv.prompt_id
   where p.name = 'P5_legal_answerer' and pv.status = 'active';
  return jsonb_build_object(
    'agent', 'A5_legal_agent',
    'enabled', coalesce(s->>'legal.agent_enabled', 'true') = 'true',
    'max_iterations', coalesce((s->>'legal.agent_max_iterations')::int, 4),
    'answer_max_chars', coalesce((s->>'legal.agent_answer_max_chars')::int, 900),
    'memory_turns', coalesce((s->>'legal.agent_memory_turns')::int, 2),
    'model', coalesce(v.model, s->>'llm.default_model'),
    'keep_alive', coalesce(s->>'llm.keep_alive', '10m'),
    'num_ctx', coalesce((s->>'legal.num_ctx')::int, 8192),
    'notice_version', coalesce(s->>'legal.notice_version', 'legal-notice-v1'),
    'session_id', v_session,
    'memory_messages', (select count(*) from agent_memory.chat_histories where session_id = v_session),
    'memory_text', (select coalesce(string_agg(m.message::text, ' ' order by m.id), '') from (
                      select id, message from agent_memory.chat_histories where session_id = v_session
                       order by id desc limit 2 * coalesce((s->>'legal.agent_memory_turns')::int, 2)) m),
    'prompt', case when v.id is null then null else
      jsonb_build_object('version_id', v.id, 'version', v.version, 'template', v.template, 'params', v.params) end);
end $$;

-- 4. The search tool: knowledge-base search (kb.search_chunks, jurisdiction plus global sources), excerpts numbered
--    for the conversation and stored. p_vector is the query embedding as text ('[...]'), null when the embedding call
--    failed: the search is then lexical. Returns the excerpts for the model.
create or replace function app.legal_search(p_session text, p_user uuid, p_request uuid, p_query text, p_vector text,
                                            p_jurisdiction text) returns jsonb
language plpgsql as $$
declare
  cfg jsonb; v_min double precision; v_chars int; v_mode text; v_best double precision;
  v_prev jsonb := '[]'; v_last uuid; v_searches int := 0; v_old_best double precision;
  v_next int; v_out jsonb := '[]'; v_new jsonb := '[]'; h record; v_n int; v_found jsonb;
begin
  select value into cfg from app.settings where key = 'legal.retrieval';
  cfg := coalesce(cfg, '{}');
  v_min := coalesce((select (value #>> '{}')::double precision from app.settings where key = 'legal.min_similarity'), 0);
  v_chars := coalesce((select (value #>> '{}')::int from app.settings where key = 'legal.excerpt_chars'), 0);
  v_mode := case when p_vector is null then 'lexical' else coalesce(cfg->>'mode', 'dense') end;

  select sources, request_id, searches, best_similarity into v_prev, v_last, v_searches, v_old_best
    from ai.legal_sessions where session_id = p_session for update;
  v_prev := coalesce(v_prev, '[]');
  if v_last is distinct from p_request then
    -- a new message: keep the excerpts of the previous request only (those the memory window can still show)
    v_prev := coalesce((select jsonb_agg(e order by (e->>'n')::int) from jsonb_array_elements(v_prev) e
                         where (e->>'request_id')::uuid is not distinct from v_last), '[]');
    v_searches := 0; v_old_best := null;
  end if;
  v_next := coalesce((select max((e->>'n')::int) from jsonb_array_elements(v_prev) e), 0) + 1;

  for h in
    select r.chunk_id, r.rank, r.dense_similarity, r.document_id, r.start_char, r.end_char, r.source_key, r.source_type,
           r.reliability, c.content, s.title, s.url, s.retrieved_at, s.cite_as, s.language,
           coalesce(r.article_ref, (select c2.article_ref from kb.chunks c2
                                     where c2.document_id = r.document_id and c2.strategy = 'structure_aware_v1'
                                       and c2.article_ref is not null and c2.start_char < r.end_char and c2.end_char > r.start_char
                                     order by least(c2.end_char, r.end_char) - greatest(c2.start_char, r.start_char) desc, c2.chunk_index
                                     limit 1)) as article
      from kb.search_chunks(coalesce(cfg->>'model', 'bge-m3'), coalesce(cfg->>'strategy', 'fixed_500_50'), p_vector::vector,
                            p_query, p_jurisdiction, coalesce((cfg->>'min_reliability')::smallint, 1::smallint),
                            coalesce((cfg->>'k')::int, 5), v_mode, coalesce((cfg->>'candidates')::int, 50)) r
      join kb.chunks c on c.id = r.chunk_id
      join kb.sources s on s.id = r.source_id
     order by r.rank
  loop
    v_best := greatest(v_best, h.dense_similarity);
    v_out := v_out || jsonb_build_array(jsonb_build_object('h', to_jsonb(h)));
  end loop;

  -- below the threshold (dense or hybrid search only): nothing is given to the model
  if v_mode <> 'lexical' and v_min > 0 and (v_best is null or v_best < v_min) then
    v_found := '[]';
  else
    v_found := '[]';
    for h in select (x->'h') as j from jsonb_array_elements(v_out) x loop
      select (e->>'n')::int into v_n from jsonb_array_elements(v_prev || v_new) e where e->>'chunk_id' = h.j->>'chunk_id' limit 1;
      if v_n is null then
        v_n := v_next; v_next := v_next + 1;
        v_new := v_new || jsonb_build_array(jsonb_build_object(
          'n', v_n, 'request_id', p_request, 'chunk_id', h.j->'chunk_id', 'document_id', h.j->'document_id',
          'start_char', h.j->'start_char', 'end_char', h.j->'end_char', 'source_key', h.j->'source_key',
          'title', h.j->'title', 'cite_as', h.j->'cite_as', 'url', h.j->'url', 'source_type', h.j->'source_type',
          'reliability', h.j->'reliability', 'article', h.j->'article', 'retrieved_at', h.j->'retrieved_at',
          'similarity', h.j->'dense_similarity'));
      else
        -- seen in an earlier message: it now belongs to this request too
        v_prev := (select jsonb_agg(case when (e->>'n')::int = v_n then e || jsonb_build_object('request_id', p_request) else e end
                                    order by (e->>'n')::int) from jsonb_array_elements(v_prev) e);
      end if;
      v_found := v_found || jsonb_build_array(jsonb_build_object(
        'n', v_n, 'source', h.j->>'title', 'type', h.j->>'source_type',
        'reliability', (h.j->>'reliability')::int, 'article', h.j->>'article',
        'text', case when v_chars > 0 then left(h.j->>'content', v_chars) else h.j->>'content' end));
    end loop;
  end if;

  insert into ai.legal_sessions (session_id, user_id, request_id, sources, searches, best_similarity, updated_at)
  values (p_session, p_user, p_request, v_prev || v_new, v_searches + 1, v_best, now())
  on conflict (session_id) do update set user_id = excluded.user_id, request_id = excluded.request_id,
    sources = excluded.sources, searches = excluded.searches,
    best_similarity = greatest(v_old_best, excluded.best_similarity), updated_at = now();

  return jsonb_build_object('found', jsonb_array_length(v_found), 'mode', v_mode,
                            'best_similarity', case when v_best is null then null else round(v_best::numeric, 4) end,
                            'below_threshold', v_mode <> 'lexical' and v_min > 0 and (v_best is null or v_best < v_min)
                                                and jsonb_array_length(v_out) > 0,
                            'excerpts', v_found);
end $$;

-- 5. The excerpts a request may cite (its own and those of the previous request that are still in the memory window),
--    and its search statistics, for the answer check.
create or replace function app.legal_sources_of(p_session text, p_request uuid) returns jsonb
language sql stable as $$
  select coalesce((select jsonb_build_object(
           'sources', sources, 'searches', case when request_id = p_request then searches else 0 end,
           'best_similarity', case when request_id = p_request then best_similarity end)
         from ai.legal_sessions where session_id = p_session),
         jsonb_build_object('sources', '[]'::jsonb, 'searches', 0, 'best_similarity', null))
$$;

-- 6. Which agent a message the router does not classify may follow up: the one with the most recent session within
--    match.followup_minutes ('match', 'legal' or null).
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

-- 7. Withdrawing consent deletes both conversations (spec 13.4).
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

revoke execute on function app.legal_agent_context(uuid), app.legal_search(text, uuid, uuid, text, text, text),
  app.legal_sources_of(text, uuid), app.agent_followup(uuid) from public;
grant execute on function app.legal_agent_context(uuid), app.legal_search(text, uuid, uuid, text, text, text),
  app.legal_sources_of(text, uuid), app.agent_followup(uuid) to n8n_worker;

-- migrate:down
create or replace function app.forget_conversation() returns trigger
language plpgsql as $$
begin
  if not new.granted and new.purpose in ('terms', 'privacy') then
    delete from agent_memory.chat_histories where session_id = 'user:' || new.user_id::text;
    delete from ai.match_sessions where user_id = new.user_id;
  end if;
  return new;
end $$;
drop function if exists app.agent_followup(uuid);
drop function if exists app.legal_sources_of(text, uuid);
drop function if exists app.legal_search(text, uuid, uuid, text, text, text);
drop function if exists app.legal_agent_context(uuid);
drop table if exists ai.legal_sessions;
delete from app.settings where key in ('legal.agent_enabled', 'legal.agent_max_iterations', 'legal.agent_memory_turns',
  'legal.num_ctx', 'legal.retrieval', 'legal.min_similarity', 'legal.excerpt_chars', 'legal.agent_answer_max_chars');
