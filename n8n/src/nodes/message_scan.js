// wf.api.message_send > "Scan" (platform P8, D-107; PLATFORM_SPEC rule 2.7: private messages never go to a model)
// The phrase lists of the packs over the message: the codes found are stored with the message and shown as a
// warning to the person who receives it. The text itself is not changed or blocked.
/* @include lib/trust_rules.js */
const PHRASES = compilePhrases(__TRUST_PHRASES__);
const v = $input.first().json;
const user = ((v.gw || {}).ctx || {}).user || {};
const text = String((v.input.body || {}).text || '');
const codes = [...new Set(messageCodes(text, PHRASES, ['GLOBAL', user.jurisdiction_code || '']))];
return [{ json: { ...v, input: { ...v.input, scan: codes } } }];
