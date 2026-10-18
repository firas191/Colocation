// wf.api.document_templates > "Build result" (platform P9, D-108): the document types a country offers, with their
// slots and sources, and the legal types it does not offer yet (no primary source read for that country).
/* @include lib/doc_fill.js */
const ALL = __DOC_TEMPLATES__;
const v = $input.first().json;
const user = (v.gw.ctx || {}).user || {};
const j = (v.input.query || {}).jurisdiction || user.jurisdiction_code || null;
const offered = j ? templatesFor(ALL, j) : [];
const kinds = ['flatmate_agreement', 'inventory_entry', 'inventory_exit', 'rent_receipt', 'house_rules'];
return [{ json: { ok: true, gw: v.gw, status: 200, data: {
  jurisdiction: j,
  items: offered.map((t) => ({ key: t.key, kind: t.kind, version: t.version, legal: !!t.legal, languages: t.languages,
    slots: t.slots.map((s) => ({ name: s.name, type: s.type, from: s.from, required: !!s.required, ...(s.columns ? { columns: s.columns } : {}),
      ...(s.max !== undefined ? { max: s.max } : {}), ...(s.min !== undefined ? { min: s.min } : {}) })),
    sources: t.sources })),
  not_available: kinds.filter((k) => !offered.some((t) => t.kind === k)) } } }];
