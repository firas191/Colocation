// wf.scam.tool_owner > "Tool answer": facts about the listing's owner (no name, no contact).
const c = $input.first().json.ctx || {};
if (c.ok !== true) return [{ json: { error: 'listing_not_found' } }];
const o = c.owner || {};
return [{ json: { account_age_days: o.account_age_days ?? null, verified: o.verified_level == null ? null : o.verified_level > 0,
  listings_last_24h: o.listings_24h ?? 0 } }];
