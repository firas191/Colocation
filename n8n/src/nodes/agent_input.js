// wf.match.agent > "Agent input"
// Input (Start): {text (masked copy of the message), language, script, jurisdiction, today, user_id, request_id}.
// The system message is the active P6_match_agent version from the prompt registry, with its variables filled in;
// the user section (the message between <message> tags) is what the agent receives and what the memory keeps.
const s = $('Start').first().json;
const c = $('Context').first().json.c || {};
const base = { session_id: c.session_id, user_id: s.user_id, request_id: s.request_id, jurisdiction: s.jurisdiction,
  today: s.today, model: c.model, keep_alive: c.keep_alive, num_ctx: c.num_ctx, max_iterations: c.max_iterations,
  memory_turns: c.memory_turns, memory_messages: c.memory_messages, memory_text: c.memory_text || '',
  answer_max_chars: c.answer_max_chars || 400, t0: Date.now() };
if (!c.prompt) return [{ json: { ...base, ok: false, error_code: 'prompt_missing' } }];
const vars = { message: s.text, jurisdiction: s.jurisdiction || 'unknown', today: s.today, language: s.language || 'fr',
  script: s.script || 'latin' };
const fill = (t) => t.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) => (k in vars ? String(vars[k]) : m));
const m = /##\s*system\s*\n([\s\S]*?)\n##\s*user\s*\n([\s\S]*)$/i.exec(c.prompt.template);
if (!m) return [{ json: { ...base, ok: false, error_code: 'prompt_invalid' } }];
const params = c.prompt.params || {};
return [{ json: { ...base, ok: true, system: fill(m[1].trim()), text: fill(m[2].trim()),
  prompt_version_id: c.prompt.version_id, prompt_version: c.prompt.version, num_predict: params.num_predict || 400 } }];
