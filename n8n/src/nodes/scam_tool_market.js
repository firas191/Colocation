// wf.scam.tool_market > "Tool answer": a rent amount against the median monthly rent of comparable published listings
// (app.scam_context: same city, kind and currency, else the whole country). Numbers in main units; no listing prose.
const s = $('Start').first().json;
const c = $input.first().json.ctx || {};
if (c.ok !== true) return [{ json: { error: 'listing_not_found' } }];
const exp = c.currency_exponent == null ? 2 : Number(c.currency_exponent);
const main = (v) => (v == null ? null : Math.round((Number(v) / 10 ** exp) * 100) / 100);
const m = c.market || {};
const median = m.median_monthly_minor ? main(m.median_monthly_minor) : null;
const amount = Number(s.amount);
return [{ json: { currency: c.currency || null, listed_rent: main(c.rent_minor), listed_period: c.rent_period || null,
  amount: Number.isFinite(amount) ? amount : null, median_monthly_rent: median, compared_listings: m.comparables ?? 0,
  compared_in: m.scope || 'none',
  ratio: median && amount > 0 ? Math.round((amount / median) * 100) / 100 : null,
  note: median ? null : 'not enough similar listings to compare' } }];
