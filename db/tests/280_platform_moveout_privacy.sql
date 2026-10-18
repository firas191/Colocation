-- Migration 0031: moving out, deposits, leaving with a balance, exit inventory comparison, erasure, retention (D-109).
\ir helpers.psql
begin;
select plan(26);

insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, timezone)
values ('ZM', 'ZM', 'pgTAP move-out', 'TND', 'fr', 'UTC');
insert into app.users (id, email, display_name, role, jurisdiction_code, external_auth_id, telegram_chat_id) values
  ('00000000-0000-0000-0000-0000000008a1', 'a-p10@example.test', 'Amel', 'user', 'ZM', 'web:amel', null),
  ('00000000-0000-0000-0000-0000000008a2', 'b-p10@example.test', 'Bilel', 'user', 'ZM', 'web:bilel', 777),
  ('00000000-0000-0000-0000-0000000008a4', 'o-p10@example.test', 'Omar', 'user', 'ZM', 'web:omar', null);
insert into home.households (id, name, jurisdiction_code, currency, timezone, created_by)
values ('00000000-0000-0000-0000-0000000008b1', 'Maison ZM', 'ZM', 'TND', 'UTC', '00000000-0000-0000-0000-0000000008a1');
insert into home.household_members (household_id, user_id, role, joined_at) values
  ('00000000-0000-0000-0000-0000000008b1', '00000000-0000-0000-0000-0000000008a1', 'flatmate', now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000008b1', '00000000-0000-0000-0000-0000000008a2', 'flatmate', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000008b1', '00000000-0000-0000-0000-0000000008a4', 'owner', now());
create or replace function pg_temp.call(p_fn text, p_user text, p jsonb) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  execute 'set local role n8n_worker';
  execute format('select api.%I(%L::uuid, %L::jsonb)', p_fn, p_user, p) into r;
  reset role;
  return r;
end $$;
create or replace function pg_temp.hp(extra jsonb default '{}') returns jsonb language sql as $$
  select '{"params": {"id": "00000000-0000-0000-0000-0000000008b1"}}'::jsonb || extra $$;
\set A '''00000000-0000-0000-0000-0000000008a1'''
\set B '''00000000-0000-0000-0000-0000000008a2'''
\set O '''00000000-0000-0000-0000-0000000008a4'''

