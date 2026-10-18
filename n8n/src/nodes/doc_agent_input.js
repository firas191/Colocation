// wf.api.documents_assistant > "Agent input" (platform P9, D-108): the Document agent (A6) for one household. The
// person's message with e-mails and phone numbers masked (agent_check.fallbackMask; names stay, the templates need
// the household's names, which come from the database anyway), the active P9_document_agent version, and the kinds the
// household's country offers (the rent receipt is made from a confirmed payment on the page, not here).
/* @include lib/agent_check.js */
/* @include lib/doc_fill.js */
const ALL = __DOC_TEMPLATES__;
const v = $('Validate').first().json;
const row = $input.first().json || {};
const fr = row.r || null;
const pr = row.p || null;
const cfg = row.cfg || {};
const gw = v.gw;
if (!fr || fr.error) {
  return [{ json: { ok: false, gw, status: fr ? fr.status : 500, error: fr ? { ...fr.error, details: fr.error.details || [] }
    : { code: 'INTERNAL', message: 'Internal error', details: [] } } }];
}
const H = fr.data;
const kinds = templatesFor(ALL, H.jurisdiction_code).map((t) => t.kind).filter((k) => k !== 'rent_receipt');
const base = { gw, household_id: H.household_id, user_id: gw.ctx.user_id, request_id: gw.request_id || gw.ctx.request_id || null,
  t0: Date.now(), since: new Date().toISOString(), session_id: `docs:${gw.ctx.user_id}:${H.household_id}`,
  model: (pr && pr.model) || cfg['llm.default_model'] || null, keep_alive: cfg['llm.keep_alive'] || '10m',
  num_ctx: Number(cfg['documents.num_ctx'] || 8192), max_iterations: Number(cfg['documents.agent_max_iterations'] || 6),
  memory_turns: Number(cfg['documents.agent_memory_turns'] || 4), prompt_version_id: pr ? pr.version_id : null };
if (String(cfg['documents.agent_enabled'] ?? 'true') !== 'true') {
  return [{ json: { ok: false, gw, status: 503, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'The document assistant is off', details: [{ issue: 'agent_off' }] } } }];
}
const m = pr && /##\s*system\s*\n([\s\S]*?)\n##\s*user\s*\n([\s\S]*)$/i.exec(pr.template || '');
if (!m) return [{ json: { ok: false, gw, status: 503, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'The document assistant is unavailable', details: [{ issue: 'prompt_missing' }] } } }];
const text = fallbackMask(String((v.input.body || {}).text || '')).replace(/<\/?message>/gi, (t) => t.replace('<', '‹').replace('>', '›'));
const lang = ((v.gw.ctx || {}).lang || 'fr').slice(0, 2);
const vars = { message: text, jurisdiction: H.jurisdiction_code, today: String(H.today), language: ['fr', 'ar', 'en'].includes(lang) ? lang : 'fr',
  kinds: kinds.join(', ') };
const fill = (t) => t.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (x, k) => (k in vars ? String(vars[k]) : x));
return [{ json: { ...base, ok: true, language: vars.language, kinds, system: fill(m[1].trim()), prompt: fill(m[2].trim()),
  num_predict: (pr.params || {}).num_predict || 400 } }];
