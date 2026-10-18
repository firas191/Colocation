// wf.api.documents_create > "Fill" (platform P9, D-108): the template of the household's country for the kind asked,
// filled from the database facts (household, confirmed payment) and the person's values (or the confirmed draft of the
// Document agent). A required slot still empty: 422 with each missing slot. Values for unknown slots are dropped.
/* @include lib/doc_fill.js */
const ALL = __DOC_TEMPLATES__;
const v = $('Validate').first().json;
const gw = v.gw;
const b = v.input.body || {};
const fr = ($input.first().json || {}).r || null;
const reject = (status, code, message, details = []) => [{ json: { ok: false, gw, status, error: { code, message, details } } }];
if (!fr || fr.error) return reject(fr ? fr.status : 500, fr ? fr.error.code : 'INTERNAL', fr ? fr.error.message : 'Internal error', fr ? fr.error.details || [] : []);
let draft = null;
try { draft = ($('Draft').first().json || {}).r || null; } catch (e) { draft = null; }
if (b.draft_id && (!draft || draft.error)) return reject(404, 'NOT_FOUND', 'Draft not found');
const H = fr.data;
const kind = draft && draft.data ? draft.data.kind : b.kind;
const lang = (draft && draft.data ? draft.data.language : b.language) || 'fr';
const tpl = templatesFor(ALL, H.jurisdiction_code).find((t) => t.kind === kind);
if (!tpl) return reject(422, 'VALIDATION_FAILED', 'Request is invalid', [{ field: 'kind', issue: 'not_available_for_country', jurisdiction: H.jurisdiction_code }]);
if (!tpl.languages.includes(lang)) return reject(422, 'VALIDATION_FAILED', 'Request is invalid', [{ field: 'language', issue: 'not_available', allowed: tpl.languages }]);
const given = (draft && draft.data ? draft.data.values : b.values) || {};
const facts = H.facts || {};
const values = {};
for (const s of tpl.slots) {
  // database facts win; a household fact that is empty (an address not given) may be typed by the person
  const f = facts[`${s.name}_${lang}`] ?? facts[s.name];     // a fact in the document's language first (living plan habits)
  if (s.from === 'user') values[s.name] = given[s.name];
  else if (f !== undefined && f !== null && f !== '') values[s.name] = f;
  else if (s.from === 'household') values[s.name] = given[s.name];
}
for (const k of Object.keys(given)) if (!(k in values)) values[k] = given[k];
const c = checkValues(tpl, values, { exponent: H.exponent, currency: H.currency });
if (c.missing.length) {
  return reject(422, 'VALIDATION_FAILED', 'Request is invalid', c.missing.map((m) => ({ field: m, issue: 'required' })));
}
const html = renderHtml(tpl, lang, c.values, { country: H.country || H.jurisdiction_code, generated_on: String(H.today), notice_version: H.notice_version });
const row = $('Facts').first().json || {};
const cfg = row.cfg || {};
const key = `documents/${H.household_id}/${row.new_id}.pdf`;
return [{ json: { ok: true, gw, dropped: c.dropped,
  url: `${String(cfg['services.media_url'] || '').replace(/\/+$/, '')}/v1/pdf/render`, body: { html, key },
  store: { household_id: H.household_id, kind, jurisdiction_code: tpl.jurisdiction === 'GLOBAL' ? H.jurisdiction_code : tpl.jurisdiction,
    language: lang, template_key: tpl.key, template_version: tpl.version, inputs: c.values, sources: tpl.sources,
    notice_version: H.notice_version, payment_id: facts.payment_id || null, draft_id: draft && draft.data ? draft.data.draft_id : null } } }];
