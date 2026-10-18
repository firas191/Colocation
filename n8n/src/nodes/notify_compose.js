// wf.notify.dispatch > "Compose" (platform P11, D-110): one item per due delivery, with the website's own sentence
// for the notification type in the person's language and a link to the page it is about. Nothing personal is added:
// the text says what happened and where to look; details stay on the website.
/* @include lib/notify_text.js */
const TEXTS = __NOTIFY_TEXTS__;
const SUBJECT = { fr: 'Coloc : du nouveau', en: 'Coloc: something new', ar: 'Coloc: جديد' };
const OPEN = { fr: 'Voir sur le site :', en: 'Open on the website:', ar: 'افتح على الموقع:' };
const STOP = { fr: 'Réglez les notifications dans votre compte.', en: 'Choose your notifications in your account.', ar: 'اختر إشعاراتك من حسابك.' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const r = ($input.first().json || {}).r || {};
const origin = String(r.web_origin || '').replace(/\/+$/, '');
const out = [];
for (const d of r.deliveries || []) {
  const l = ['fr', 'en', 'ar'].includes(d.locale) ? d.locale : 'fr';
  const text = notificationText(TEXTS, d.type, d.params || {}, l);
  const url = `${origin}/${l}${notificationPath(d.link_kind, d.link_id)}`;
  out.push({ json: { delivery_id: d.delivery_id, channel: d.channel, email: d.email, chat_id: d.chat_id, from: r.mail_from,
    missing_text: !text,
    subject: SUBJECT[l], body: `${text || SUBJECT[l]}\n\n${OPEN[l]} ${url}\n\n${STOP[l]}`,
    telegram: `${esc(text || SUBJECT[l])}\n<a href="${esc(url)}">${esc(OPEN[l].replace(/\s*:$/, ''))}</a>` } });
}
return out;
