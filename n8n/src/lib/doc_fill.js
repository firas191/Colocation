// Document templates (platform P9, D-108): kb/templates/<CODE>/<kind>.json, built into the Code nodes. Plain code, no
// model: which templates a country has, which slots are still empty, and the HTML the Media service turns into a PDF.
// Only slot values are added to a template's text; every value is escaped; a value for an unknown slot is dropped.

const DOC_LANGS = ['fr', 'ar', 'en'];
const NOTICE = {
  fr: "Modèle généré par la plateforme. Ce n'est pas un conseil juridique : lisez les textes cités et, en cas de doute, demandez à un professionnel du droit.",
  ar: 'نموذج أنشأته المنصة. هذه ليست استشارة قانونية: اقرأ النصوص المذكورة واستشر مختصًا في القانون عند الشك.',
  en: 'A model made by the platform. It is not legal advice: read the texts cited and, if in doubt, ask a legal professional.',
};
const LABELS = {
  fr: { country: 'Pays', template: 'Modèle', sources: 'Sources (lues le)', none: 'Aucune source : ce document ne contient pas de règle de droit.',
        generated: 'Établi le', room: 'Pièce', item: 'Élément', condition: 'État', notes: 'Remarques', name: 'Nom', share: 'Part',
        category: 'Sujet', text: 'Règle', topic: 'Sujet', agreement: 'Où en est-on', label: 'Poste', amount: 'Montant',
        due_day: 'Jour du mois', title: 'Tâche', frequency: 'Fréquence', next: 'Prochaine fois',
        daily: 'chaque jour', weekly: 'chaque semaine', biweekly: 'toutes les deux semaines', monthly: 'chaque mois' },
  ar: { country: 'البلد', template: 'النموذج', sources: 'المصادر (تاريخ القراءة)', none: 'لا مصدر: هذه الوثيقة لا تتضمن قاعدة قانونية.',
        generated: 'حُرّر بتاريخ', room: 'الغرفة', item: 'العنصر', condition: 'الحالة', notes: 'ملاحظات', name: 'الاسم', share: 'الحصة',
        category: 'الموضوع', text: 'القاعدة', topic: 'الموضوع', agreement: 'أين وصلنا', label: 'البند', amount: 'المبلغ',
        due_day: 'يوم الشهر', title: 'المهمة', frequency: 'التكرار', next: 'المرة القادمة',
        daily: 'كل يوم', weekly: 'كل أسبوع', biweekly: 'كل أسبوعين', monthly: 'كل شهر' },
  en: { country: 'Country', template: 'Template', sources: 'Sources (read on)', none: 'No source: this document states no rule of law.',
        generated: 'Made on', room: 'Room', item: 'Item', condition: 'Condition', notes: 'Notes', name: 'Name', share: 'Share',
        category: 'Topic', text: 'Rule', topic: 'Topic', agreement: 'Where we are', label: 'Item', amount: 'Amount',
        due_day: 'Day of the month', title: 'Chore', frequency: 'How often', next: 'Next time',
        daily: 'every day', weekly: 'every week', biweekly: 'every two weeks', monthly: 'every month' },
};
const ITEM_COLUMNS = ['room', 'item', 'condition', 'notes'];

// a value kept left to right inside Arabic text (dates, amounts, Latin names): without it "2026-10-17" shows as
// "17-10-2026" and "450.000 TND" as "TND 450.000"
const AR = /[\u0600-\u06ff]/;
const iso = (v) => (AR.test(String(v)) ? `<span class="rtl">${esc(v)}</span>` : `<span class="ltr" dir="ltr">${esc(v)}</span>`);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Templates a country offers: its own, then GLOBAL ones for kinds it does not have. A legal template needs sources. */
function templatesFor(all, jurisdiction) {
  const own = all.filter((t) => t.jurisdiction === jurisdiction && (!t.legal || (t.sources || []).length > 0));
  const kinds = new Set(own.map((t) => t.kind));
  return [...own, ...all.filter((t) => t.jurisdiction === 'GLOBAL' && !kinds.has(t.kind))];
}

/** One slot value, checked and formatted for the text; undefined when empty or not valid. */
function slotValue(slot, v, ctx) {
  if (v === undefined || v === null || v === '') return undefined;
  switch (slot.type) {
    case 'money': {
      const n = Number(v);
      if (!Number.isSafeInteger(n) || n <= 0) return undefined;
      const e = Number.isInteger(ctx.exponent) ? ctx.exponent : 2;
      return `${(n / 10 ** e).toFixed(e)} ${ctx.currency || ''}`.trim();
    }
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? String(v) : undefined;
    case 'period':
      return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v)) ? String(v) : undefined;
    case 'integer': {
      const n = Number(v);
      if (!Number.isInteger(n) || (slot.min !== undefined && n < slot.min) || (slot.max !== undefined && n > slot.max)) return undefined;
      return String(n);
    }
    case 'items': {
      if (!Array.isArray(v) || v.length === 0) return undefined;
      const cols = slot.columns || ITEM_COLUMNS;
      const rows = v.slice(0, slot.max || 80).filter((r) => r && typeof r === 'object')
        .map((r) => Object.fromEntries(cols.map((c) => [c, String(r[c] ?? '').trim().slice(0, 300)])))
        .filter((r) => cols.some((c) => r[c]));
      return rows.length ? { rows, cols } : undefined;
    }
    default: {
      const s = String(v).replace(/\s+/g, ' ').trim().slice(0, 600);
      return s || undefined;
    }
  }
}

