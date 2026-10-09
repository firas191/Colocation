-- migrate:up
-- A3 Match agent answers (D-085): longest answer kept, read by the agent workflow through app.match_agent_context.
-- On the owner's PC (T-48) answers ran to 1,088 characters against "one or two sentences" in the prompt.

insert into app.settings (key, value, description) values
  ('match.agent_answer_max_chars', '400', 'Longest Match agent answer shown; a longer one is cut at the last sentence that fits (Markdown removed first)')
on conflict (key) do nothing;

create or replace function app.match_agent_context(p_user uuid) returns jsonb
language plpgsql as $$
declare s jsonb; v record; v_days int;
begin
  select jsonb_object_agg(key, value #>> '{}') into s from app.settings
   where key in ('match.agent_enabled', 'match.agent_max_iterations', 'match.agent_memory_turns', 'match.agent_memory_days',
                 'match.agent_answer_max_chars', 'llm.default_model', 'llm.keep_alive', 'llm.num_ctx');
  v_days := coalesce((s->>'match.agent_memory_days')::int, 30);
  delete from agent_memory.chat_histories where created_at < now() - make_interval(days => v_days);
  select pv.id, pv.version, pv.template, pv.params, pv.model into v
    from ai.prompt_versions pv join ai.prompts p on p.id = pv.prompt_id
   where p.name = 'P6_match_agent' and pv.status = 'active';
  return jsonb_build_object(
    'enabled', coalesce(s->>'match.agent_enabled', 'true') = 'true',
    'max_iterations', coalesce((s->>'match.agent_max_iterations')::int, 4),
    'answer_max_chars', coalesce((s->>'match.agent_answer_max_chars')::int, 400),
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

-- migrate:down
delete from app.settings where key = 'match.agent_answer_max_chars';

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
