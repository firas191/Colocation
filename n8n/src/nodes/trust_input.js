// wf.trust.assess > "Rules" (platform P8, D-107)
// The facts the database checked (app.trust_facts), the phrase lists of the packs over the listing text, and the
// model's input. trust.model (D-114) says what reads the wording: the Trust agent (active P4_trust_assessor version,
// the listing text between <message> tags) or the single-call detector P8_scam_detector (wf.llm.call).
/* @include lib/trust_rules.js */
const PHRASES = compilePhrases(__TRUST_PHRASES__);
const s = $('Start').first().json;
const row = $input.first().json || {};
const f = row.f || null;
const cfg = row.cfg || {};
const pr = row.p || null;
if (!f) return [{ json: { ok: false, error_code: 'listing_not_found', agent: false } }];
const L = f.listing || {};
const text = [L.title, L.description].filter(Boolean).join('\n');
const rules = scanText(text, PHRASES, ['GLOBAL', L.jurisdiction_code]);
const mode = String(cfg['trust.model'] || 'agent') === 'detector' ? 'detector' : 'agent';
const base = { ok: true, listing_id: L.listing_id, request_id: s.request_id || null, text, rules, db_signals: f.signals || [], mode,
  rent: { rent_minor: L.rent_minor, exponent: L.exponent, rent_period: L.rent_period, currency: L.currency },
  t0: Date.now(), model: (pr && pr.model) || cfg['llm.default_model'] || null, keep_alive: cfg['llm.keep_alive'] || '10m',
  num_ctx: Number(cfg['trust.num_ctx'] || 8192), max_iterations: Number(cfg['trust.agent_max_iterations'] || 6),
  prompt_version_id: pr ? pr.version_id : null, prompt_version: pr ? pr.version : null };
const enabled = String(cfg['trust.agent_enabled'] ?? 'true') === 'true';
const m = pr && /##\s*system\s*\n([\s\S]*?)\n##\s*user\s*\n([\s\S]*)$/i.exec(pr.template || '');
// the agent reads the wording; with no text, no prompt or the agent off, the rules and the database decide alone
if (enabled && mode === 'detector' && text.trim()) {
  // one call of P8_scam_detector; wf.llm.call loads the active version and checks the answer against its schema
  return [{ json: { ...base, agent: false, detector: true, detector_input: { prompt: 'P8_scam_detector', vars: {
    message: text, jurisdiction: L.jurisdiction_code || 'unknown', today: new Date().toISOString().slice(0, 10) },
    meta: { listing_id: L.listing_id, request_id: s.request_id || null } } } }];
}
const why = !enabled ? 'agent_off' : !pr ? 'prompt_missing' : !m ? 'prompt_invalid' : !text.trim() ? 'no_text' : null;
if (why) return [{ json: { ...base, agent: false, detector: false, skip_reason: why } }];
// the listing text is the owner's: the <message> tags inside it are neutralised so it cannot close the block
const safe = text.replace(/<\/?message>/gi, (t) => t.replace('<', '‹').replace('>', '›'));
// found (P4 v2, T-79): the phrase-list findings, so the agent does not have to look for them with a tool
const found = rules.length ? [...new Set(rules.map((x) => x.signal))].join(', ') : 'nothing';
const vars = { message: safe, jurisdiction: L.jurisdiction_code || 'unknown', today: new Date().toISOString().slice(0, 10),
  language: 'fr', found };
const fill = (t) => t.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (x, k) => (k in vars ? String(vars[k]) : x));
const params = pr.params || {};
return [{ json: { ...base, agent: true, detector: false, system: fill(m[1].trim()), prompt: fill(m[2].trim()), num_predict: params.num_predict || 600 } }];
