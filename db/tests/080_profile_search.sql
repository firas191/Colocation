-- Phase 3 (migration 0008): money, exchange rates, rent period, fuzzed locations,
-- places, search, profiles, prompt registry, agent steps.
\ir helpers.psql
begin;
select plan(65);

-- ---------------------------------------------------------------- money
select is(app.currency_exponent('TND')::int, 3, 'TND has 3 decimals (millimes)');
select is(app.currency_exponent('jpy')::int, 0, 'JPY has none (code is case-insensitive)');
select is(app.currency_exponent('EUR')::int, 2, 'EUR has 2');
select is(app.to_minor(450, 'TND'), 450000::bigint, '450 dinars are 450000 millimes, not 450 (the x1000 trap)');
select is(app.to_minor(0.001, 'TND'), 1::bigint, 'one millime');
select is(app.to_minor(12.5, 'EUR'), 1250::bigint, '12.50 EUR');
select is(app.to_minor(1500, 'JPY'), 1500::bigint, 'yen: minor unit = major unit');
select is(app.to_minor(12.345, 'EUR'), null, 'more decimals than the currency has: rejected (NULL)');
select is(app.to_minor(1.5, 'JPY'), null, 'fractional yen: rejected');
select is(app.to_minor(10, 'XXX'), null, 'unknown currency: NULL');

-- ---------------------------------------------------------------- exchange rates (test values, not real rates)
select is(app.store_fx_rates('{"rates":[
  {"base":"EUR","quote":"USD","rate":"1.10","as_of":"2026-01-05","source":"pgtap"},
  {"base":"EUR","quote":"GBP","rate":"0.85","as_of":"2026-01-05","source":"pgtap"},
  {"base":"EUR","quote":"JPY","rate":"160","as_of":"2026-01-05","source":"pgtap"},
  {"base":"EUR","quote":"XXX","rate":"2","as_of":"2026-01-05","source":"pgtap"}]}'), 3, 'three rates stored, unknown currency skipped');
select is(app.store_fx_rates('{"rates":[{"base":"EUR","quote":"USD","rate":"1.11","as_of":"2026-01-05","source":"pgtap2"}]}'), 1,
  'same pair and date: updated');
select is((app.fx_quote('EUR', 'GBP', '2026-01-06')->>'path') || ' ' || (app.fx_quote('EUR', 'GBP', '2026-01-06')->>'rate'),
  'direct 0.85000000', 'direct rate');
select is(app.fx_quote('GBP', 'EUR', '2026-01-06')->>'path', 'inverse', 'inverse rate');
select is(round((app.fx_quote('GBP', 'USD', '2026-01-06')->>'rate')::numeric, 6), round(1.11 / 0.85, 6), 'cross rate through EUR');
select is(app.fx_quote('GBP', 'USD', '2026-01-06')->>'path', 'cross_eur', 'cross rate labelled as derived');
select is(app.fx_quote('TND', 'EUR', '2026-01-06'), null, 'no rate for TND: NULL, never a guess');
select is(app.fx_quote('EUR', 'GBP', '2026-02-01'), null, 'rate older than fx.max_age_days: not used');
select is(app.fx_quote('EUR', 'GBP', '2026-01-04'), null, 'rate published after the date: not used');
select is(app.fx_quote('TND', 'TND')->>'path', 'identity', 'same currency');
select is((app.fx_convert_minor(10000, 'EUR', 'JPY', '2026-01-05')->>'amount_minor')::bigint, 16000::bigint,
  '100.00 EUR = 16000 JPY (exponent 2 to 0)');
select is((app.fx_convert_minor(1000, 'JPY', 'EUR', '2026-01-05')->>'amount_minor')::bigint, 625::bigint,
  '1000 JPY = 6.25 EUR (exponent 0 to 2)');
select is((app.fx_convert_minor(10000, 'GBP', 'USD', '2026-01-05')->>'amount_minor')::bigint, round(10000 * 1.11 / 0.85)::bigint,
  '100.00 GBP to USD through EUR, rounded to the cent');
select lives_ok($$ select app.store_fx_rates('{"rates":[{"base":"EUR","quote":"TND","rate":"3.4","as_of":"2026-01-05","source":"pgtap"}]}') $$,
  'a TND test rate');
