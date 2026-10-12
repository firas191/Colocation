// wf.legal.agent > "Prefetch plan" (D-089): the user's question itself is searched before the model runs, with the
// configuration measured in RETRIEVAL_EVAL (T-21). On the PC (T-55) the model skipped the search for 6 of 39
// answerable questions (5 of the 6 in Arabic), and its own rewritten queries found a gold passage for 18 of 33.
const s = $('Start').first().json;
const cfg = $input.first().json.cfg || {};
let r = {};
try { r = typeof cfg['legal.retrieval'] === 'string' ? JSON.parse(cfg['legal.retrieval']) : (cfg['legal.retrieval'] || {}); } catch (e) { r = {}; }
const q = String(s.text || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
return [{ json: { t0: Date.now(), q, url: `${String(cfg['ollama.base_url'] || '').replace(/\/+$/, '')}/api/embed`,
  body: { model: r.model || 'bge-m3', input: [q], truncate: true, keep_alive: cfg['llm.keep_alive'] || '10m' } } }];
