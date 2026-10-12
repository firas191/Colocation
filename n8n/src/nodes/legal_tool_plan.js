// wf.legal.tool_search > "Plan": the query the agent wrote, embedded with the model of legal.retrieval (bge-m3 through
// Ollama, as when the knowledge base was embedded).
const s = $('Start').first().json;
const cfg = $input.first().json.cfg || {};
let r = {};
try { r = typeof cfg['legal.retrieval'] === 'string' ? JSON.parse(cfg['legal.retrieval']) : (cfg['legal.retrieval'] || {}); } catch (e) { r = {}; }
const q = String(s.query || '').replace(/\s+/g, ' ').trim().slice(0, 500);
return [{ json: { t0: Date.now(), q, url: `${String(cfg['ollama.base_url'] || '').replace(/\/+$/, '')}/api/embed`,
  body: { model: r.model || 'bge-m3', input: [q], truncate: true, keep_alive: cfg['llm.keep_alive'] || '10m' } } }];