select is((app.fx_convert_minor(450000, 'TND', 'EUR', '2026-01-05')->>'amount_minor')::bigint, round(450 / 3.4 * 100)::bigint,
  '450 TND (450000 millimes) to EUR cents: exponent 3 to 2');

-- ---------------------------------------------------------------- fixtures
insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, timezone)
values ('ZW', 'ZW', 'pgTAP search', 'TND', 'fr', 'UTC'), ('ZV', 'ZV', 'pgTAP other', 'GBP', 'en', 'UTC');
insert into app.users (id, email, display_name, role) values
  ('00000000-0000-0000-0000-0000000000c1', 'owner@example.test', 'Owner', 'owner'),
  ('00000000-0000-0000-0000-0000000000c2', 'seeker@example.test', 'Seeker', 'user');

-- ---------------------------------------------------------------- rent period
insert into app.listings (id, owner_id, jurisdiction_code, status, title, rent_minor, currency, rent_period)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', 'ZV', 'published', 'weekly room', 15000, 'GBP', 'week');
select is((select rent_monthly_minor from app.listings where id = '00000000-0000-0000-0000-0000000000d1'), 65000::bigint,
  'weekly rent 150.00 GBP is 650.00 GBP per month (x 52 / 12)');

-- ---------------------------------------------------------------- fuzzed public location
insert into app.listings (id, owner_id, jurisdiction_code, status, title, description, rent_minor, currency, location, city, published_at)
values ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c1', 'ZW', 'published',
        'Chambre meublée Ennasr', 'Chambre calme, proche du métro, internet inclus', 450000, 'TND',
        'SRID=4326;POINT(10.1700 36.8600)', 'Ariana', now() - interval '1 day');
select ok((select st_distance(location, public_location) between 149 and 401 from app.listings where id = '00000000-0000-0000-0000-0000000000d2'),
  'public point is 150 to 400 m from the exact point');
select st_astext(public_location) as pub1 from app.listings where id = '00000000-0000-0000-0000-0000000000d2' \gset
update app.listings set title = 'Chambre meublée Ennasr 2' where id = '00000000-0000-0000-0000-0000000000d2';
select is((select st_astext(public_location) from app.listings where id = '00000000-0000-0000-0000-0000000000d2'), :'pub1',
  'other updates keep the public point');
update app.listings set public_location = location where id = '00000000-0000-0000-0000-0000000000d2';
select is((select st_astext(public_location) from app.listings where id = '00000000-0000-0000-0000-0000000000d2'), :'pub1',
  'the public point cannot be set to the exact point directly');
update app.listings set location = 'SRID=4326;POINT(10.1710 36.8610)' where id = '00000000-0000-0000-0000-0000000000d2';
select isnt((select st_astext(public_location) from app.listings where id = '00000000-0000-0000-0000-0000000000d2'), :'pub1',
  'a new exact point draws a new public point');
insert into app.listings (id, owner_id, jurisdiction_code, status, title, location)
values ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000c1', 'ZW', 'draft', 'twin', 'SRID=4326;POINT(10.1710 36.8610)');
select isnt((select st_astext(public_location) from app.listings where id = '00000000-0000-0000-0000-0000000000d3'),
            (select st_astext(public_location) from app.listings where id = '00000000-0000-0000-0000-0000000000d2'),
  'two listings at the same address get different public points');
update app.listings set location = null where id = '00000000-0000-0000-0000-0000000000d3';
select is((select public_location from app.listings where id = '00000000-0000-0000-0000-0000000000d3'), null, 'no exact point, no public point');

-- ---------------------------------------------------------------- places (test coordinates, not real ones)
insert into app.places (place_key, jurisdiction_code, kind, name, city, location, source) values
  ('zw-ennasr', 'ZW', 'neighbourhood', 'Ennasr', 'Ariana', 'SRID=4326;POINT(10.1650 36.8580)', 'test'),
  ('zw-marsa', 'ZW', 'city', 'La Marsa', 'La Marsa', 'SRID=4326;POINT(10.3200 36.8800)', 'test'),
  ('zw-menzah-1', 'ZW', 'neighbourhood', 'El Menzah 1', 'Tunis', 'SRID=4326;POINT(10.1800 36.8400)', 'test'),
  ('zw-menzah-6', 'ZW', 'neighbourhood', 'El Menzah 6', 'Ariana', 'SRID=4326;POINT(10.1750 36.8500)', 'test'),
  ('zv-camden', 'ZV', 'district', 'Camden', 'London', 'SRID=4326;POINT(-0.1400 51.5400)', 'test');
