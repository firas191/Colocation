-- Migration 0013: P7 photo analysis storage, vision settings, photo golden sets (D-081, D-082).
\ir helpers.psql
begin;
select plan(9);

insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, timezone)
values ('ZV', 'ZV', 'pgTAP vision', 'TND', 'fr', 'UTC');
insert into app.users (id, email, display_name, role) values
  ('00000000-0000-0000-0000-0000000000e1', 'owner-v@example.test', 'Owner', 'owner');
create temp table t_l as select (app.listing_create('00000000-0000-0000-0000-0000000000e1',
  '{"jurisdiction_code":"ZV","text":"Chambre meublée"}')->>'listing_id')::uuid as id;
insert into app.listing_media (id, listing_id, kind, storage_key, mime, bytes, sha256, analysis)
values ('00000000-0000-0000-0000-0000000000e2', (select id from t_l), 'photo', 'media/x/y.jpg', 'image/jpeg', 10, 'abc',
        '{"exif": {"has_gps": false}, "blur": {"applied": false}}');

select is(app.store_photo_analysis('00000000-0000-0000-0000-0000000000e2',
  '{"status": "analyzed", "fields": {"room_type": "bedroom"}, "flags": []}')->>'ok', 'true', 'analysis stored');
select ok((select analysis->'exif' is not null and analysis#>>'{vision,fields,room_type}' = 'bedroom'
                  and analysis->'vision' ? 'stored_at'
           from app.listing_media where id = '00000000-0000-0000-0000-0000000000e2'),
  'stored under analysis.vision; the Media service report is kept');
select is(app.store_photo_analysis('00000000-0000-0000-0000-0000000000e2', '{"status": "failed", "error_code": "invalid_json"}')
            ->>'ok', 'true', 'a failed analysis replaces the earlier one');
select is((select analysis#>>'{vision,status}' from app.listing_media where id = '00000000-0000-0000-0000-0000000000e2'),
  'failed', 'status replaced');
select throws_ok($$select app.store_photo_analysis('00000000-0000-0000-0000-0000000000e2', '{"status": "maybe"}')$$,
  '22023', null, 'unknown status refused');
select is(app.store_photo_analysis(gen_random_uuid(), '{"status": "failed"}')->>'error_code', 'NOT_FOUND', 'unknown photo');
select is((select value::text from app.settings where key = 'vision.enabled'), 'true', 'vision on by default');
select lives_ok($$insert into eval.datasets (name, kind, version) values ('pgtap_p7', 'vision', 1)$$, 'vision golden sets allowed');
set local role api_user;
select throws_ok($$select app.store_photo_analysis('00000000-0000-0000-0000-0000000000e2', '{"status": "failed"}')$$,
  '42501', null, 'api_user cannot store an analysis');
reset role;

select * from finish();
rollback;
