-- Migration 0017: Telegram albums and public photos of listings (D-086).
\ir helpers.psql
begin;
select plan(13);

insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, timezone)
values ('ZT', 'ZT', 'pgTAP telegram photos', 'TND', 'fr', 'UTC');
insert into app.users (id, email, display_name, role, jurisdiction_code) values
  ('00000000-0000-0000-0000-0000000000c1', 'owner-t@example.test', 'Owner', 'owner', 'ZT');
insert into app.listings (id, owner_id, jurisdiction_code, status, title, description, rent_minor, currency, published_at, source,
                          is_synthetic) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', 'ZT', 'published', 'Chambre', 'x', 400000, 'TND',
   now(), 'synthetic', true),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c1', 'ZT', 'draft', 'Brouillon', 'x', 300000, 'TND',
   null, 'synthetic', true);
insert into app.listing_media (listing_id, kind, storage_key, mime, bytes, sha256, moderation, created_at) values
  ('00000000-0000-0000-0000-0000000000d1', 'photo', 'media/d1/a.jpg', 'image/jpeg', 1, 'a', 'ok', now() - interval '3 min'),
  ('00000000-0000-0000-0000-0000000000d1', 'photo', 'media/d1/b.jpg', 'image/jpeg', 1, 'b', 'blurred', now() - interval '2 min'),
  ('00000000-0000-0000-0000-0000000000d1', 'photo', 'media/d1/c.jpg', 'image/jpeg', 1, 'c', 'rejected', now() - interval '1 min'),
  ('00000000-0000-0000-0000-0000000000d2', 'photo', 'media/d2/a.jpg', 'image/jpeg', 1, 'd', 'ok', now());

-- albums
select is(app.telegram_album_add('bot1', 7, 'g1', 11, 'f11', true)->>'added', 'true', 'album photo recorded');
select is(app.telegram_album_add('bot1', 7, 'g1', 11, 'f11', true)->>'added', 'false', 'the same message twice: once');
select app.telegram_album_add('bot1', 7, 'g1', 13, 'f13', false);
select app.telegram_album_add('bot1', 7, 'g1', 12, 'f12', false);
select app.telegram_album_add('bot2', 7, 'g1', 14, 'other-bot', false);
select is(app.telegram_album_status('bot1', 7, 'g1', 12)->>'taken', 'false', 'not taken before the listing claims it');
select is(app.telegram_album_claim('bot1', 7, 'g1', '00000000-0000-0000-0000-0000000000d1'),
          '[{"file_id": "f11", "message_id": 11}, {"file_id": "f12", "message_id": 12}, {"file_id": "f13", "message_id": 13}]'::jsonb,
          'the listing takes its album in message order, not another bot''s photo');
select is(app.telegram_album_claim('bot1', 7, 'g1', '00000000-0000-0000-0000-0000000000d1'), '[]'::jsonb, 'taken once');
select app.telegram_album_add('bot1', 7, 'g1', 15, 'late', false);
select is(app.telegram_album_status('bot1', 7, 'g1', 15), '{"first": false, "taken": false, "album_has_command": true, "album_has_listing": true}'::jsonb,
          'a photo that came after the claim is late');
select app.telegram_album_add('bot1', 8, 'g2', 21, 'x', false);
select app.telegram_album_add('bot1', 8, 'g2', 22, 'y', false);
select is(app.telegram_album_status('bot1', 8, 'g2', 21)->>'first', 'true', 'album without the command: its first photo');
select is(app.telegram_album_status('bot1', 8, 'g2', 22)->>'album_has_command', 'false', '... and no command in it');

-- public photos
select is(app.listing_public_photos('00000000-0000-0000-0000-0000000000d1', 10)->0->>'key', 'media/d1/a.jpg', 'oldest photo first');
select is(jsonb_array_length(app.listing_public_photos('00000000-0000-0000-0000-0000000000d1', 10)), 2, 'rejected photos are not public');
select is(app.listing_public_photos('00000000-0000-0000-0000-0000000000d2', 10), '[]'::jsonb, 'a draft has no public photo');
select ok((select (e->>'count')::int = 2 and (e->>'position')::int = 2 and jsonb_array_length(e->'keys') = 1
             from jsonb_array_elements(app.listing_photo_summary(
               array['00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000d1']::uuid[], 1)) e),
          'summary: published listings only, position kept, keys limited');
set local role api_user;
select throws_ok($$select app.listing_public_photos(gen_random_uuid(), 1)$$, '42501', null, 'api_user cannot read photo keys');
reset role;

select * from finish();
rollback;
