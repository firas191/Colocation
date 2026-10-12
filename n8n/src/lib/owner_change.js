// Owner assistant (D-088): the propose_change tool's arguments, as the model wrote them (text), to the body of
// PATCH /v1/listings/:id. Empty or unreadable arguments are left out; what is left is checked in the database.
//  - amount("400 DT") 400; amount("1.225.000") 1225000 (dots as thousands separators); amount("450,5") 450.5
//  - yesNo("oui") true; list("wifi, Air conditioning") ["wifi", "air_conditioning"]; rules("smoking=no, pets=yes")
function amount(s) {
  const t = String(s ?? '').replace(/\s+/g, '').replace(/[^\d.,]/g, '');
  if (!t) return null;
  const v = /^\d{1,3}(\.\d{3})+$/.test(t) ? Number(t.replace(/\./g, '')) : Number(t.replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}
function int(s) {
  const v = amount(s);
  return v !== null && Number.isInteger(v) ? v : null;
}
function yesNo(s) {
  const t = String(s ?? '').trim().toLowerCase();
  if (['yes', 'true', 'oui', 'y', '1'].includes(t)) return true;
  if (['no', 'false', 'non', 'n', '0'].includes(t)) return false;
  return null;
}
function list(s) {
  return String(s ?? '').split(/[,;]/).map((x) => x.trim().toLowerCase().replace(/[\s-]+/g, '_')).filter(Boolean);
}
function rules(s) {
  const out = {};
  for (const part of String(s ?? '').split(/[,;]/)) {
    const m = /^\s*(smoking|pets|guests|parties)\s*[=:]\s*(yes|no)\s*$/i.exec(part);
    if (m) out[m[1].toLowerCase()] = m[2].toLowerCase();
  }
  return out;
}
function toChanges(a) {
  const c = {};
  const rent = amount(a.rent); if (rent !== null) c.rent = rent;
  const dep = amount(a.deposit); if (dep !== null) c.deposit = dep;
  const bills = yesNo(a.bills_included); if (bills !== null) c.bills_included = bills;
  const furn = yesNo(a.furnished); if (furn !== null) c.furnished = furn;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(a.available_from || '').trim()) ? String(a.available_from).trim() : null;
  if (date) c.available_from = date;
  const bed = int(a.bedrooms); if (bed !== null) c.bedrooms = bed;
  if (String(a.place || '').trim()) c.place = String(a.place).trim().slice(0, 120);
  const add = list(a.add_amenities); if (add.length) c.amenities_add = add;
  const rem = list(a.remove_amenities); if (rem.length) c.amenities_remove = rem;
  const hr = rules(a.house_rules); if (Object.keys(hr).length) c.house_rules = hr;
  const photos = String(a.remove_photo ?? '').split(/[,;\s]+/).map((x) => int(x)).filter((x) => x !== null && x > 0);
  if (photos.length) c.remove_photos = [...new Set(photos)];
  const st = String(a.status || '').trim().toLowerCase();
  if (['archived', 'rented', 'withdrawn'].includes(st)) c.status = 'archived';
  else if (st === 'published') c.status = 'published';
  return c;
}
if (typeof module !== 'undefined') module.exports = { amount, int, yesNo, list, rules, toChanges };
