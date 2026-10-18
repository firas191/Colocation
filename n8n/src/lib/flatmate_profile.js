// Flatmate matching helpers (platform P12, D-115, from Yosr's roommate matching). Plain code, no model:
//  - checkProposal: the profile agent's proposal -> the fields the platform knows, with valid values only;
//  - supportedByText: an amount, a place or a date the person did not write is dropped (the model cannot invent them);
//  - explainFactors / codeSentence / checkSentence: the match explanation from the factor states of
//    social.compatibility, the sentence written by code, and the check of the model's sentence.

const LIFESTYLE = { smoking: ['yes', 'no'], pets: ['yes', 'no'], guests: ['yes', 'no'], quiet_hours: ['yes', 'no'],
  schedule: ['early', 'late', 'irregular'], cleanliness: ['high', 'medium', 'relaxed'] };
const SEEKING = ['room', 'flatmate', 'both'];
const LANGS = ['ar', 'aeb', 'fr', 'en', 'de', 'es', 'it'];
const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** values: an object or a JSON string. Returns {values, errors}: values hold only known fields with valid values. */
function checkProposal(values) {
  let v = values;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return { values: {}, errors: [{ field: 'values', issue: 'not_json' }] }; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { values: {}, errors: [{ field: 'values', issue: 'not_an_object' }] };
  const out = {};
  const errors = [];
  const ls = v.lifestyle && typeof v.lifestyle === 'object' ? v.lifestyle : {};
  for (const [k, x] of Object.entries(ls)) {
    if (!LIFESTYLE[k]) { errors.push({ field: `lifestyle.${k}`, issue: 'unknown' }); continue; }
    const val = String(x).toLowerCase();
    if (!LIFESTYLE[k].includes(val)) { errors.push({ field: `lifestyle.${k}`, issue: 'one_of', allowed: LIFESTYLE[k] }); continue; }
    (out.lifestyle = out.lifestyle || {})[k] = val;
  }
  for (const k of ['budget_min', 'budget_max']) {
    if (v[k] === undefined || v[k] === null || v[k] === '') continue;
    const n = Number(v[k]);
    if (!Number.isFinite(n) || n <= 0 || n > 1e6) errors.push({ field: k, issue: 'positive_number' }); else out[k] = Math.round(n * 1000) / 1000;
  }
  if (out.budget_min !== undefined && out.budget_max !== undefined && out.budget_min > out.budget_max) {
    errors.push({ field: 'budget_min', issue: 'more_than_max' });
    delete out.budget_min;
  }
  if (v.areas !== undefined) {
    const a = (Array.isArray(v.areas) ? v.areas : [v.areas]).map((x) => String(x || '').trim()).filter((x) => x && x.length <= 60);
    if (a.length) out.areas = [...new Set(a)].slice(0, 5); else errors.push({ field: 'areas', issue: 'empty' });
  }
  if (v.move_in_from !== undefined && v.move_in_from !== null && v.move_in_from !== '') {
    const d = String(v.move_in_from);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`))) out.move_in_from = d;
    else errors.push({ field: 'move_in_from', issue: 'date_yyyy_mm_dd' });
  }
  if (v.headline !== undefined && String(v.headline).trim()) out.headline = String(v.headline).replace(/\s+/g, ' ').trim().slice(0, 80);
  if (v.seeking !== undefined) {
    if (SEEKING.includes(String(v.seeking))) out.seeking = String(v.seeking); else errors.push({ field: 'seeking', issue: 'one_of', allowed: SEEKING });
  }
  if (v.languages !== undefined) {
    const l = (Array.isArray(v.languages) ? v.languages : []).map((x) => String(x).toLowerCase()).filter((x) => LANGS.includes(x));
    if (l.length) out.languages = [...new Set(l)];
  }
  if (v.visible !== undefined) out.visible = v.visible === true || v.visible === 'true';
  return { values: out, errors };
}

/** Numbers written in a text (1200, 1 200, 1.200, 1,200, 450.000 for Tunisian dinars). */
function numbersIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/\d(?:[\d.,]|\s(?=\d{3}\b))*/g)) {
    const s = m[0].replace(/[.,]+$/, '').replace(/\s/g, '');
    for (const c of [s.replace(/[.,]/g, ''), s.replace(/,/g, '.'), s.replace(/\./g, '').replace(',', '.'), s.replace(/,/g, '')]) {
      const n = Number(c);
      if (Number.isFinite(n)) out.add(n);
    }
    if (/^\d{1,4}\.000$/.test(s)) out.add(Number(s.split('.')[0]));          // 450.000 DT = 450 dinars
  }
  return out;
}

/** Keeps a budget, place or date only when the person wrote it; returns {values, dropped}. texts: what the person wrote
 *  in this conversation. Lifestyle answers, the headline and seeking are the model's reading and are shown for checking. */
function supportedByText(values, texts) {
  const all = (texts || []).join('\n');
  const nums = numbersIn(all);
  const low = plain(all);
  const out = JSON.parse(JSON.stringify(values || {}));
  const dropped = [];
  for (const k of ['budget_min', 'budget_max']) {
    if (out[k] !== undefined && ![...nums].some((n) => Math.abs(n - out[k]) < 0.005)) { dropped.push({ field: k, why: 'not_in_text' }); delete out[k]; }
  }
  if (out.areas) {
    const kept = out.areas.filter((a) => low.includes(plain(a)));
    for (const a of out.areas) if (!kept.includes(a)) dropped.push({ field: 'areas', value: a, why: 'not_in_text' });
    if (kept.length) out.areas = kept; else delete out.areas;
  }
  if (out.move_in_from) {
    const [y, m, d] = out.move_in_from.split('-').map(Number);
    const months = ['janv', 'fevr', 'mars', 'avr', 'mai', 'juin', 'juil', 'aout', 'sept', 'oct', 'nov', 'dec'];
    const monthsEn = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const said = low.includes(out.move_in_from) || nums.has(d) || low.includes(months[m - 1]) || low.includes(monthsEn[m - 1])
      || new RegExp(`\\b${m}[/.-]${y}\\b|\\b${d}[/.-]${m}\\b`).test(low);
    if (!said) { dropped.push({ field: 'move_in_from', why: 'not_in_text' }); delete out.move_in_from; }
  }
  return { values: out, dropped };
}

// ---- match explanation -------------------------------------------------------------------------------------------------
const TOPIC = {
  fr: { schedule: 'les horaires', cleanliness: 'la propreté', smoking: 'le tabac', pets: 'les animaux', guests: 'les invités',
        quiet_hours: 'le calme', languages: 'les langues', budget: 'le budget', move_in: "la date d'arrivée", distance: 'le quartier' },
  en: { schedule: 'schedule', cleanliness: 'tidiness', smoking: 'smoking', pets: 'pets', guests: 'guests', quiet_hours: 'quiet hours',
        languages: 'languages', budget: 'budget', move_in: 'move-in date', distance: 'area' },
  ar: { schedule: 'المواعيد', cleanliness: 'النظافة', smoking: 'التدخين', pets: 'الحيوانات', guests: 'الضيوف', quiet_hours: 'الهدوء',
        languages: 'اللغات', budget: 'الميزانية', move_in: 'تاريخ الانتقال', distance: 'الحي' },
};
const WORDS = {
  fr: { match: 'Vous vous accordez sur', differs: 'À discuter', unknown: 'Pas encore dit', none: 'Pas assez de réponses pour dire si vous vous accordez.' },
  en: { match: 'You agree on', differs: 'To talk about', unknown: 'Not said yet', none: 'Not enough answers yet to say how well you match.' },
  ar: { match: 'تتفقان في', differs: 'للنقاش', unknown: 'لم يُذكر بعد', none: 'لا توجد إجابات كافية بعد.' },
};

/** The factor states as words for the prompt: "smoking: match; pets: differs; schedule: unknown". */
function explainFactors(compat, lang) {
  const T = TOPIC[lang] || TOPIC.fr;
  return ((compat && compat.factors) || []).map((f) => `${T[f.factor] || f.factor}: ${f.state}`).join('; ');
}

/** The sentence written by code, used when the model is off or its sentence fails the check. */
function codeSentence(compat, lang) {
  const T = TOPIC[lang] || TOPIC.fr;
  const W = WORDS[lang] || WORDS.fr;
  const by = (st) => ((compat && compat.factors) || []).filter((f) => f.state === st).map((f) => T[f.factor] || f.factor);
  const sep = lang === 'fr' ? ' : ' : ': ';
  const parts = [];
  if (by('match').length) parts.push(`${W.match}${sep}${by('match').join(', ')}.`);
  if (by('differs').length) parts.push(`${W.differs}${sep}${by('differs').join(', ')}.`);
  if (!parts.length) return W.none;
  return parts.join(' ');
}

/** The model's sentence is kept only if it is short, adds no number but the score, and names no topic that is not in the
 *  factors given. Returns {ok, why}. */
function checkSentence(sentence, compat, lang) {
  const s = String(sentence || '').trim();
  if (s.length < 10 || s.length > 300) return { ok: false, why: 'length' };
  const score = compat && compat.score;
  for (const n of numbersIn(s)) if (n !== score && n !== 100) return { ok: false, why: 'number_not_given' };
  const known = new Set(((compat && compat.factors) || []).map((f) => f.factor));
  const T = TOPIC[lang] || TOPIC.fr;
  for (const [k, word] of Object.entries(T)) {
    if (!known.has(k) && plain(s).includes(plain(word))) return { ok: false, why: `topic_not_given:${k}` };
  }
  return { ok: true, why: null };
}

/** At most two questions in one answer (the agent's rule, D-115; on the PC the model broke it in 10 of 20 first answers,
 *  T-84): the text after the second question mark is cut. Returns {text, cut}. */
function twoQuestions(text) {
  const s = String(text || '');
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '?' || s[i] === '؟') {
      n += 1;
      if (n === 2) {
        const rest = s.slice(i + 1);
        if (/[?؟]/.test(rest)) return { text: s.slice(0, i + 1).trim(), cut: true };
        return { text: s, cut: false };
      }
    }
  }
  return { text: s, cut: false };
}

if (typeof module !== 'undefined') {
  module.exports = { checkProposal, supportedByText, numbersIn, explainFactors, codeSentence, checkSentence, twoQuestions, LIFESTYLE };
}
