// wf.scam.tool_contact > "Tool answer": how many listings of OTHER owners contain the same phone (last 8 digits) or e-mail.
const s = $('Start').first().json;
const r = $input.first().json || {};
const n = Number(r.other_listings) || 0, o = Number(r.other_owners) || 0;
return [{ json: { contact: String(s.contact || '').slice(0, 80), other_listings: n, other_owners: o, final: true,
  meaning: o > 0 ? `used in ${n} listing(s) of ${o} other owner(s)` : 'not used in other owners\' listings; do not check this contact again' } }];
