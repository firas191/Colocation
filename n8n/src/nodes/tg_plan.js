// wf.channel.telegram > "Plan": what to do with this update. Output index of the "Action" switch:
// 0 reply with a fixed text · 1 ask for consent · 2 consent given · 3 consent refused or withdrawn ·
// 4 set the country · 5 ask the assistant · 6 trace (admins) · 7 post a listing.
// Nothing is processed before consent (spec 13.4): without it, every update gets the consent request.
/* @include lib/tg_texts.js */
const p = $('Parse update').first().json;
const c = $input.first().json;
if (!c.fresh) return [];                                           // update already handled (relay retry)
const lang = tgLang(p.lang_code);
const cfg = c.cfg || {};
const consents = c.consents || {};
const consented = !!c.user_id && consents.terms === true && consents.privacy === true;
const country = c.jurisdiction_code || cfg['telegram.default_jurisdiction'] || 'TN';
const base = { ...p, lang, user_id: c.user_id || null, role: c.role || null, country, consented,
  policy_version: cfg['telegram.policy_version'] || 'telegram', job_wait_s: Number(cfg['telegram.job_wait_s'] || 300),
  last_request_id: c.last_request_id || null, api_url: c.api_url,
  accept_label: T(lang, 'accept'), refuse_label: T(lang, 'refuse') };
const reply = (text) => [{ json: { ...base, route: 0, text } }];
const cmd = p.command;
if (p.kind === 'callback') {
  if (p.callback_data === 'consent:yes') return [{ json: { ...base, route: 2 } }];
  if (p.callback_data === 'consent:no') return [{ json: { ...base, route: 3, text: T(lang, 'refused') } }];
  return [];
}
if (cmd === 'stop') return [{ json: { ...base, route: 3, text: T(lang, 'stopped') } }];
if (!consented) return [{ json: { ...base, route: 1, text: T(lang, 'consent') } }];
const help = T(lang, 'help', { country }) + (c.role === 'admin' ? T(lang, 'help_admin') : '');
if (['start', 'help', 'aide'].includes(cmd)) return reply(cmd === 'start' ? `${T(lang, 'welcome')}\n\n${help}` : help);
if (['me', 'moi', 'whoami'].includes(cmd)) {
  return reply(T(lang, 'me', { tg: p.from_id, user: c.user_id, role: c.role, country }));
}
if (['country', 'pays'].includes(cmd)) {
  const code = p.args.toUpperCase();
  if (!['TN', 'FR', 'GB'].includes(code)) return reply(T(lang, 'country_bad'));
  return [{ json: { ...base, route: 4, new_country: code } }];
}
if (cmd === 'trace') {
  if (c.role !== 'admin') return reply(T(lang, 'admin_only'));
  if (!c.last_request_id) return reply(T(lang, 'no_trace'));
  return [{ json: { ...base, route: 6 } }];
}
if (['listing', 'annonce'].includes(cmd)) {
  if (!p.args) return reply(T(lang, 'listing_empty'));
  return [{ json: { ...base, route: 7, listing_text: p.args } }];
}
if (cmd) return reply(help);                                       // unknown command
if (p.kind === 'voice') return reply(T(lang, 'voice'));
if (p.kind === 'photo') return reply(T(lang, 'photo_hint'));
if (p.kind === 'text' && p.text) return [{ json: { ...base, route: 5 } }];
return reply(T(lang, 'other'));
