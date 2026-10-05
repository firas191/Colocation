-- Phase 4.4 (migration 0011): storing the listing extraction (P3), rent scope, rent ranges.
\ir helpers.psql
begin;
select plan(19);

insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, timezone)
values ('ZX', 'ZX', 'pgTAP extract', 'TND', 'fr', 'UTC');
insert into app.users (id, email, display_name, role) values
  ('00000000-0000-0000-0000-0000000000d1', 'owner-x@example.test', 'Owner', 'owner');
create temp table t_l as select (app.listing_create('00000000-0000-0000-0000-0000000000d1',
  '{"jurisdiction_code":"ZX","text":"Chambre meublée dans un S+2, 450.000 DT CC"}')->>'listing_id')::uuid as id;

select ok((app.extraction_context('ZX')->'rent_ranges') ? 'TND', 'the extraction context carries the rent ranges');
select is((app.extraction_context('ZX')#>>'{rent_ranges,TND,1}')::int, 10000, 'TND range from the setting');

create temp table t_p as select '{"fields": {"kind": "roommate_wanted", "rent_minor": 450000, "currency": "TND",
  "rent_period": "month", "rent_scope": "per_room", "deposit_minor": 450000, "bills_included": true,
  "available_from": "2026-11-01", "bedrooms": 2, "furnished": true, "amenities": ["wifi", "air_conditioning"],
  "house_rules": {"smoking": "no"}, "city": null, "neighbourhood": "Ennasr 2"},
  "description_lang": "fr", "extraction": {"address_text": "12 rue X", "issues": []}}'::jsonb as p;
select is(app.store_listing_extraction((select id from t_l), (select p from t_p))->>'ok', 'true', 'extraction stored');
select is((select rent_minor || ' ' || currency || ' ' || rent_period || ' ' || rent_scope || ' ' || rent_monthly_minor
           from app.listings where id = (select id from t_l)), '450000 TND month per_room 450000', 'rent with scope and period');
select is((select kind || ' ' || bedrooms || ' ' || furnished || ' ' || bills_included || ' ' || available_from
           from app.listings where id = (select id from t_l)), 'roommate_wanted 2 true true 2026-11-01', 'scalar fields');
select is((select amenities from app.listings where id = (select id from t_l)), '{air_conditioning,wifi}'::text[], 'amenities sorted');
select is((select house_rules from app.listings where id = (select id from t_l)), '{"smoking": "no"}'::jsonb, 'house rules');
select is((select description_lang || ' ' || neighbourhood || ' ' || coalesce(city, '-') from app.listings where id = (select id from t_l)),
  'fr Ennasr 2 -', 'language and place words');
select ok((select extraction ? 'stored_at' and extraction->>'address_text' = '12 rue X' from app.listings where id = (select id from t_l)),
  'the exact address stays inside extraction, with the time it was stored');
select is(app.listing_owner_view('00000000-0000-0000-0000-0000000000d1', (select id from t_l))->>'rent_scope', 'per_room',
  'the owner''s view shows the rent scope');

-- a second analysis replaces the extracted values; a null kind keeps the current kind
select app.store_listing_extraction((select id from t_l), '{"fields": {"kind": null, "rent_minor": null, "currency": null,
  "amenities": [], "house_rules": {}}, "extraction": {"issues": ["rent_out_of_range"]}}');
select is((select kind || ' ' || coalesce(rent_minor::text, '-') || ' ' || coalesce(rent_scope, '-') || ' ' || rent_period
           from app.listings where id = (select id from t_l)), 'roommate_wanted - - month', 'rent cleared, kind kept, period back to month');

select is(app.store_listing_extraction((select id from t_l), '{"fields": {"rent_minor": 100, "currency": "XYZ"}}')->>'error_code',
  'VALIDATION_FAILED', 'unknown currency refused');
select is(app.store_listing_extraction(gen_random_uuid(), (select p from t_p))->>'error_code', 'NOT_FOUND', 'unknown listing');
update app.listings set status = 'published' where id = (select id from t_l);
select is(app.store_listing_extraction((select id from t_l), (select p from t_p))->>'error_code', 'CONFLICT',
  'a published listing is not overwritten');
select throws_ok($$update app.listings set rent_scope = 'per_flat' where id = (select id from t_l)$$, '23514', null,
  'rent_scope is a closed list');

-- agent steps of a job worker
create temp table t_e as select app.record_job_steps('00000000-0000-0000-0000-0000000000b9', 'wf.listing.extract', '77',
  '[{"agent": "A1_extract", "model": "m1", "prompt_version_id": null, "input": {"chars": 40}, "output": {"kind": "room"},
     "latency_ms": 1200, "tokens_in": 300, "tokens_out": 90, "error": null}]') as id;
select is((select status || ' ' || channel || ' ' || tokens_in || ' ' || tokens_out || ' ' || latency_ms || ' ' || request_id
           from ai.executions where id = (select id from t_e)),
  'succeeded job 300 90 1200 00000000-0000-0000-0000-0000000000b9', 'one execution per call, request id = job id');
select is((select agent || ' ' || step_index || ' ' || (input->>'chars') from ai.agent_steps where execution_id = (select id from t_e)),
  'A1_extract 0 40', 'with its steps');
create temp table t_e2 as select app.record_job_steps(gen_random_uuid(), 'w', null,
  '[{"agent": "A1_extract", "error": "schema_invalid"}]') as id;
select is((select status || ' ' || error from ai.executions where id = (select id from t_e2)), 'failed schema_invalid',
  'a step error fails the execution');

select is(pg_temp.as_user('api_user', '00000000-0000-0000-0000-0000000000d1',
  'select app.store_listing_extraction(gen_random_uuid(), ''{}''::jsonb)'), 'ERROR 42501', 'api_user cannot store an extraction');

select * from finish();
rollback;
