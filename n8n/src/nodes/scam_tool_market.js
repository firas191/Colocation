// wf.scam.tool_market > "Tool answer": the listing's stored rent, and optionally an amount the agent read in the text,
// against the median monthly rent of comparable published listings (app.scam_context: same city, kind and currency,
// else the whole country). An amount that is not written in the listing is not echoed back (the agent may not invent
// one), so a note quoting it fails the number check. Numbers in main units; no listing prose.
/* @include lib/scam_signals.js */
const s = $('Start').first().json;
const c = $input.first().json.ctx || {};
if (c.ok !== true) return [{ json: { error: 'listing_not_found' } }];
const exp = c.currency_exponent == null ? 2 : Number(c.currency_exponent);
const main = (v) => (v == null ? null : Math.round((Number(v) / 10 ** exp) * 100) / 100);
const m = c.market || {};
const median = m.median_monthly_minor ? main(m.median_monthly_minor) : null;
const listed = main(c.rent_minor);
const listedMonthly = listed == null ? null : Math.round(monthlyOf(listed, c.rent_period) * 100) / 100;
const ratio = (x) => (median && x > 0 ? Math.round((x / median) * 100) / 100 : null);
const amount = Number(s.amount);
const asked = Number.isFinite(amount) && amount > 0;
const written = asked && amountInText(amount, c.text);
return [{ json: { currency: c.currency || null, listed_rent: listed, listed_period: c.rent_period || null,
  listed_ratio: ratio(listedMonthly), median_monthly_rent: median, compared_listings: m.comparables ?? 0, compared_in: m.scope || 'none',
  text_amount: written ? amount : null, text_amount_ratio: written ? ratio(amount) : null,
  amount_check: asked && !written ? 'that amount is not written in the listing; use listed_rent' : null,
  note: median ? null : 'not enough similar listings to compare' } }];
