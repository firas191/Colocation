// wf.api.users_sync > "Build result"
// Input: the row returned by the upsert. Consent status for the purposes the
// platform requires before use (terms, privacy).
const gw = $('Validate body').first().json.gw;
const row = $input.first().json;
const REQUIRED = ['terms', 'privacy'];
const consents = row.consents || {};
const consent_required = REQUIRED.filter((p) => !(consents[p] && consents[p].granted === true));
return [{ json: {
  ok: true, gw, status: row.created ? 201 : 200, result_user_id: row.user_id,
  data: {
    user_id: row.user_id, created: row.created, role: row.role, locale: row.locale,
    jurisdiction_code: row.jurisdiction_code, consents, consent_required,
  },
} }];
