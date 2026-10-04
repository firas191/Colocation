// wf.eval.prompts > "Call input"
// Builds the wf.llm.call input for one dataset item: template variables from the item's
// context (account jurisdiction, today) and the jurisdiction's extraction context.
const it = $input.first().json;
const contexts = $('Start job').first().json.contexts || {};
let vars;
if (it.prompt === 'P1_router') {
  vars = { message: it.message, user_jurisdiction: it.context.user_jurisdiction };
} else {
  const c = contexts[it.context.jurisdiction] || {};
  vars = { message: it.message, jurisdiction: it.context.jurisdiction, today: it.context.today,
    default_currency: c.default_currency, currency_exponents: c.currencies, allowed_preferences: c.allowed_preference_filters };
}
return [{ json: { prompt: it.prompt, version: it.version, model: it.model, vars, meta: it } }];
