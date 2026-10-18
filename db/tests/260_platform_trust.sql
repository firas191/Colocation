-- Migration 0029: trust score, price benchmark, signals, submit with the trust check, moderation, reports, badges (D-107).
\ir helpers.psql
begin;
select plan(30);

insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, timezone)
values ('ZT', 'ZT', 'pgTAP trust', 'TND', 'fr', 'UTC');
insert into app.users (id, email, display_name, role, jurisdiction_code, created_at, telegram_chat_id) values
  ('00000000-0000-0000-0000-0000000006a1', 'o-p8@example.test', 'Olfa', 'user', 'ZT', now() - interval '90 days', 12345),
  ('00000000-0000-0000-0000-0000000006a2', 'x-p8@example.test', 'Xena', 'user', 'ZT', now() - interval '1 day', null),
  ('00000000-0000-0000-0000-0000000006a3', 'm-p8@example.test', 'Mehdi', 'moderator', 'ZT', now() - interval '1 year', null),
  ('00000000-0000-0000-0000-0000000006a4', 'r-p8@example.test', 'Rim', 'user', 'ZT', now(), null),
  ('00000000-0000-0000-0000-0000000006a5', 's-p8@example.test', 'Sami', 'user', 'ZT', now(), null);
\set O '''00000000-0000-0000-0000-0000000006a1'''
\set X '''00000000-0000-0000-0000-0000000006a2'''
\set M '''00000000-0000-0000-0000-0000000006a3'''

-- 1. The score is computed in code: capped points, one line per kind, block only with a hard signal
select is(app.trust_score('[{"signal": "payment_before_viewing", "points": -90}]')#>>'{signals,0,points}', '-40',
          'a model cannot give more than the cap');
select is(app.trust_score('[{"signal": "owner_abroad", "points": -5}, {"signal": "owner_abroad", "points": -10}]')->>'score', '90',
          'the strongest line per kind only');
select is(app.trust_score('[{"signal": "untraceable_payment"}, {"signal": "price_far_below"}, {"signal": "inconsistent_details"}, {"signal": "urgency_pressure"}]')->>'verdict',
          'review', 'score 20 without a hard signal: review, never block');
select is(app.trust_score('[{"signal": "duplicate_photo_other_owner"}, {"signal": "untraceable_payment"}]')->>'verdict', 'block',
          'score 30 with a hard signal: block');
select is(app.trust_score('[{"signal": "discriminatory_language", "points": -40}]')#>>'{flags,0}', 'discriminatory_language',
          'discriminatory wording: a flag, no points');
select is(app.trust_score('[{"signal": "invented", "points": -40}]')->>'score', '100', 'an unknown signal counts for nothing');
select is(app.trust_score('[]')->>'verdict', 'ok', 'nothing found: ok');

-- 2. Price benchmark: insufficient data, then a benchmark and a low price
insert into app.listings (id, owner_id, jurisdiction_code, status, kind, title, description, rent_minor, currency, rent_period, city, published_at, is_synthetic)
select ('00000000-0000-0000-0000-0000000006c' || i)::uuid, :O, 'ZT', 'published', 'room', 'Chambre ' || i, 'x', 400000 + i * 10000, 'TND', 'month',
       'Ville ZT', now() - interval '60 days', i > 3
  from generate_series(1, 5) i;
insert into app.listings (id, owner_id, jurisdiction_code, status, kind, title, description, rent_minor, currency, rent_period, city, location)
values ('00000000-0000-0000-0000-0000000006d1', :X, 'ZT', 'draft', 'room', 'Superbe chambre',
        'Chambre au centre. Contact WhatsApp 22 333 444.', 100000, 'TND', 'month', 'Ville ZT',
        st_setsrid(st_makepoint(10.1, 36.8), 4326)::geography);
select is(app.price_benchmark_for('00000000-0000-0000-0000-0000000006d1')->>'status', 'insufficient_data', 'no benchmark yet');
select ok((app.refresh_price_benchmarks()->>'benchmarks')::int > 0, 'benchmarks computed');
select is(app.price_benchmark_for('00000000-0000-0000-0000-0000000006d1')->>'source', 'seed',
          'three real listings are not enough: the seed benchmark, labelled so');
create temp table f as select app.trust_facts('00000000-0000-0000-0000-0000000006d1') as f;
select is((select x->>'points' from f, jsonb_array_elements(f->'signals') x where x->>'signal' = 'price_far_below'), '-25',
          'rent at 23% of the median: the full price signal');
select ok((select f->'signals' @> '[{"signal": "contact_off_platform"}]' from f), 'a phone number in the text');

-- 3. Photos used by another owner (and not when the same owner reposts)
insert into app.listing_media (listing_id, kind, storage_key, mime, bytes, sha256, phash, moderation) values
  ('00000000-0000-0000-0000-0000000006c1', 'photo', 'media/a.jpg', 'image/jpeg', 1000, repeat('a', 64), x'ffff0000ffff0000'::bit(64), 'ok'),
  ('00000000-0000-0000-0000-0000000006c2', 'photo', 'media/a2.jpg', 'image/jpeg', 1000, repeat('c', 64), x'0f0f0f0f0f0f0f0f'::bit(64), 'ok'),
  ('00000000-0000-0000-0000-0000000006d1', 'photo', 'media/b.jpg', 'image/jpeg', 1000, repeat('b', 64), x'ffff0000ffff0001'::bit(64), 'ok');
