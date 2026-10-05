// wf.channel.telegram > "__NAME__": the reply after a consent or country change (or the API's error in plain words).
/* @include lib/tg_texts.js */
const P = $('Plan').first().json;
const r = $input.first().json;
const err = tgApiError(P.lang, r);
let text;
if ('__NAME__' === 'No account') text = P.text;
else if (err) text = err;
else if (P.route === 2) text = `${T(P.lang, 'welcome')}\n\n${T(P.lang, 'help', { country: P.country })}${P.role === 'admin' ? T(P.lang, 'help_admin') : ''}`;
else if (P.route === 3) text = P.text;
else text = T(P.lang, 'country_set', { country: P.new_country });
return [{ json: { chat_id: P.chat_id, text } }];