insert into app.place_names (place_id, name, lang)
select p.id, n.name, n.lang from app.places p join (values
  ('zw-ennasr', 'Ennasr', 'fr'), ('zw-ennasr', 'En-Nasr', 'fr'), ('zw-ennasr', 'النصر', 'ar'), ('zw-ennasr', 'Cité Ennasr', 'fr'),
  ('zw-marsa', 'La Marsa', 'fr'), ('zw-marsa', 'Marsa', 'aeb-Latn'), ('zw-marsa', 'المرسى', 'ar'),
  ('zw-menzah-1', 'El Menzah 1', 'fr'), ('zw-menzah-1', 'Menzah', 'fr'),
  ('zw-menzah-6', 'El Menzah 6', 'fr'), ('zw-menzah-6', 'Menzah', 'fr'),
  ('zv-camden', 'Camden', 'en')) n(k, name, lang) on n.k = p.place_key;
select is(app.geo_normalize('  Cité   EN-NASR !'), 'cite en nasr', 'normaliser: accents, case, punctuation, spaces');
select is(app.geocode('en nasr', 'ZW')#>>'{place,place_key}', 'zw-ennasr', 'found by a normalised name');
select is(app.geocode('النصر', 'ZW')#>>'{place,place_key}', 'zw-ennasr', 'found by the Arabic name');
select is(app.geocode('près de La Marsa svp', 'ZW')->>'status', 'found', 'a known name inside a longer text');
select is(app.geocode('Menzah', 'ZW')->>'status', 'ambiguous', 'a name shared by two places is ambiguous');
select is(jsonb_array_length(app.geocode('Menzah', 'ZW')->'candidates'), 2, 'both candidates returned');
select is(app.geocode('El Menzah 6', 'ZW')#>>'{place,place_key}', 'zw-menzah-6', 'the full name resolves the ambiguity');
select is(app.geocode('Sfax', 'ZW')->>'status', 'not_found', 'unknown place: not_found');
select is(app.geocode('Camden', 'ZW')->>'status', 'not_found', 'places of other jurisdictions are not used');
select is(app.geocode('', 'ZW')->>'status', 'not_found', 'empty text: not_found');

-- ---------------------------------------------------------------- search_public
insert into app.listings (id, owner_id, jurisdiction_code, status, title, description, rent_minor, currency, location, city, published_at)
values ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000c1', 'ZW', 'published',
        'Studio La Marsa', 'Studio lumineux près de la plage', 900000, 'TND', 'SRID=4326;POINT(10.3210 36.8810)', 'La Marsa', now());
select is((select string_agg(e->>'title', ',' order by (e->>'rank')::int) from jsonb_array_elements(app.search_public('{"jurisdiction":"ZW"}')->'results') e),
  'Studio La Marsa,Chambre meublée Ennasr 2', 'filters only: published listings of the jurisdiction, newest first');
select is((select string_agg(e->>'title', ',') from jsonb_array_elements(app.search_public('{"jurisdiction":"ZW","max_rent_minor":500000}')->'results') e),
  'Chambre meublée Ennasr 2', 'budget filter in minor units');
select is(app.search_public('{"jurisdiction":"ZW","max_rent_minor":100000,"currency":"EUR","on_date":"2026-01-05"}')#>>'{applied,budget,max_rent_monthly_minor}',
  round(1000 * 3.4 * 1000)::text, 'a budget in another currency is converted to the jurisdiction currency (1000.00 EUR to millimes)');
select is(app.search_public('{"jurisdiction":"ZW","max_rent_minor":100000,"currency":"EUR","on_date":"2026-09-01"}')->'warnings',
  '["fx_rate_unavailable"]'::jsonb, 'no usable rate: budget not applied and a warning code returned');
select is(app.search_public('{"jurisdiction":"ZW","max_rent_minor":100000,"currency":"EUR","on_date":"2026-09-01"}')->>'count', '2',
  '... and the results are not filtered by a guessed amount');
select is((select string_agg(e->>'title', ',') from jsonb_array_elements(app.search_public('{"jurisdiction":"ZW","place":"La Marsa","radius_m":2000}')->'results') e),
  'Studio La Marsa', 'place name resolved and used as the centre of a radius');
select is(app.search_public('{"jurisdiction":"ZW","place":"Menzah"}')->'warnings', '["place_ambiguous"]'::jsonb, 'ambiguous place: warning, no distance filter');
select is((select string_agg(e->>'title', ',') from jsonb_array_elements(app.search_public('{"jurisdiction":"ZW","q_text":"plage"}')->'results') e),
  'Studio La Marsa', 'text search (lexical leg) without a vector');
select is(app.search_public('{"jurisdiction":"ZW","q_text":"plage"}')->>'mode', 'hybrid', 'text given: hybrid mode');
select ok(not exists (select 1 from jsonb_array_elements(app.search_public('{"jurisdiction":"ZW"}')->'results') e where e ? 'location'),
  'results never carry the exact location');
select ok((select bool_and(e ? 'public_location' and (e->>'is_synthetic') is not null)
             from jsonb_array_elements(app.search_public('{"jurisdiction":"ZW"}')->'results') e), 'results carry the public point and the synthetic flag');
select is(app.search_public('{"jurisdiction":"QQ"}')->>'error', 'unknown_jurisdiction', 'unknown jurisdiction');

-- ---------------------------------------------------------------- profiles
select is(app.save_profile('00000000-0000-0000-0000-0000000000c2', '{"jurisdiction_code":"ZW","budget_max_minor":500000,
  "currency":"TND","budget_period":"month","anchor_label":"En Nasr","languages":["fr","ar"],"declared_preferences":{"smoking":"no"}}')#>>'{anchor_geocode,status}',
  'found', 'profile saved; anchor label geocoded');
select is(app.save_profile('00000000-0000-0000-0000-0000000000c2', '{"jurisdiction_code":"ZW","budget_max_minor":600000,"currency":"TND"}')->>'profile_version',
  '2', 'saving again updates the profile and its version');
select is((select raw_text from app.profiles where user_id = '00000000-0000-0000-0000-0000000000c2'), null, 'the request text is not stored');

-- ---------------------------------------------------------------- prompt registry
insert into ai.prompts (id, name, agent, role) values ('00000000-0000-0000-0000-0000000000e1', 'pgtap_prompt', 'A0', 'test');
insert into ai.prompt_versions (prompt_id, version, template, status) values
  ('00000000-0000-0000-0000-0000000000e1', 1, 'one', 'retired'), ('00000000-0000-0000-0000-0000000000e1', 2, 'two', 'active');
select is(ai.prompt_for('pgtap_prompt')->>'template', 'two', 'the active version by default');
select is(ai.prompt_for('pgtap_prompt', 1)->>'template', 'one', 'a given version on request');

-- ---------------------------------------------------------------- agent steps with the request record
select lives_ok($$ select app.api_finish('{"request_id":"00000000-0000-0000-0000-0000000000f1","workflow":"pgtap","status_code":200,
  "latency_ms":12,"steps":[{"agent":"A0","model":"m","tokens_in":10,"tokens_out":5,"latency_ms":4,"output":{"intent":"x"}},
                           {"agent":"A2","tokens_in":7,"tokens_out":3}]}') $$, 'request with two agent steps recorded');
select is((select tokens_in || '/' || tokens_out from ai.executions where request_id = '00000000-0000-0000-0000-0000000000f1'), '17/8',
  'tokens of the steps summed on the execution');
select is((select string_agg(step_index || ':' || agent, ',' order by step_index) from ai.agent_steps s
           join ai.executions e on e.id = s.execution_id where e.request_id = '00000000-0000-0000-0000-0000000000f1'), '0:A0,1:A2', 'steps in order');

-- ---------------------------------------------------------------- privileges
select is(pg_temp.as_user('api_user', '00000000-0000-0000-0000-0000000000c2',
  $$select rent_monthly_minor::text from app.listings where id = '00000000-0000-0000-0000-0000000000d1'$$), '65000', 'user role reads the monthly rent');

select is(app.extraction_context('ZW') is not null, true, 'extraction context available');
select is((select value->'granite4.2:3b'->>'think' from app.settings where key = 'llm.model_overrides'), 'false',
  'granite4.2 is told not to think (F-048)');
select * from finish();
rollback;
