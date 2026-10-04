// Budget amounts from P2 v3 (D-066). From v3 the model returns budget_min / budget_max in the
// currency's main unit (450 for 450 dinars) and this code converts them to the minor units the
// profile stores, with the exponent from app.currencies. In v2 the model did the conversion and
// made power-of-ten errors. Outputs without budget_min / budget_max (v1, v2) pass unchanged.
//
// out: the validated model output; exponents: {currency: exponent}; fallbackCurrency: the
// currency used when an amount has none (the jurisdiction's, as the prompt's rule 2 says).
// The currency field itself is not filled here: that stays a model output (and a warning in
// the profile workflow), so the evaluation still scores what the model said.
function amountsToMinor(out, exponents, fallbackCurrency) {
  if (!out || typeof out !== 'object' || !('budget_min' in out || 'budget_max' in out)) return out;
  const cur = out.currency || fallbackCurrency || null;
  const has = cur !== null && exponents && Object.prototype.hasOwnProperty.call(exponents, cur);
  const exp = has ? Number(exponents[cur]) : null;
  const toMinor = (v) => {
    if (v === null || v === undefined || exp === null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * Math.pow(10, exp)) : null;
  };
  const rename = { budget_min: 'budget_min_minor', budget_max: 'budget_max_minor' };
  const p = {};
  for (const [k, v] of Object.entries(out)) {
    if (k in rename) p[rename[k]] = toMinor(v);
    else if (k === 'field_confidence' && v && typeof v === 'object') {
      p[k] = Object.fromEntries(Object.entries(v).map(([fk, fv]) => [rename[fk] || fk, fv]));
    } else p[k] = v;
  }
  return p;
}

if (typeof module !== 'undefined') module.exports = { amountsToMinor };
