// wf.owner.tool_change > "Changes": the tool's arguments (text written by the model) -> PATCH body shape (D-088).
/* @include lib/owner_change.js */
const s = $('Start').first().json;
const changes = toChanges(s);
const n = int(s.listing);
return [{ json: { changes, params: [s.session_id, s.user_id, s.request_id, n === null ? 0 : n, JSON.stringify(changes)] } }];
