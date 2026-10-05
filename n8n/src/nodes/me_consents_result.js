// wf.api.me_consents > "Build result": the user's current consent per purpose and what is still required.
const v = $('Validate body').first().json;
const consents = ($input.first().json || {}).c || {};
const REQUIRED = ['terms', 'privacy'];
return [{ json: { ok: true, gw: v.gw, status: 200, result_user_id: v.gw.ctx.user_id,
  data: { consents, consent_required: REQUIRED.filter((p) => !(consents[p] && consents[p].granted === true)) } } }];
