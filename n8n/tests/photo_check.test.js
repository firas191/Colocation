// P7 checks (lib/photo_check.js, D-081) and image input in lib/llm.js.
const test = require('node:test');
const assert = require('node:assert');
const { checkPhoto, photoFindings, mentionsPeople, photoAmenities } = require('../src/lib/photo_check.js');
const { buildRequest, retryBody } = require('../src/lib/llm.js');

const v2 = { room_type: 'bedroom', beds: 'not_visible', bed_kinds: ['double', 'double'], furniture: ['desk', 'wardrobe', 'desk'],
  appliances: ['radiator'], bathroom_fixtures: [], windows: 1, natural_light: 'some', condition: 'poor',
  condition_signs: ['damp_or_mould'], furnished: 'yes', readable_text: true, people_visible: true,
  issues: ['photo is dark', 'a man is sleeping on the bed'], field_confidence: { room_type: 0.9, furnished: 1.2, foo: 0.5 } };

test('answers are tidied, people text dropped, review flags raised', () => {
  const c = checkPhoto(v2);
  assert.deepStrictEqual(c.fields.furniture, ['wardrobe', 'desk']);             // vocabulary order, no duplicates
  assert.deepStrictEqual(c.fields.bed_kinds, ['double']);
  assert.strictEqual(c.fields.beds, 'not_visible');
  assert.deepStrictEqual(c.issues, ['photo is dark']);
  assert.deepStrictEqual(c.dropped, ['issues_about_people']);
  assert.deepStrictEqual(c.field_confidence, { room_type: 0.9 });               // out of range and unknown keys removed
  assert.deepStrictEqual(c.flags, ['person_in_photo', 'text_readable_after_blur', 'condition_to_check']);
  const v1 = checkPhoto({ ...v2, issues: undefined, field_confidence: undefined, description: 'Une femme dort.' });
  assert.strictEqual(v1.description, null);
  assert.deepStrictEqual(v1.dropped, ['description_about_people']);
  assert.strictEqual(checkPhoto({ ...v2, description: 'Bright room with a desk.' }).description, 'Bright room with a desk.');
});

test('people words in several languages, not inside other words', () => {
  for (const t of ['a woman', 'deux personnes', 'un étudiant', 'رجل', 'tfol sghir', 'The OWNER']) assert.ok(mentionsPeople(t), t);
  for (const t of ['personnel room', 'mannequin', 'womanless', 'shelves and a desk', '']) assert.ok(!mentionsPeople(t), t);
});

test('photo findings use only what the photos show', () => {
  const ph = (fields, extra = {}) => ({ status: 'analyzed', fields: { room_type: 'bedroom', furniture: [], appliances: [], ...fields },
    flags: [], field_confidence: {}, ...extra });
  assert.deepStrictEqual(photoAmenities({ furniture: ['desk', 'sofa'], appliances: ['radiator', 'hob', 'tv'] }), ['desk', 'heating', 'tv']);
  let f = photoFindings({ furnished: true, amenities: ['tv', 'wifi'] }, [ph({ appliances: ['tv', 'washing_machine'], furnished: 'yes' })]);
  assert.deepStrictEqual(f, { issues: ['photos_show_amenities_not_in_text'], amenities_seen_not_in_text: ['washing_machine'], analyzed: 1, failed: 0 });
  // text says unfurnished, a bedroom photo shows a furnished room -> contradiction; a low confidence does not count
  f = photoFindings({ furnished: false, amenities: [] }, [ph({ furnished: 'yes' })]);
  assert.ok(f.issues.includes('photos_contradict_furnished'));
  f = photoFindings({ furnished: false, amenities: [] }, [ph({ furnished: 'yes' }, { field_confidence: { furnished: 0.3 } })]);
  assert.ok(!f.issues.includes('photos_contradict_furnished'));
  // text says furnished: only a contradiction when every room photo is empty; a kitchen does not count
  f = photoFindings({ furnished: true, amenities: [] }, [ph({ furnished: 'no' }), ph({ room_type: 'kitchen', furnished: 'yes' })]);
  assert.ok(f.issues.includes('photos_contradict_furnished'));
  f = photoFindings({ furnished: true, amenities: [] }, [ph({ furnished: 'no' }), ph({ furnished: 'yes' })]);
  assert.ok(!f.issues.includes('photos_contradict_furnished'));
  // nothing seen is never a contradiction; failures and flags are reported
  f = photoFindings({ furnished: null, amenities: ['washing_machine'] }, [ph({ furnished: 'not_visible' }, { flags: ['not_a_room', 'text_readable_after_blur'] }),
    { status: 'failed', error_code: 'invalid_json' }]);
  assert.deepStrictEqual(f.issues, ['photo_text_readable', 'photo_not_a_room', 'photo_analysis_failed']);
  assert.deepStrictEqual(photoFindings({}, []), { issues: [], amenities_seen_not_in_text: [], analyzed: 0, failed: 0 });
});