-- 1. Leaving with a balance
create temp table ex as select pg_temp.call('expense_create', :A, pg_temp.hp('{"body": {"amount_minor": 300000, "label": "Courses", "category": "groceries"}}'));
select is(pg_temp.call('household_leave', :B, pg_temp.hp())#>>'{error,details,0,issue}', 'balance_not_settled', 'Bilel owes 150: refused');
select is(pg_temp.call('household_leave', :B, pg_temp.hp())#>>'{error,details,0,balance_minor}', '-150000', 'with the amount');

-- 2. Deposits: the owner member records them; the amounts kept must add up
select is(pg_temp.call('deposit_put', :A, pg_temp.hp('{"params": {"id": "00000000-0000-0000-0000-0000000008b1", "user_id": "00000000-0000-0000-0000-0000000008a1"}, "body": {"amount_minor": 500000}}'))->>'status',
          '403', 'a flatmate does not record deposits when there is an owner member');
select is(pg_temp.call('deposit_put', :O, pg_temp.hp('{"params": {"id": "00000000-0000-0000-0000-0000000008b1", "user_id": "00000000-0000-0000-0000-0000000008a1"}, "body": {"amount_minor": 500000, "returned_minor": 400000, "returned_on": "2027-07-01", "deductions": [{"reason": "Vitre cassée", "amount_minor": 50000}]}}'))#>>'{error,details,0,issue}',
          'sum_mismatch', 'returned 400 + deductions 50 is not 500');
select is(pg_temp.call('deposit_put', :O, pg_temp.hp('{"params": {"id": "00000000-0000-0000-0000-0000000008b1", "user_id": "00000000-0000-0000-0000-0000000008a1"}, "body": {"amount_minor": 500000, "paid_on": "2026-09-01", "returned_minor": 400000, "returned_on": "2027-07-01", "deductions": [{"reason": "Vitre cassée", "amount_minor": 100000}]}}'))#>>'{data,kept_minor}',
          '100000', 'recorded: 100 kept');
select is(jsonb_array_length(pg_temp.call('deposits_list', :B, pg_temp.hp())#>'{data,items}'), 0, 'Bilel does not see Amel''s deposit');
select is(jsonb_array_length(pg_temp.call('deposits_list', :A, pg_temp.hp())#>'{data,items}'), 1, 'Amel sees hers');

-- 3. The move-out checklist
select is(pg_temp.call('moveout_start', :A, pg_temp.hp('{"body": {"planned_on": "2027-06-30"}}'))->>'status', '201', 'Amel starts her move-out');
select is((select status from home.household_members where user_id = :A), 'leaving', 'she is leaving');
create temp table mo as select pg_temp.call('moveout_get', :A, pg_temp.hp()) as r;
select is((select x->>'done' from mo, jsonb_array_elements(r#>'{data,move_out,items}') x where x->>'key' = 'balance_settled'), 'false', 'Bilel owes her: not settled');
select is((select x->>'done' from mo, jsonb_array_elements(r#>'{data,move_out,items}') x where x->>'key' = 'deposit_returned'), 'true', 'deposit returned');
select is((select x->>'done' from jsonb_array_elements(pg_temp.call('moveout_item', :A, pg_temp.hp('{"params": {"id": "00000000-0000-0000-0000-0000000008b1", "item": "keys_returned"}, "body": {"done": true}}'))#>'{data,move_out,items}') x
            where x->>'key' = 'keys_returned'), 'true', 'keys returned ticked');
select is(pg_temp.call('moveout_item', :A, pg_temp.hp('{"params": {"id": "00000000-0000-0000-0000-0000000008b1", "item": "balance_settled"}}'))#>>'{error,details,0,issue}',
          'computed_or_unknown', 'a computed item cannot be ticked');
select is(pg_temp.call('moveout_get', :O, pg_temp.hp())->>'status', '403', 'the owner member has no move-out of their own');

-- 4. Exit inventory compared with the entry one
insert into home.documents (id, household_id, kind, jurisdiction_code, language, template_key, template_version, inputs, sources, notice_version, status, created_by, created_at) values
  ('00000000-0000-0000-0000-0000000008d1', '00000000-0000-0000-0000-0000000008b1', 'inventory_entry', 'ZM', 'fr', 'tn.inventory_entry', 1,
   '{"items": {"rows": [{"room": "Chambre", "item": "Lit", "condition": "bon"}, {"room": "Cuisine", "item": "Frigo", "condition": "neuf"}]}}', '[]', 'v1', 'ready', :A, now() - interval '1 year'),
  ('00000000-0000-0000-0000-0000000008d2', '00000000-0000-0000-0000-0000000008b1', 'inventory_exit', 'ZM', 'fr', 'tn.inventory_exit', 1,
   '{"items": {"rows": [{"room": "chambre", "item": "lit", "condition": "Bon"}, {"room": "Cuisine", "item": "Frigo", "condition": "porte cassée"}, {"room": "Salon", "item": "Lampe", "condition": "bon"}]}}',
   '[]', 'v1', 'ready', :A, now());
create temp table cmp as select pg_temp.call('document_comparison', :O, '{"params": {"id": "00000000-0000-0000-0000-0000000008d2"}}') as r;
select is((select string_agg(x->>'state', ',' order by lower(x->>'room')) from cmp, jsonb_array_elements(r#>'{data,rows}') x), 'same,changed,only_at_exit',
          'same bed (case ignored), fridge changed, a lamp only at exit');
select is((select r#>>'{data,changed}' from cmp), '2', 'two differences');
select is(pg_temp.call('document_comparison', :O, '{"params": {"id": "00000000-0000-0000-0000-0000000008d1"}}')#>>'{error,details,0,issue}',
          'not_an_exit_inventory', 'only an exit inventory is compared');

-- 5. Erasure, table by table (backend spec 13.6): Bilel deletes his account
insert into social.flatmate_profiles (user_id, visible, headline) values (:B, true, 'Calme');
insert into social.saved_searches (user_id, name, query, params) values (:B, 'Tunis', '{}', '{}');
insert into home.documents (household_id, kind, jurisdiction_code, language, template_key, template_version, inputs, sources, notice_version, status, storage_key, created_by)
values ('00000000-0000-0000-0000-0000000008b1', 'house_rules', 'ZM', 'fr', 'global.house_rules', 1, '{}', '[]', 'v1', 'ready', 'documents/zm/bilel.pdf', :B);
insert into home.document_drafts (household_id, user_id, kind, language, slot_values) values ('00000000-0000-0000-0000-0000000008b1', :B, 'house_rules', 'fr', '{}');
select is(app.me_erase(:B, '{"body": {"confirm": "yes"}}')#>>'{error,details,0,issue}', 'must_be_DELETE', 'the confirmation is required');
select is(app.me_erase(:B, '{"body": {"confirm": "DELETE"}}')#>>'{data,erased}', 'true', 'erased');
select is((select row(email, display_name, external_auth_id, telegram_chat_id)::text from app.users where id = :B), '(,,,)',
          'app.users: no e-mail, name, sign-in or Telegram id');
select is((select count(*)::int from social.flatmate_profiles where user_id = :B) + (select count(*)::int from social.saved_searches where user_id = :B)
          + (select count(*)::int from home.document_drafts where user_id = :B) + (select count(*)::int from home.documents where created_by = :B), 0,
          'flatmate profile, saved searches, drafts and documents gone');
select ok(exists (select 1 from app.jobs where type = 'delete_media' and input->'storage_keys' ? 'documents/zm/bilel.pdf'), 'the PDF is queued for deletion');
select is((select status from home.household_members where user_id = :B), 'left', 'membership: left');
select is((select sum(v::bigint) from jsonb_each_text(api._balances('00000000-0000-0000-0000-0000000008b1')) b(k, v)), 0::numeric,
          'the balances still sum to zero');

-- 6. Retention with fixed dates
insert into home.document_drafts (household_id, user_id, kind, language, slot_values, created_at)
values ('00000000-0000-0000-0000-0000000008b1', :A, 'house_rules', 'fr', '{}', '2027-01-01');
select is(app.retention_run('2027-01-05')->>'drafts', '0', 'a draft of 4 days is kept');
select is(app.retention_run('2027-01-09')->>'drafts', '1', 'after 7 days it goes');

select * from finish();
rollback;
