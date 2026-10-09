// wf.orchestrator > "Agent request": input of the A3 Match agent (wf.match.agent). The agent and its memory get the
// masked copy of the text (Text service, D-074); if the service did not answer, e-mails and phone numbers are masked
// here (agent_check.fallbackMask).
/* @include lib/agent_check.js */
const v = $('Validate body').first().json;
const d = $('Decide route').first().json;
const tr = $('Text analysis').first().json || {};
const tb = tr.body && typeof tr.body === 'object' ? tr.body : null;
const masked = tb && tb.pii && typeof tb.pii.masked_text === 'string' ? tb.pii.masked_text : fallbackMask(v.text);
const o = d.router || {};
return [{ json: { text: masked, language: o.language || d.detected_language || null, script: o.script || null,
  jurisdiction: d.extract.jurisdiction,
  today: v.today, user_id: v.gw.ctx.user_id, request_id: v.gw.request_id || v.gw.ctx.request_id } }];