test('images go with the user message and survive the retry', () => {
  const prompt = { template: '## system\nS\n## user\nDescribe this photo.', output_schema: { type: 'object' }, params: { temperature: 0 } };
  const cfg = { base_url: 'http://ollama:11434/', default_model: 'qwen3.5:4b' };
  const { body } = buildRequest(prompt, {}, cfg, null, ['AAAA']);
  assert.deepStrictEqual(body.messages[1], { role: 'user', content: 'Describe this photo.', images: ['AAAA'] });
  assert.strictEqual(body.messages[0].images, undefined);
  assert.deepStrictEqual(retryBody(body, 'bad', 'not valid JSON').messages[1].images, ['AAAA']);
  assert.strictEqual(buildRequest(prompt, {}, cfg, null, []).body.messages[1].images, undefined);
});

const { scoreP7, summarizeP7 } = require('../../eval/lib/prompt_metrics.js');
const gold = { room_type: 'bedroom', room_type_alt: ['studio'], beds: 1, bed_kinds: ['double'], furniture: ['wardrobe', 'desk'],
  furniture_maybe: ['chair'], appliances: [], bathroom_fixtures: [], windows: null, natural_light: 'good', condition: 'good',
  condition_signs: [], furnished: 'yes', readable_text: false, people_visible: false };

test('P7 scoring: accuracy on determinable fields, hallucinated objects, abstentions', () => {
  const ans = { room_type: 'studio', beds: 'not_visible', bed_kinds: ['double'], furniture: ['wardrobe', 'chair', 'sofa'], appliances: ['tv'],
    bathroom_fixtures: [], windows: 2, natural_light: 'good', condition: 'fair', condition_signs: [], furnished: 'yes',
    readable_text: false, people_visible: false, issues: ['a girl on the bed'], field_confidence: { condition: 0.9 } };
  const m = scoreP7(ans, gold);
  assert.deepStrictEqual([m.right, m.wrong, m.abstained, m.unsupported, m.abstain_ok], [5, 2, 1, 1, 0]);
  assert.deepStrictEqual([m.hits, m.hallucinated, m.missed], [2, 2, 1]);                   // chair is a maybe: ignored
  assert.deepStrictEqual(m.objects.furniture, { hit: ['wardrobe'], hallucinated: ['sofa'], missed: ['desk'] });
  assert.strictEqual(m.confident_wrong, 1);
  assert.ok(m.people_described && m.failures.includes('describes_people') && m.failures.includes('hallucinated_object'));
  const bad = scoreP7(null, gold);
  assert.deepStrictEqual([bad.right, bad.wrong, bad.missed, bad.hallucinated], [0, 7, 3, 0]);
  const okNv = scoreP7({ ...ans, windows: 'not_visible', issues: [] }, gold);
  assert.deepStrictEqual([okNv.abstain_ok, okNv.unsupported, okNv.people_described], [1, 0, false]);
  const s = summarizeP7([{ metrics: m, tags: ['bedroom'], latency_ms: 10 }, { metrics: bad, tags: ['bedroom'], latency_ms: 20 }]);
  assert.strictEqual(s.field_accuracy, 0.3571);                                      // 5 of 14 determinable
  assert.strictEqual(s.hallucination_rate, 0.5);
  assert.deepStrictEqual([s.hallucinated_items, s.people_described_items, s.json_valid], [1, 1, 0.5]);
  assert.deepStrictEqual(s.per_field.beds, { right: 0, determinable: 2, unsupported: 0, accuracy: 0 });
});
