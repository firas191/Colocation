// Deterministic checks after P3 (spec 9.4 post-validation, D-076). The model gives amounts in main
// units. A rent outside the plausible range for its currency (main units per month; weekly rents
// are compared as 52/12 of a week) is set to null with an issue: this catches scale errors such as
// 1,225,000 dinars for 1,225 (spec 3.1). A deposit is checked against the same range; 0 is
// accepted. Issues added here are codes, never sentences (spec 17.1).
//
// out: the validated P3 output; ranges: {currency: [min, max]} from the setting listing.rent_range;
// fallbackCurrency: the jurisdiction's currency, used when an amount has none; text: the listing text,
// for the date check (optional: without it the date is not checked).
// An availability date is kept only when the text says something about when (a date, a month, a weekday,
// "libre", "dispo", "now", "توا"...): with nothing of the kind the model invented it, usually today (D-083).
// Returns {fields, issues, changed}: fields is a copy of out with the checks applied.
const MONTHS = 'janvier|janv|fevrier|fevr|fev|mars|avril|avr|mai|juin|juillet|juil|aout|septembre|sept|octobre|oct|novembre|nov|decembre|dec|' +
  'january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|october|november|december';
const WHEN_WORDS = 'libre|libres|dispo|dispos|disponible|disponibles|disponibilite|immediat|immediate|immediatement|de suite|tout de suite|' +
  'des maintenant|maintenant|a partir|a compter|rentree|semaine prochaine|mois prochain|debut|mi|fin|lundi|mardi|mercredi|jeudi|vendredi|' +
  'samedi|dimanche|available|availability|from|now|immediately|asap|move in|move-in|next week|next month|monday|tuesday|wednesday|' +
  'thursday|friday|saturday|sunday|tawa|tawwa|taw|mel|men|ba3d|awel|ekher|jenfi|fifri|avril|juan|juillet|out';
const WHEN_RE = new RegExp(`(?<![\\p{L}\\p{N}])(${MONTHS}|${WHEN_WORDS})(?![\\p{L}\\p{N}])`, 'iu');
const DATE_RE = /(?<![\d])\d{1,2}\s*[\/.-]\s*\d{1,2}(\s*[\/.-]\s*\d{2,4})?(?![\d])|(?<![\d])(19|20)\d{2}(?![\d])|(?<![\d])\d{1,2}\s*(er|eme|e|st|nd|rd|th)(?![\p{L}])/iu;
const WHEN_AR = /جانفي|فيفري|مارس|أفريل|افريل|ماي|جوان|جويلية|أوت|اوت|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر|يناير|فبراير|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|متوفر|متوفرة|متاح|متاحة|توا|حالا|فورا|فوري|فورية|مباشرة|ابتداء|ابتداءً|بداية|نهاية|الشهر|الأسبوع|الاسبوع|السبت|الأحد|الاحد|الاثنين|الإثنين|الثلاثاء|الأربعاء|الاربعاء|الخميس|الجمعة/;

function dateMentioned(text) {
  const t = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return WHEN_RE.test(t) || DATE_RE.test(t) || WHEN_AR.test(String(text || ''));
}

function checkListing(out, ranges, fallbackCurrency, text) {
  if (!out || typeof out !== 'object') return { fields: out, issues: [], changed: [] };
  const f = JSON.parse(JSON.stringify(out));
  const issues = [];
  const changed = [];
  const R = ranges || {};
  if (f.rent_amount !== null && f.rent_amount !== undefined) {
    if (!f.rent_currency) { f.rent_currency = fallbackCurrency || null; issues.push('rent_currency_assumed'); changed.push('rent_currency'); }
    if (!f.rent_period) { f.rent_period = 'month'; changed.push('rent_period'); }
    if (!f.rent_scope) { f.rent_scope = 'unknown'; changed.push('rent_scope'); }
    const r = R[f.rent_currency];
    const monthly = f.rent_period === 'week' ? (f.rent_amount * 52) / 12 : f.rent_amount;
    if (!r) issues.push('rent_range_unknown');
    else if (monthly < r[0] || monthly > r[1]) {
      issues.push('rent_out_of_range');
      f.rent_amount = null; f.rent_currency = null; f.rent_period = null; f.rent_scope = null;
      changed.push('rent_amount');
    }
  }
  if (f.deposit_amount !== null && f.deposit_amount !== undefined) {
    if (!f.deposit_currency) { f.deposit_currency = f.rent_currency || fallbackCurrency || null; changed.push('deposit_currency'); }
    const r = R[f.deposit_currency];
    if (r && f.deposit_amount !== 0 && (f.deposit_amount < r[0] || f.deposit_amount > r[1])) {
      issues.push('deposit_out_of_range');
      f.deposit_amount = null; f.deposit_currency = null;
      changed.push('deposit_amount');
    }
  }
  if (text !== undefined && f.available_from && !dateMentioned(text)) {
    issues.push('available_from_not_in_text');
    f.available_from = null;
    changed.push('available_from');
  }
  if (Array.isArray(f.amenities)) f.amenities = [...new Set(f.amenities)].sort();
  return { fields: f, issues, changed };
}

// Main units to minor units with the currency exponent (app.currencies), for storage.
function toMinorUnits(amount, currency, exponents) {
  if (amount === null || amount === undefined || !currency || !exponents ||
      !Object.prototype.hasOwnProperty.call(exponents, currency)) return null;
  const n = Number(amount);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * Math.pow(10, Number(exponents[currency]))) : null;
}

if (typeof module !== 'undefined') module.exports = { checkListing, toMinorUnits, dateMentioned };
