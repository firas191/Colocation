// wf.api.flatmate_assistant > "Agent input" (platform P12, D-115): the profile agent A7 (P13_flatmate_onboarding,
// adapted from Yosr's onboarding agent). The person's message with e-mails and phone numbers masked, the country's
// currency, and the person's language. Memory per person (session flatmate:<user>, as the Document agent's).
/* @include lib/agent_check.js */
const v = $('Validate').first().json;
const row = $input.first().json || {};
const st = row.st || null;
const pr = row.p || null;
const cfg = row.cfg || {};
const gw = v.gw;
if (!st) return [{ json: { ok: false, gw, status: 404, error: { code: 'NOT_FOUND', message: 'User not found', details: [] } } }];
if (String(cfg['flatmate_agent.enabled'] ?? 'true') !== 'true') {
  return [{ json: { ok: false, gw, status: 503, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'The profile assistant is off', details: [{ issue: 'agent_off' }] } } }];
}
const m = pr && /##\s*system\s*\n([\s\S]*?)\n##\s*user\s*\n([\s\S]*)$/i.exec(pr.template || '');
if (!m) return [{ json: { ok: false, gw, status: 503, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'The profile assistant is unavailable', details: [{ issue: 'prompt_missing' }] } } }];
const raw = String((v.input.body || {}).text || '');
const text = fallbackMask(raw).replace(/<\/?message>/gi, (t) => t.replace('<', '‹').replace('>', '›'));
const lang = ((gw.ctx || {}).lang || 'fr').slice(0, 2);
const language = { fr: 'French', en: 'English', ar: 'Arabic' }[lang] || 'French';
const vars = { message: text, today: new Date().toISOString().slice(0, 10), language, currency: (st.user || {}).currency || 'TND' };
const fill = (t) => t.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (x, k) => (k in vars ? String(vars[k]) : x));
return [{ json: { ok: true, gw, user_id: gw.ctx.user_id, t0: Date.now(), text, session_id: `flatmate:${gw.ctx.user_id}`,
  model: (pr && pr.model) || cfg['llm.default_model'] || null, keep_alive: cfg['llm.keep_alive'] || '10m',
  num_ctx: Number(cfg['flatmate_agent.num_ctx'] || 8192), max_iterations: Number(cfg['flatmate_agent.max_iterations'] || 6),
  memory_turns: Number(cfg['flatmate_agent.memory_turns'] || 8), prompt_version_id: pr ? pr.version_id : null,
  missing_before: st.missing || [], system: fill(m[1].trim()), prompt: fill(m[2].trim()), num_predict: (pr.params || {}).num_predict || 400 } }];
