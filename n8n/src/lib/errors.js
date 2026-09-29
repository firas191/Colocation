// Text of the error carried by an item on a node's error output.
// n8n puts either a string or an object {message, description, ...} in json.error.
function errorText(json) {
  const e = json && (json.error !== undefined ? json.error : json);
  if (e == null) return '';
  if (typeof e === 'string') return e;
  const parts = [e.message, e.description, e.cause && e.cause.message].filter((x) => typeof x === 'string' && x);
  return parts.length ? parts.join(' | ') : JSON.stringify(e);
}
// Postgres error details echo the offending value, e.g. Key (email)=(a@b.c).
// Values are removed before anything is logged.
function redactPg(msg) {
  return String(msg || '').replace(/\)=\([^)]*\)/g, ')=(redacted)');
}
if (typeof module !== 'undefined') module.exports = { errorText, redactPg };
