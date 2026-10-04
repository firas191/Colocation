// wf.api.admin_listings_embed > "Validate body"   POST /v1/admin/listings/embed  {} (role admin)
// Embeds every listing that has no embedding yet (bge-m3). Body: {limit} (default 500).
const gw = $input.first().json;
const b = gw.ctx.body || {};
const details = [];
for (const k of Object.keys(b)) if (k !== 'limit') details.push({ field: k, issue: 'unknown_field' });
if (b.limit !== undefined && (!Number.isInteger(b.limit) || b.limit < 1 || b.limit > 5000)) details.push({ field: 'limit', issue: 'must_be_integer_1_5000' });
if (details.length) return [{ json: { ok: false, status: 422, gw, error: { code: 'VALIDATION_FAILED', message: 'Request body is invalid', details } } }];
const idem = gw.idempotency ? `${gw.idempotency.scope}:${gw.idempotency.key}` : null;
return [{ json: { ok: true, gw, params: [JSON.stringify({ limit: b.limit || 500 }), gw.ctx.user_id, idem, 'listings_embed'] } }];
