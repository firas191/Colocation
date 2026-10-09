// wf.match.tool_search > "Tool answer": what the model sees. Fields only, never the owner's title or description
// (spec 8.2 A3 guardrail: listing prose could carry instructions). Numbers in main units.
const x = $('Extract profile').first().json;
let m = null;
try { m = $('Match').first().json; } catch (e) { m = null; }
if (!x.ok) return [{ json: { found: 0, error: 'could_not_read_request', results: [] } }];
if (!m || !m.ok) return [{ json: { found: 0, error: 'search_failed', results: [] } }];
const p = x.profile || {};
const unit = (v, e) => (v == null ? null : Number((v / 10 ** (e ?? 2)).toFixed(e ?? 2)));
const exp = { TND: 3 }[p.currency] ?? 2;
const understood = { budget_max: unit(p.budget_max_minor, exp), currency: p.currency || null, period: p.budget_period || null,
  near: x.anchor && x.anchor.status === 'found' ? (x.anchor.place.name || x.anchor.place.label || null) : (p.anchor_label || null),
  near_found: !!(x.anchor && x.anchor.status === 'found'), move_in_from: p.move_in_from || null };
const results = (m.results || []).slice(0, 10).map((r, i) => {
  const rent = r.rent || {};
  return { number: i + 1, kind: r.kind, rent: unit(rent.amount_minor, rent.exponent), currency: rent.currency || null,
    period: rent.period || null, bills_included: r.bills_included ?? null, furnished: r.furnished ?? null,
    neighbourhood: r.neighbourhood || null, city: r.city || null,
    distance_km: r.distance_m != null ? Number((Number(r.distance_m) / 1000).toFixed(1)) : null,
    available_from: r.available_from || null };
});
return [{ json: { found: m.count ?? results.length, understood, results } }];
