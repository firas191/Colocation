// wf.documents.tool > "Plan": one tool of the Document agent (A6). household_facts and template_slots answer from the
// database facts and the templates; propose_document checks the values against the template's slots (unknown slots
// dropped, values the database gives ignored) and asks the next node to store the draft. Nothing is rendered here.
/* @include lib/doc_fill.js */
const ALL = __DOC_TEMPLATES__;
const s = $('Start').first().json;
const fr = ($input.first().json || {}).r || null;
if (!fr || fr.error) return [{ json: { store: false, answer: { error: 'household_not_found' } } }];
const H = fr.data;
const F = H.facts || {};
const offered = templatesFor(ALL, H.jurisdiction_code).filter((t) => t.kind !== 'rent_receipt');
let args = {};
try { args = typeof s.args === 'string' && s.args.trim() ? JSON.parse(s.args) : (s.args || {}); } catch (e) { args = {}; }
const tool = String(s.tool || '');
if (tool === 'household_facts') {
  return [{ json: { store: false, answer: { country: H.jurisdiction_code, today: H.today, flatmates: F.occupants || null, owner_member: F.landlord || null,
    address_known: !!F.address, house_rules: Array.isArray(F.rules) ? F.rules.length : 0, documents_offered: offered.map((t) => t.kind) } } }];
}
const tpl = offered.find((t) => t.kind === String(args.kind || s.kind || ''));
if (!tpl) return [{ json: { store: false, answer: { error: 'kind_not_offered', offered: offered.map((t) => t.kind) } } }];
const userSlots = tpl.slots.filter((x) => x.from === 'user' || (x.from === 'household' && !F[x.name]));
if (tool === 'template_slots') {
  return [{ json: { store: false, answer: { kind: tpl.kind, languages: tpl.languages,
    filled_by_platform: tpl.slots.filter((x) => !userSlots.includes(x)).map((x) => x.name),
    to_ask: userSlots.map((x) => ({ name: x.name, type: x.type, required: !!x.required, ...(x.columns ? { columns: x.columns } : {}) })) } } }];
}
if (tool !== 'propose_document') return [{ json: { store: false, answer: { error: 'unknown_tool' } } }];
let vals = args.values;
if (typeof vals === 'string') { try { vals = JSON.parse(vals); } catch (e) { vals = {}; } }
vals = vals && typeof vals === 'object' && !Array.isArray(vals) ? vals : {};
const allowed = new Set(userSlots.map((x) => x.name));
const kept = Object.fromEntries(Object.entries(vals).filter(([k]) => allowed.has(k)));
const dropped = Object.keys(vals).filter((k) => !allowed.has(k));
const merged = { ...Object.fromEntries(tpl.slots.filter((x) => x.from !== 'user').map((x) => [x.name, F[x.name]])), ...kept };
const c = checkValues(tpl, merged, { exponent: H.exponent, currency: H.currency });
const userValues = Object.fromEntries(Object.entries(kept).filter(([k]) => c.values[k] !== undefined));
const language = tpl.languages.includes(String(args.language || s.language)) ? String(args.language || s.language) : tpl.languages[0];
return [{ json: { store: true, dropped, missing: c.missing,
  params: [s.user_id, JSON.stringify({ household_id: s.household_id, kind: tpl.kind, language, values: userValues, missing: c.missing })] } }];
