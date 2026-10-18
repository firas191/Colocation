// Notification texts for e-mail and Telegram (platform P11, D-110): the website's own sentences
// (web/messages/<locale>.json, notifications.types, built into the Code node), filled with the notification's
// params. A small ICU subset: {name}, {n, plural, =0 {..} one {..} two {..} few {..} many {..} other {..}} with #,
// and {x, select, a {..} other {..}}. Values are plain text; the caller escapes them for HTML.

function parseArgs(src, i) {
  // src[i] is just after "{name, plural," or "{name, select,": read "key {text}" pairs up to the closing "}"
  const cases = {};
  while (i < src.length) {
    while (src[i] === ' ' || src[i] === '\n') i++;
    if (src[i] === '}') return { cases, end: i + 1 };
    let key = '';
    while (i < src.length && src[i] !== '{' && src[i] !== ' ') key += src[i++];
    while (src[i] === ' ') i++;
    if (src[i] !== '{') return { cases, end: src.length };
    let depth = 0;
    const start = i + 1;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    cases[key] = src.slice(start, i);
    i++;
  }
  return { cases, end: i };
}

function formatMessage(src, params, locale) {
  const p = params || {};
  let out = '';
  let i = 0;
  const s = String(src || '');
  while (i < s.length) {
    if (s[i] !== '{') { out += s[i++]; continue; }
    const m = /^\{\s*([a-zA-Z0-9_]+)\s*(?:,\s*(plural|select)\s*,)?/.exec(s.slice(i));
    if (!m) { out += s[i++]; continue; }
    const name = m[1];
    if (!m[2]) {
      const close = s.indexOf('}', i);
      const v = p[name];
      out += v === undefined || v === null ? '' : String(v);
      i = close + 1;
      continue;
    }
    const { cases, end } = parseArgs(s, i + m[0].length);
    const v = p[name];
    let chosen;
    if (m[2] === 'plural') {
      const n = Number(v);
      chosen = cases[`=${n}`] ?? cases[new Intl.PluralRules(locale || 'fr').select(Number.isFinite(n) ? n : 0)] ?? cases.other ?? '';
      chosen = formatMessage(chosen, p, locale).replace(/#/g, Number.isFinite(n) ? new Intl.NumberFormat(locale || 'fr').format(n) : '');
    } else {
      chosen = formatMessage(cases[String(v)] ?? cases.other ?? '', p, locale);
    }
    out += chosen;
    i = end;
  }
  return out;
}

/** The text of one notification in the person's language (French when the language or the type has no text). */
function notificationText(texts, type, params, locale) {
  const l = texts[locale] && texts[locale][type] ? locale : 'fr';
  const src = (texts[l] || {})[type];
  if (!src) return null;
  return formatMessage(src, params, l);
}

/** The website page a notification points to (same rules as the website's /notifications page). */
function notificationPath(kind, id) {
  if (kind === 'conversation' && id) return `/messages/${id}`;
  if (kind === 'visit') return '/visits';
  if (kind === 'application') return '/applications';
  if (kind === 'listing' && id) return `/owner/listings/${id}`;
  if (kind === 'household' && id) return `/households/${id}`;
  if (kind === 'household_invite') return '/households';
  if (kind === 'saved_search') return '/saved-searches';
  if (kind === 'contact_request') return '/contact-requests';
  return '/notifications';
}

if (typeof module !== 'undefined') module.exports = { formatMessage, notificationText, notificationPath };
