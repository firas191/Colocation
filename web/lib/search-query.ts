// The search page's address (what a person can bookmark or share) to the GET /v2/search query, and back to the form.
// The page's own names are short and readable; the API's rules (ranges, vocabulary, cursor) are checked by the API,
// whose 422 details the page shows. The one conversion here is the budget: main units in the form, minor units for
// the API, with the exponent GET /v1/me gives for the currency.
import { AMENITIES, KINDS, RULES } from "./listing";

export type PageParams = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || "";
const many = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => x.trim()).filter(Boolean);

export interface SearchForm {
  q: string; near: string; city: string; country: string; max: string; period: string; kind: string; furnished: string; bills: string;
  available_by: string; amenity: string[]; rules: Record<string, string>; use_profile: boolean; view: "list" | "map";
  bbox: string; cursor: string;
}

export function readForm(p: PageParams, defaultCountry: string): SearchForm {
  const rules: Record<string, string> = {};
  for (const r of RULES) { const v = one(p[`rule_${r}`]); if (v === "yes" || v === "no") rules[r] = v; }
  return {
    q: one(p.q).slice(0, 300), near: one(p.near).slice(0, 120), city: one(p.city).slice(0, 120), country: one(p.country) || defaultCountry, max: one(p.max),
    period: one(p.period) === "week" ? "week" : "month", kind: (KINDS as readonly string[]).includes(one(p.kind)) ? one(p.kind) : "",
    furnished: ["true", "false"].includes(one(p.furnished)) ? one(p.furnished) : "",
    bills: ["true", "false"].includes(one(p.bills)) ? one(p.bills) : "", available_by: one(p.available_by),
    amenity: many(p.amenity).filter((a) => (AMENITIES as readonly string[]).includes(a)), rules,
    use_profile: one(p.use_profile) === "true", view: one(p.view) === "map" ? "map" : "list", bbox: one(p.bbox), cursor: one(p.cursor),
  };
}

/** Minor units from a main-unit amount typed in the form ("400", "400,5"); null when empty, NaN when not a number. */
export function toMinor(v: string, exponent: number): number | null {
  const s = v.trim().replace(",", ".");
  if (!s) return null;
  if (!/^\d{1,9}(\.\d{1,4})?$/.test(s)) return NaN;
  return Math.round(Number(s) * 10 ** exponent);
}

export function apiQuery(f: SearchForm, currency: string, exponent: number) {
  const max = toMinor(f.max, exponent);
  const q: Record<string, string> = { jurisdiction: f.country, limit: f.view === "map" ? "50" : "20" };
  if (f.q) q.q = f.q;
  // a precise place wins over the city filter; the city is searched as a place too (D-118)
  if (f.near || f.city) q.near = f.near || f.city;
  if (max !== null) { q.max_rent = Number.isNaN(max) ? f.max : String(max); q.currency = currency; q.period = f.period; }
  if (f.kind) q.kind = f.kind;
  if (f.furnished) q.furnished = f.furnished;
  if (f.bills) q.bills_included = f.bills;
  if (f.available_by) q.available_by = f.available_by;
  if (f.amenity.length) q.amenities = f.amenity.join(",");
  const rules = Object.entries(f.rules).map(([k, v]) => `${k}:${v}`);
  if (rules.length) q.house_rules = rules.join(",");
  if (f.view === "map" && f.bbox) q.bbox = f.bbox;
  if (f.use_profile) q.use_profile = "true";
  if (f.cursor) q.cursor = f.cursor;
  return q;
}

/** The page address for a form state (used for "next page", the view switch and the map's "search this area"). */
export function pageHref(f: SearchForm, change: Partial<SearchForm> = {}) {
  const g = { ...f, ...change };
  const u = new URLSearchParams();
  for (const k of ["q", "near", "city", "max", "kind", "furnished", "bills", "available_by", "bbox", "cursor"] as const) if (g[k]) u.set(k, g[k]);
  u.set("country", g.country);
  if (g.max) u.set("period", g.period);
  for (const a of g.amenity) u.append("amenity", a);
  for (const [k, v] of Object.entries(g.rules)) u.set(`rule_${k}`, v);
  if (g.use_profile) u.set("use_profile", "true");
  if (g.view === "map") u.set("view", "map");
  else u.delete("bbox");
  return `/search?${u.toString()}`;
}
