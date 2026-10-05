// wf.channel.telegram > "Parse update": one Telegram update (as handed over by the relay) to a small record.
// Only private chats are handled; anything else (groups, edits, channel posts) is dropped here.
const u = $input.first().json.body || $input.first().json;
const bot = String((($input.first().json.headers || {})['x-telegram-bot']) || '');   // hash of the bot token (F-060)
const m = u.message || null;
const cb = u.callback_query || null;
const msg = m || (cb && cb.message) || null;
if (!u.update_id || !/^[0-9a-f]{16}$/.test(bot) || !msg || !msg.chat || msg.chat.type !== 'private') return [];
const from = (m ? m.from : cb.from) || {};
const out = { update_id: Number(u.update_id), bot, chat_id: msg.chat.id, from_id: from.id, ext_id: `telegram:${from.id}`,
  lang_code: from.language_code || '', first_name: from.first_name || '', message_id: msg.message_id,
  kind: 'other', text: '', command: null, args: '', callback_id: null, callback_data: null, photo_file_id: null };
if (cb) {
  Object.assign(out, { kind: 'callback', callback_id: cb.id, callback_data: String(cb.data || '') });
} else if (m.voice || m.audio) {
  out.kind = 'voice';
} else if (m.photo && m.photo.length) {
  out.kind = 'photo';
  out.photo_file_id = m.photo[m.photo.length - 1].file_id;      // the largest size Telegram offers
  out.text = String(m.caption || '').trim();
} else if (typeof m.text === 'string') {
  out.kind = 'text';
  out.text = m.text.trim();
}
const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(out.text);
if (cmd) { out.command = cmd[1].toLowerCase(); out.args = (cmd[2] || '').trim(); }
return [{ json: out }];
