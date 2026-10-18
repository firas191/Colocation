-- Migration 0026: households, invites, split arithmetic, balances, settlements, reminders (D-104).
\ir helpers.psql
begin;
select plan(37);

-- 1. Split arithmetic: the shares always sum to the amount, for every mode, 2 to 6 people, amounts that do not divide
create temp table r as
select n, amt, mode,
       api.split(amt, mode, array(select ('00000000-0000-0000-0000-0000000003' || lpad(i::text, 2, '0'))::uuid from generate_series(1, n) i),
                 case mode when 'shares' then array(select (i % 3 + 1)::bigint from generate_series(1, n) i)
                           when 'exact' then array(select case when i = 1 then amt - (n - 1) else 1 end from generate_series(1, n) i) end) as s
  from generate_series(2, 6) n, unnest(array[1000::bigint, 1001, 999, 7, 100003, 12345]) amt, unnest(array['equal', 'shares', 'exact']) mode;
select is((select count(*)::int from r where (select sum((x->>'share_minor')::bigint) from jsonb_array_elements(s->'shares') x) <> amt), 0,
          'every split sums to the amount (90 cases)');
select is((select count(*)::int from r where s ? 'error'), 0, 'no case refused');
select is(api.split(1000, 'equal', array['00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000302',
            '00000000-0000-0000-0000-000000000303']::uuid[], null)->'shares',
          '[{"user_id": "00000000-0000-0000-0000-000000000301", "share_minor": 334}, {"user_id": "00000000-0000-0000-0000-000000000302", "share_minor": 333}, {"user_id": "00000000-0000-0000-0000-000000000303", "share_minor": 333}]',
          '1000 between 3: the one leftover unit goes to the first in join order');
select is(api.split(1001, 'equal', array['00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000302',
            '00000000-0000-0000-0000-000000000303']::uuid[], null)#>>'{shares,1,share_minor}', '334', '1001 between 3: 334, 334, 333');
select is(api.split(1000, 'shares', array['00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000302']::uuid[], array[2, 1]::bigint[])->'shares',
          '[{"user_id": "00000000-0000-0000-0000-000000000301", "share_minor": 667}, {"user_id": "00000000-0000-0000-0000-000000000302", "share_minor": 333}]',
          'shares 2:1 of 1000: 667 and 333');
select is(api.split(1000, 'exact', array['00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000302']::uuid[], array[600, 300]::bigint[])->>'error',
          'sum_differs', 'exact amounts that do not sum to the amount are refused');
select is(api.split(1000, 'shares', array['00000000-0000-0000-0000-000000000301']::uuid[], array[0]::bigint[])->>'error', 'invalid_shares', 'all weights zero');

-- 2. Settlement plan: written by hand. A paid 900 for three (300 each), B paid 300 for three (100 each):
--    A +900-400 = +500, B +300-400 = -100, C -400. C pays A 400, B pays A 100.
select is(api.settle_plan('{"a": 500, "b": -100, "c": -400}'),
          '[{"to_user": "a", "from_user": "c", "amount_minor": 400}, {"to_user": "a", "from_user": "b", "amount_minor": 100}]',
          'suggested settlements of a fixed scenario');
select is(api.settle_plan('{"a": 0, "b": 0}'), '[]', 'nothing to settle');
create temp table rnd as select jsonb_build_object('a', 700, 'b', -250, 'c', -150, 'd', 100, 'e', -400) as b;
select is((select sum((v->>'amount_minor')::bigint) filter (where v->>'to_user' in ('a', 'd'))
             from rnd, jsonb_array_elements(api.settle_plan(b)) v), 800::numeric, 'the transfers reach every creditor''s balance');

-- 3. Households through the functions, as the caller
insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, timezone)
values ('ZH', 'ZH', 'pgTAP household', 'TND', 'fr', 'Africa/Tunis');
insert into app.users (id, email, display_name, role, jurisdiction_code) values
  ('00000000-0000-0000-0000-0000000003a1', 'a-p5@example.test', 'Amel', 'user', 'ZH'),
  ('00000000-0000-0000-0000-0000000003a2', 'b-p5@example.test', 'Bilel', 'user', 'ZH'),
  ('00000000-0000-0000-0000-0000000003a3', 'c-p5@example.test', 'Chiraz', 'user', 'ZH'),
  ('00000000-0000-0000-0000-0000000003a4', 'o-p5@example.test', 'Omar', 'user', 'ZH'),
  ('00000000-0000-0000-0000-0000000003a9', 'x-p5@example.test', 'Xavier', 'user', 'ZH');
