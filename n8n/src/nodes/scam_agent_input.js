// wf.scam.check > "Agent input"
// The system message is the active P8_scam_agent version from the prompt registry, with its variables filled in; the
// user part (the listing between <message> tags) is what the agent receives. No memory: each check is independent.
const s = $('Start').first().json;
const c = $('Context').first().json.ctx;
const k = $('Agent context').first().json;
const p = k.prompt_row || {};
const template = p.template || p.body || '';
const params = p.params || {};
const base = { listing_id: c.listing_id, model: s.model || k.model, num_ctx: k.num_ctx, keep_alive: '10m',
  max_iterations: 6, t0: Date.now(), prompt_version_id: p.version_id || p.id || null, prompt_version: p.version || null };
if (!template) return [{ json: { ...base, ok: false, error_code: 'prompt_missing', prompt_keys: Object.keys(p) } }];
const vars = { message: c.text || '', jurisdiction: c.jurisdiction_code || 'unknown', today: new Date().toISOString().slice(0, 10) };
const fill = (t) => t.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, n) => (n in vars ? String(vars[n]) : m));
const m = /##\s*system\s*\n([\s\S]*?)\n##\s*user\s*\n([\s\S]*)$/i.exec(template);
if (!m) return [{ json: { ...base, ok: false, error_code: 'prompt_invalid' } }];
return [{ json: { ...base, ok: true, system: fill(m[1].trim()), text: fill(m[2].trim()), num_predict: params.num_predict || 200 } }];
