// wf.api.admin_fx_refresh > "Validate body"   POST /v1/admin/fx/refresh  {} (role admin)
// Fetches the ECB euro reference rates now (the same job runs every day on a schedule).
const gw = $input.first().json;
const b = gw.ctx.body || {};
const details = Object.keys(b).map((k) => ({ field: k, issue: 'unknown_field' }));
if (details.length) return [{ json: { ok: false, status: 422, gw, error: { code: 'VALIDATION_FAILED', message: 'Request body is invalid', details } } }];
const idem = gw.idempotency ? `${gw.idempotency.scope}:${gw.idempotency.key}` : null;
return [{ json: { ok: true, gw, params: [JSON.stringify({}), gw.ctx.user_id, idem, 'fx_refresh'] } }];
