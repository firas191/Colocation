// wf.api.legal_ask > "Legal request" (platform P9, PLATFORM_SPEC 3.8): POST /v1/legal/ask goes straight to the Legal
// agent (A5), without the P1 router. Same input as the assistant path: the masked text (Text service, or the fallback
// mask), the language the Text service found, the jurisdiction asked or the account's.
/* @include lib/agent_check.js */
const v = $('Validate body').first().json;
const tr = $('Text analysis').first().json || {};
const tb = tr.body && typeof tr.body === 'object' ? tr.body : null;
const masked = tb && tb.pii && typeof tb.pii.masked_text === 'string' ? tb.pii.masked_text : fallbackMask(v.text);
const lang = tb && tb.language ? tb.language : {};
return [{ json: { text: masked, language: lang.language || null, script: lang.script || null, jurisdiction: v.jurisdiction,
  today: v.today, user_id: v.gw.ctx.user_id, request_id: v.gw.request_id || v.gw.ctx.request_id } }];