create or replace function pg_temp.call(p_fn text, p_user text, p jsonb) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  execute 'set local role n8n_worker';
  execute format('select api.%I(%L::uuid, %L::jsonb)', p_fn, p_user, p) into r;
  reset role;
  return r;
end $$;
create temp table k (name text primary key, v text);
\set A '''00000000-0000-0000-0000-0000000003a1'''
\set B '''00000000-0000-0000-0000-0000000003a2'''
\set C '''00000000-0000-0000-0000-0000000003a3'''
\set O '''00000000-0000-0000-0000-0000000003a4'''
\set X '''00000000-0000-0000-0000-0000000003a9'''

select is(pg_temp.as_user('n8n_worker', '', 'select count(*) from home.expenses'), 'ERROR 42501', 'n8n_worker: no privilege on home tables');
insert into k select 'h', pg_temp.call('household_create', :A, '{"body": {"name": "Rue de Marseille", "jurisdiction_code": "ZH"}}')#>>'{data,household_id}';
select isnt((select v from k where name = 'h'), null, 'Amel creates the household');
create or replace function pg_temp.hp(extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('params', jsonb_build_object('id', (select v from k where name = 'h'))) || extra $$;
-- invites: Bilel and Chiraz by code, Omar as the owner member
insert into k select 'code_b', pg_temp.call('household_invite', :A, pg_temp.hp())#>>'{data,code}';
insert into k select 'code_c', pg_temp.call('household_invite', :A, pg_temp.hp())#>>'{data,code}';
insert into k select 'code_o', pg_temp.call('household_invite', :A, pg_temp.hp('{"body": {"role": "owner"}}'))#>>'{data,code}';
select ok((select v from k where name = 'code_b') ~ '^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$', 'a code of 12 characters');
select is((select count(*)::int from home.household_invites where code_hash = convert_to((select v from k where name = 'code_b'), 'UTF8')), 0,
          'the code itself is not stored');
select is(pg_temp.call('household_invite_accept', :B, jsonb_build_object('body', jsonb_build_object('code', lower((select v from k where name = 'code_b')))))#>>'{data,my_role}',
          'flatmate', 'Bilel joins with the code (any case)');
select is(pg_temp.call('household_invite_accept', :X, jsonb_build_object('body', jsonb_build_object('code', (select v from k where name = 'code_b'))))#>>'{error,details,0,issue}',
          'used', 'a code works once');
select is(pg_temp.call('household_invite_accept', :X, '{"body": {"code": "AAAA-BBBB-CCCC"}}')->>'status', '404', 'a wrong code: 404');
select pg_temp.call('household_invite_accept', :C, jsonb_build_object('body', jsonb_build_object('code', (select v from k where name = 'code_c'))));
select is(pg_temp.call('household_invite_accept', :O, jsonb_build_object('body', jsonb_build_object('code', (select v from k where name = 'code_o'))))#>>'{data,my_role}',
          'owner', 'Omar joins as the owner member');
select is(pg_temp.call('household_get', :X, pg_temp.hp())->>'status', '404', 'an outsider: 404');
select is(jsonb_array_length(pg_temp.call('household_get', :A, pg_temp.hp())#>'{data,members}'), 4, 'four members');

-- 4. Expenses and balances on a fixed scenario (amounts in millimes, TND):
--    Amel pays 90.000 for the three flatmates (equal: 30.000 each); Bilel pays 30.000 for the three (10.000 each);
--    Chiraz pays 10.001 for Amel and herself (equal: 5.001 to Amel, the first in join order, 5.000 to Chiraz).
--    Amel: +90000 - 30000 - 10000 - 5001 = 44999; Bilel: +30000 - 30000 - 10000 = -10000; Chiraz: +10001 - 30000 - 10000 - 5000 = -34999.
select is(pg_temp.call('expense_create', :A, pg_temp.hp('{"body": {"amount_minor": 90000, "label": "Courses", "category": "groceries", "preview": true}}'))#>'{data,shares}'
            @> '[{"share_minor": 30000}]', true, 'a preview shows the split');
select is((select count(*)::int from home.expenses), 0, 'and saves nothing');
select pg_temp.call('expense_create', :A, pg_temp.hp('{"body": {"amount_minor": 90000, "label": "Courses", "category": "groceries"}}'));
select pg_temp.call('expense_create', :B, pg_temp.hp('{"body": {"amount_minor": 30000, "label": "Internet", "category": "internet"}}'));
select pg_temp.call('expense_create', :C, pg_temp.hp('{"body": {"amount_minor": 10001, "label": "Savon", "category": "household", "participants": ["00000000-0000-0000-0000-0000000003a3", "00000000-0000-0000-0000-0000000003a1"]}}'));
select is(pg_temp.call('balances_get', :A, pg_temp.hp())#>'{data,balances}',
          '[{"me": true, "user_id": "00000000-0000-0000-0000-0000000003a1", "display_name": "Amel", "balance_minor": 44999}, {"me": false, "user_id": "00000000-0000-0000-0000-0000000003a2", "display_name": "Bilel", "balance_minor": -10000}, {"me": false, "user_id": "00000000-0000-0000-0000-0000000003a3", "display_name": "Chiraz", "balance_minor": -34999}]',
          'balances of the fixed scenario, written by hand');
select is(pg_temp.call('balances_get', :A, pg_temp.hp())#>'{data,suggested}',
          '[{"to": {"user_id": "00000000-0000-0000-0000-0000000003a1", "display_name": "Amel"}, "from": {"user_id": "00000000-0000-0000-0000-0000000003a3", "display_name": "Chiraz"}, "amount_minor": 34999}, {"to": {"user_id": "00000000-0000-0000-0000-0000000003a1", "display_name": "Amel"}, "from": {"user_id": "00000000-0000-0000-0000-0000000003a2", "display_name": "Bilel"}, "amount_minor": 10000}]',
          'suggested: Chiraz pays Amel 34.999, Bilel pays Amel 10.000');
select pg_temp.call('settlement_create', :C, pg_temp.hp('{"body": {"to_user": "00000000-0000-0000-0000-0000000003a1", "amount_minor": 34999}}'));
select pg_temp.call('settlement_create', :B, pg_temp.hp('{"body": {"to_user": "00000000-0000-0000-0000-0000000003a1", "amount_minor": 10000}}'));
select is((select count(*)::int from jsonb_array_elements(pg_temp.call('balances_get', :B, pg_temp.hp())#>'{data,balances}') x where (x->>'balance_minor')::bigint <> 0), 0,
          'after the suggested settlements every balance is zero');
select is(pg_temp.call('balances_get', :O, pg_temp.hp())->>'status', '403', 'the owner member does not see the money (7.3)');
select is(pg_temp.call('expenses_list', :O, pg_temp.hp())->>'status', '403', 'nor the expenses');
select is(pg_temp.call('expense_create', :A, pg_temp.hp('{"body": {"amount_minor": 1000, "label": "x", "participants": ["00000000-0000-0000-0000-0000000003a4"]}}'))#>>'{error,details,0,issue}',
          'not_a_flatmate', 'the owner member is never in a split');

-- 5. Rent and bills: a reminder on the right day, once
select pg_temp.call('recurring_put', :A, pg_temp.hp('{"body": {"items": [{"kind": "rent", "label": "Loyer", "amount_minor": 1200000, "due_day": 5, "remind_days_before": 3}]}}'));
select is(home.daily_reminders('2026-11-01')->>'reminders', '0', 'four days before: no reminder');
select is(home.daily_reminders('2026-11-02')->>'reminders', '1', 'three days before the 5th: one reminder');
select is(home.daily_reminders('2026-11-02')->>'reminders', '0', 'not twice');
select is((select count(*)::int from notify.notifications where type = 'rent_due' and params->>'due_on' = '2026-11-05'), 3,
          'each flatmate is reminded, not the owner member');
select is(home.daily_reminders('2026-11-30')->>'reminders', '0', 'the next one is for December');
-- rent payment confirmed by the owner member only
insert into k select 'rp', pg_temp.call('rent_payment_create', :B, pg_temp.hp('{"body": {"period": "2026-11", "amount_minor": 400000}}'))#>>'{data,payment_id}';
select is(pg_temp.call('rent_payment_confirm', :A, jsonb_build_object('params', jsonb_build_object('id', (select v from k where name = 'rp'))))->>'status', '403',
          'a flatmate cannot confirm a rent payment');
select is(pg_temp.call('rent_payment_confirm', :O, jsonb_build_object('params', jsonb_build_object('id', (select v from k where name = 'rp'))))#>>'{data,confirmed}', 'true',
          'the owner member confirms it');

-- 6. A member who left keeps access to nothing; the balances stay right
select pg_temp.call('household_leave', :C, pg_temp.hp());
select is(pg_temp.call('household_get', :C, pg_temp.hp())->>'status', '404', 'Chiraz left: 404 on the household');
select is(pg_temp.call('expenses_list', :C, pg_temp.hp())->>'status', '404', 'and on its expenses');

select * from finish();
rollback;