/** Values for a template: known slots only, checked; missing = required slots still empty. */
function checkValues(tpl, values, ctx) {
  const out = {};
  const missing = [];
  const dropped = Object.keys(values || {}).filter((k) => !(tpl.slots || []).some((s) => s.name === k));
  for (const s of tpl.slots || []) {
    const v = slotValue(s, (values || {})[s.name], ctx || {});
    if (v === undefined) { if (s.required) missing.push(s.name); } else out[s.name] = v;
  }
  return { values: out, missing, dropped };
}

function table(v, lang) {
  const L = LABELS[lang] || LABELS.en;
  const head = v.cols.map((c) => `<th>${esc(L[c] || c)}</th>`).join('');
  // a chore's frequency is a code in the data; the table says it in words (living plan, D-115)
  const cell = (c, x) => (c === 'frequency' && L[x] ? L[x] : x);
  const body = v.rows.map((r) => `<tr>${v.cols.map((c) => `<td>${esc(cell(c, r[c]))}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** The document HTML (self-contained: no link, image or font from elsewhere). meta: {country, generated_on, notice_version}. */
function renderHtml(tpl, lang, checked, meta) {
  const T = tpl.text[lang];
  const L = LABELS[lang] || LABELS.en;
  const fillText = (p) => esc(p).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => {
    const v = checked[k];
    if (v === undefined) return '';
    return typeof v === 'object' ? '' : (lang === 'ar' ? iso(v) : esc(v));
  });
  const lone = (p) => /^\{\{\s*([a-z_]+)\s*\}\}$/.exec(String(p || '').trim());
  const paras = T.paragraphs.map((p, i) => {
    // a heading line (no slot) just before a table that is empty is left out with it (living plan, D-115)
    const nx = lone(T.paragraphs[i + 1]);
    if (!/\{\{/.test(p) && nx && !(checked[nx[1]] && typeof checked[nx[1]] === 'object')) return '';
    const only = lone(p);
    if (only) {
      const v = checked[only[1]];
      return v && typeof v === 'object' ? table(v, lang) : '';
    }
    // a paragraph whose optional slot is empty is left out rather than printed with a gap
    const slots = [...p.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]);
    if (slots.some((k) => checked[k] === undefined)) return '';
    return `<p>${fillText(p)}</p>`;
  }).filter(Boolean).join('\n');
  const sources = (tpl.sources || []).length
    ? `<ol>${tpl.sources.map((s) => `<li dir="ltr" class="src">${esc(s.cite_as)}: ${esc(s.title)}. ${esc(s.publisher)}. <span dir="ltr">${esc(s.url)}</span> (${esc(s.retrieved_at)})</li>`).join('')}</ol>`
    : `<p>${esc(L.none)}</p>`;
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  return `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><title>${esc(T.title)}</title><style>
@page{size:A4;margin:18mm 16mm}body{font-family:"DejaVu Sans",sans-serif;font-size:10.5pt;line-height:1.45;color:#111}
h1{font-size:17pt;margin:0 0 4mm}.meta{font-size:8.5pt;color:#444;margin-bottom:6mm}table{width:100%;border-collapse:collapse;margin:3mm 0}
th,td{border:0.5pt solid #777;padding:1.5mm 2mm;text-align:start;vertical-align:top}th{background:#eee}
h2{font-size:11pt;margin:8mm 0 2mm}.notice{font-size:8.5pt;color:#333;border-top:0.5pt solid #999;margin-top:8mm;padding-top:2mm}
ol{padding-inline-start:5mm;font-size:8.5pt}.ltr{direction:ltr;unicode-bidi:embed}.src{direction:ltr;text-align:left}</style></head><body>
<h1>${esc(T.title)}</h1>
<p class="meta">${esc(L.country)}: ${lang === 'ar' ? iso(meta.country) : esc(meta.country)} · ${esc(L.template)}: ${lang === 'ar' ? iso(`${tpl.key} v${tpl.version}`) : `${esc(tpl.key)} v${esc(tpl.version)}`} · ${esc(L.generated)} ${lang === 'ar' ? iso(meta.generated_on) : esc(meta.generated_on)}</p>
${paras}
<h2>${esc(L.sources)}</h2>
${sources}
<p class="notice">${esc(NOTICE[lang] || NOTICE.en)} ${lang === 'ar' ? iso(`(${meta.notice_version})`) : `(${esc(meta.notice_version)})`}</p>
</body></html>`;
}

if (typeof module !== 'undefined') module.exports = { templatesFor, checkValues, renderHtml, slotValue, DOC_LANGS, NOTICE, esc };