select ok(app.trust_facts('00000000-0000-0000-0000-0000000006d1')->'signals' @> '[{"signal": "duplicate_photo_other_owner"}]',
          'Xena''s photo is Olfa''s');
insert into app.listings (id, owner_id, jurisdiction_code, status, kind, title, description, rent_minor, currency, rent_period, city, location)
values ('00000000-0000-0000-0000-0000000006d2', :O, 'ZT', 'draft', 'room', 'Chambre calme', 'Chambre calme, visite le samedi.', 420000, 'TND', 'month',
        'Ville ZT', st_setsrid(st_makepoint(10.1, 36.8), 4326)::geography);
insert into app.listing_media (listing_id, kind, storage_key, mime, bytes, sha256, phash, moderation)
values ('00000000-0000-0000-0000-0000000006d2', 'photo', 'media/c.jpg', 'image/jpeg', 1000, repeat('d', 64), x'0f0f0f0f0f0f0f0e'::bit(64), 'ok');
select ok(not (app.trust_facts('00000000-0000-0000-0000-0000000006d2')->'signals' @> '[{"signal": "duplicate_photo_other_owner"}]'),
          'the same owner reusing a photo: no signal');
select ok(app.trust_facts('00000000-0000-0000-0000-0000000006d2')->'signals' @> '[{"signal": "consistent_history"}]',
          'Olfa published before without reports: consistent history');

-- 4. Submit with the check: 100 first, then the report decides
select is(app.listing_submit(:O, '00000000-0000-0000-0000-0000000006d2')->>'status', '100', 'ready: run the trust check');
create temp table rep as select app.trust_store('00000000-0000-0000-0000-0000000006d2', jsonb_build_object('signals',
  app.trust_facts('00000000-0000-0000-0000-0000000006d2')->'signals')) as r;
select is((select r->>'verdict' from rep), 'ok', 'an honest listing: ok');
select is(app.listing_submit(:O, '00000000-0000-0000-0000-0000000006d2', jsonb_build_object('report_id', (select r->>'report_id' from rep)))#>>'{data,checked}',
          'true', 'published, trust-checked');
create temp table rep2 as select app.trust_store('00000000-0000-0000-0000-0000000006d1', jsonb_build_object('signals',
  app.trust_facts('00000000-0000-0000-0000-0000000006d1')->'signals')) as r;
select is((select r->>'verdict' from rep2), 'block', 'stolen photo and a very low price: block');
select is(app.listing_submit(:X, '00000000-0000-0000-0000-0000000006d1', jsonb_build_object('report_id', (select r->>'report_id' from rep2)))#>>'{error,details,0,issue}',
          'rejected', 'the owner is told it was refused');
select is((select status from app.listings where id = '00000000-0000-0000-0000-0000000006d1'), 'rejected', 'and it is not published');
update app.listings set status = 'draft' where id = '00000000-0000-0000-0000-0000000006d1';
create temp table rep3 as select app.trust_store('00000000-0000-0000-0000-0000000006d1', '{"signals": [{"signal": "price_far_below", "points": -25}, {"signal": "contact_off_platform"}]}') as r;
select is(app.listing_submit(:X, '00000000-0000-0000-0000-0000000006d1', jsonb_build_object('report_id', (select r->>'report_id' from rep3)))#>>'{error,details,0,issue}',
          'in_review', 'score 65: in review');
select is((select count(*)::int from app.moderation_queue where entity_id = '00000000-0000-0000-0000-0000000006d1' and status = 'open'), 1, 'queued for a moderator');

-- 5. Moderation: staff only, the decision and the audit log
select is(app.moderation_list(:X, '{}')->>'status', '403', 'not staff: 403');
create temp table q as select id from app.moderation_queue where entity_id = '00000000-0000-0000-0000-0000000006d1' and status = 'open';
select is(app.moderation_decide(:M, jsonb_build_object('params', jsonb_build_object('id', (select id from q)), 'body', '{"action": "approve", "note": "photos vérifiées"}'::jsonb))#>>'{data,effect}',
          'published', 'the moderator approves: published');
select is((select count(*)::int from app.audit_log where action = 'moderation_decision' and actor_id = :M and detail->>'note' = 'photos vérifiées'), 1,
          'the decision, its note and its author are in the audit log');
select is(app.moderation_decide(:M, jsonb_build_object('params', jsonb_build_object('id', (select id from q)), 'body', '{"action": "reject"}'::jsonb))->>'status',
          '409', 'decided once');

-- 6. Reports: one item per target, raised by a second reporter
insert into app.reports (reporter_id, listing_id, reason, target_type) values
  ('00000000-0000-0000-0000-0000000006a4', '00000000-0000-0000-0000-0000000006c1', 'spam', 'listing');
insert into app.reports (reporter_id, listing_id, reason, target_type) values
  ('00000000-0000-0000-0000-0000000006a5', '00000000-0000-0000-0000-0000000006c1', 'spam', 'listing');
select is((select reports || ':' || priority from app.moderation_queue where entity_id = '00000000-0000-0000-0000-0000000006c1' and status = 'open'),
          '2:4', 'two reports on one item, one step more urgent');

-- 7. Badges name what was checked
select is(app.user_badges(:O), '[{"code": "photos_checked"}, {"code": "telegram_linked"}]'::jsonb, 'Olfa: Telegram linked, photos checked');
select is(app.user_badges(:X), '[]'::jsonb, 'Xena: nothing checked');

select * from finish();
rollback;
