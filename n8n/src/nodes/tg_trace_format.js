// wf.channel.telegram > "Format trace": GET /v1/admin/traces/:id as a short message (admins): each execution
// with its steps, prompt versions, models, times and tokens. Telegram allows 4096 characters per message.
/* @include lib/tg_texts.js */
const P = $('Plan').first().json;
const r = $input.first().json;
const err = tgApiError(P.lang, r);
if (err) return [{ json: { chat_id: P.chat_id, text: err } }];
const t = r.body.data;
const short = (o) => {
  if (!o || typeof o !== 'object') return '';
  const keep = ['intent', 'language', 'script', 'confidence', 'status', 'kind', 'rent_amount', 'budget_max', 'budget_max_minor', 'anchor_label', 'error_code'];
  return keep.filter((k) => o[k] !== undefined && o[k] !== null).map((k) => `${k}=${typeof o[k] === 'object' ? JSON.stringify(o[k]) : o[k]}`).join(', ');
};
const lines = [`<b>Trace</b> <code>${tgEsc(t.request_id)}</code>`];
for (const e of t.executions || []) {
  lines.push(`\n<b>${tgEsc(e.workflow)}</b> · ${tgEsc(e.status)} · ${e.latency_ms ?? '?'} ms · tokens ${e.tokens_in}/${e.tokens_out}`);
  for (const s of e.steps || []) {
    const pv = s.prompt ? ` ${s.prompt} v${s.prompt_version}` : '';
    lines.push(`${s.index}. ${tgEsc(s.agent)}${tgEsc(pv)}${s.model ? ' · ' + tgEsc(s.model) : ''} · ${s.latency_ms ?? '?'} ms` +
      (s.error ? ` · <b>${tgEsc(String(s.error).slice(0, 80))}</b>` : '') + (short(s.output) ? `\n   ${tgEsc(short(s.output)).slice(0, 200)}` : ''));
  }
}
let text = lines.join('\n');
if (text.length > 4000) text = text.slice(0, 3990) + '\n…';
return [{ json: { chat_id: P.chat_id, text } }];
