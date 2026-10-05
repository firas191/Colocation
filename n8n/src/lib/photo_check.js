// Deterministic checks after P7 (spec 11.2, D-081), shared by wf.intake.photos, wf.listing.extract and the
// evaluation. The model describes one photo; the code tidies the answer, raises review flags, drops free text
// that talks about people, and compares the photos with what the listing text says.

const P7_LISTS = {
  bed_kinds: ['single', 'double', 'bunk', 'sofa_bed'],
  furniture: ['wardrobe', 'chest_of_drawers', 'nightstand', 'desk', 'chair', 'sofa', 'armchair', 'table', 'shelves'],
  appliances: ['fridge', 'oven', 'hob', 'microwave', 'washing_machine', 'dishwasher', 'tv', 'air_conditioning', 'radiator'],
  bathroom_fixtures: ['shower', 'bathtub', 'toilet', 'washbasin'],
  condition_signs: ['damp_or_mould', 'cracks_or_peeling', 'stains', 'damaged_floor', 'unfinished_works'],
};
const P7_SCALARS = ['room_type', 'beds', 'windows', 'natural_light', 'condition', 'furnished', 'readable_text', 'people_visible'];

// Words that describe a person (English, French, Arabic, Tunisian in Latin script). Free text from the model that
// contains one is not stored: the rule is to describe the room only (spec 11.2).
const PEOPLE_RE = /(?<!\p{L})(man|men|woman|women|girl|girls|boy|boys|person|persons|people|child|children|kid|kids|baby|guy|lady|ladies|gentleman|student|students|tenant|tenants|owner|homme|hommes|femme|femmes|fille|filles|gar[cç]on|gar[cç]ons|personne|personnes|enfant|enfants|b[ée]b[ée]|dame|monsieur|[ée]tudiante?s?|locataire|propri[ée]taire|rajel|mra|tfol|tofla)(?!\p{L})|رجل|امرأة|إمرأة|سيدة|بنت|ولد|طفل|شخص|أشخاص|طالب/iu;

function mentionsPeople(text) {
  return PEOPLE_RE.test(String(text || ''));
}

// Model answer (already valid against the version's schema) -> {fields, flags, dropped}.
function checkPhoto(out) {
  const fields = {};
  for (const k of P7_SCALARS) fields[k] = out[k] === undefined ? null : out[k];
  for (const [k, allowed] of Object.entries(P7_LISTS)) {
    const v = Array.isArray(out[k]) ? out[k] : [];
    fields[k] = allowed.filter((x) => v.includes(x));            // closed list, no duplicates, fixed order
  }
  const dropped = [];
  let issues = Array.isArray(out.issues) ? out.issues.map(String) : [];
  const kept = issues.filter((t) => !mentionsPeople(t));
  if (kept.length < issues.length) dropped.push('issues_about_people');
  issues = kept;
  let description = typeof out.description === 'string' ? out.description : null;
  if (description !== null && mentionsPeople(description)) { dropped.push('description_about_people'); description = null; }
  const conf = {};
  for (const [k, v] of Object.entries(out.field_confidence || {})) {
    if (k in fields && typeof v === 'number' && v >= 0 && v <= 1) conf[k] = v;
  }
  const flags = [];
  if (fields.people_visible === true) flags.push('person_in_photo');
  if (fields.readable_text === true) flags.push('text_readable_after_blur');
  if (fields.room_type === 'not_a_room') flags.push('not_a_room');
  if (fields.condition === 'poor' || fields.condition_signs.includes('damp_or_mould')) flags.push('condition_to_check');
  return { fields, issues, description, field_confidence: conf, flags, dropped };
}

// What a photo shows, in the P3 amenity vocabulary (lib/listing_check.js, P3 rule 7).
const TO_LISTING_AMENITY = { fridge: 'fridge', oven: 'oven', microwave: 'microwave', washing_machine: 'washing_machine',
  dishwasher: 'dishwasher', tv: 'tv', air_conditioning: 'air_conditioning', radiator: 'heating', desk: 'desk' };

function photoAmenities(f) {
  const seen = new Set();
  for (const x of [...(f.appliances || []), ...(f.furniture || [])]) if (TO_LISTING_AMENITY[x]) seen.add(TO_LISTING_AMENITY[x]);
  return [...seen].sort();
}

// listing: checked P3 fields {furnished, amenities}; photos: the stored analysis.vision of each photo.
// -> {issues, amenities_seen_not_in_text, analyzed, failed}. Only positive evidence is used: a photo that does not
// show a washing machine says nothing about the flat, so the absence of an object is never a contradiction.
function photoFindings(listing, photos, minConfidence = 0.5) {
  const ok = (photos || []).filter((p) => p && p.status === 'analyzed' && p.fields);
  const failed = (photos || []).filter((p) => p && p.status === 'failed').length;
  const sure = (p, k) => p.field_confidence === undefined || p.field_confidence[k] === undefined || p.field_confidence[k] >= minConfidence;
  const issues = [];
  const listed = new Set((listing && listing.amenities) || []);
  const seen = new Set();
  for (const p of ok) for (const a of photoAmenities(p.fields)) seen.add(a);
  const extra = [...seen].filter((a) => !listed.has(a)).sort();
  if (extra.length) issues.push('photos_show_amenities_not_in_text');
  const rooms = ok.filter((p) => ['bedroom', 'living_room', 'studio'].includes(p.fields.room_type));
  if (listing && listing.furnished === false && rooms.some((p) => p.fields.furnished === 'yes' && sure(p, 'furnished'))) {
    issues.push('photos_contradict_furnished');
  }
  if (listing && listing.furnished === true && rooms.length && rooms.every((p) => p.fields.furnished === 'no' && sure(p, 'furnished'))) {
    issues.push('photos_contradict_furnished');
  }
  if (ok.some((p) => (p.flags || []).includes('text_readable_after_blur'))) issues.push('photo_text_readable');
  if (ok.some((p) => (p.flags || []).includes('not_a_room'))) issues.push('photo_not_a_room');
  if (failed) issues.push('photo_analysis_failed');
  return { issues: [...new Set(issues)], amenities_seen_not_in_text: extra, analyzed: ok.length, failed };
}

if (typeof module !== 'undefined') module.exports = { P7_LISTS, P7_SCALARS, mentionsPeople, checkPhoto, photoAmenities, photoFindings };
