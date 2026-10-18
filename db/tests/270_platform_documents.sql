-- Migration 0030: household documents and the Document agent's drafts (D-108).
\ir helpers.psql
begin;
select plan(14);

insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, timezone)
values ('ZD', 'ZD', 'pgTAP documents', 'TND', 'fr', 'UTC');
insert into app.users (id, email, display_name, role, jurisdiction_code) values
  ('00000000-0000-0000-0000-0000000007a1', 'a-p9@example.test', 'Amel', 'user', 'ZD'),
  ('00000000-0000-0000-0000-0000000007a2', 'b-p9@example.test', 'Bilel', 'user', 'ZD'),
  ('00000000-0000-0000-0000-0000000007a4', 'o-p9@example.test', 'Omar', 'user', 'ZD'),
  ('00000000-0000-0000-0000-0000000007a9', 'x-p9@example.test', 'Xavier', 'user', 'ZD');
insert into home.households (id, name, jurisdiction_code, currency, timezone, created_by, address_text)
values ('00000000-0000-0000-0000-0000000007b1', 'Maison ZD', 'ZD', 'TND', 'UTC', '00000000-0000-0000-0000-0000000007a1', '12 rue des Oliviers');
insert into home.household_members (household_id, user_id, role, joined_at) values
  ('00000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-0000000007a1', 'flatmate', now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-0000000007a2', 'flatmate', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-0000000007a4', 'owner', now());
insert into home.rent_payments (id, household_id, user_id, period, amount_minor, paid_on, confirmed_by, confirmed_at) values
  ('00000000-0000-0000-0000-0000000007c1', '00000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-0000000007a1', '2026-11', 450000, '2026-11-02',
   '00000000-0000-0000-0000-0000000007a4', '2026-11-03 10:00+00'),
  ('00000000-0000-0000-0000-0000000007c2', '00000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-0000000007a2', '2026-11', 450000, '2026-11-02', null, null);
create or replace function pg_temp.call(p_fn text, p_user text, p jsonb) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  execute 'set local role n8n_worker';
  execute format('select api.%I(%L::uuid, %L::jsonb)', p_fn, p_user, p) into r;
  reset role;
  return r;
end $$;
\set A '''00000000-0000-0000-0000-0000000007a1'''
\set O '''00000000-0000-0000-0000-0000000007a4'''
\set X '''00000000-0000-0000-0000-0000000007a9'''

-- 1. Who may make what, and the facts given
select is(pg_temp.call('document_facts', :A, '{"params": {"id": "00000000-0000-0000-0000-0000000007b1"}, "body": {"kind": "rent_receipt", "payment_id": "00000000-0000-0000-0000-0000000007c1"}}')->>'status',
          '403', 'a flatmate does not make rent receipts');
select is(pg_temp.call('document_facts', :O, '{"params": {"id": "00000000-0000-0000-0000-0000000007b1"}, "body": {"kind": "rent_receipt", "payment_id": "00000000-0000-0000-0000-0000000007c2"}}')#>>'{error,details,0,issue}',
          'payment_not_confirmed', 'a receipt only for a confirmed payment');
create temp table fx as select pg_temp.call('document_facts', :O, '{"params": {"id": "00000000-0000-0000-0000-0000000007b1"}, "body": {"kind": "rent_receipt", "payment_id": "00000000-0000-0000-0000-0000000007c1"}}') as r;
select is((select r#>>'{data,facts,tenant}' from fx), 'Amel', 'the payer is the tenant on the receipt');
select is((select r#>>'{data,facts,confirmed_on}' from fx), '2026-11-03', 'with the day the owner confirmed it');
select is((select r#>>'{data,facts,occupants}' from fx), 'Amel, Bilel', 'flatmates in join order');
select is(pg_temp.call('document_facts', :O, '{"params": {"id": "00000000-0000-0000-0000-0000000007b1"}, "body": {"kind": "flatmate_agreement"}}')->>'status',
          '403', 'the agreement is the flatmates''');
select is(pg_temp.call('document_facts', :X, '{"params": {"id": "00000000-0000-0000-0000-0000000007b1"}, "body": {"kind": "house_rules"}}')->>'status',
          '404', 'an outsider: 404');

-- 2. Stored documents: every member sees them, an outsider does not
create temp table d as select pg_temp.call('document_store', :A, '{"store": {"household_id": "00000000-0000-0000-0000-0000000007b1", "kind": "inventory_entry",
  "jurisdiction_code": "ZD", "language": "fr", "template_key": "tn.inventory_entry", "template_version": 1, "inputs": {"date": "2026-11-01"},
  "sources": [{"cite_as": "COC art. 780-783"}], "notice_version": "documents-notice-v1", "status": "ready", "storage_key": "documents/x/y.pdf",
  "bytes": 1200, "sha256": "ab"}}') as r;
select is((select r->>'status' from d), '201', 'stored');
select is(jsonb_array_length(pg_temp.call('documents_list', :O, '{"params": {"id": "00000000-0000-0000-0000-0000000007b1"}}')#>'{data,items}'), 1,
          'the owner member sees the inventory');
select is(pg_temp.call('document_get', :X, jsonb_build_object('params', jsonb_build_object('id', (select r#>>'{data,document_id}' from d))))->>'status',
          '404', 'an outsider cannot read it');
select is(pg_temp.call('document_store', :A, '{"store": {"household_id": "00000000-0000-0000-0000-0000000007b1", "kind": "house_rules",
  "jurisdiction_code": "ZD", "language": "fr", "template_key": "global.house_rules", "template_version": 1, "inputs": {}, "sources": [],
  "notice_version": "documents-notice-v1", "status": "failed", "error_code": "media_unavailable"}}')#>>'{error,code}',
          'UPSTREAM_UNAVAILABLE', 'a failed rendering is kept and answered 503');

-- 3. Drafts belong to the person who asked
create temp table dr as select pg_temp.call('document_draft_put', :A, '{"household_id": "00000000-0000-0000-0000-0000000007b1", "kind": "flatmate_agreement",
  "language": "fr", "values": {"notice_days": 30}, "missing": ["start_date", "shares"]}') as r;
select is(pg_temp.call('document_draft_get', :A, jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000007b1', 'draft_id', (select r#>>'{data,draft_id}' from dr)))#>>'{data,values,notice_days}',
          '30', 'Amel reads her draft');
select is(pg_temp.call('document_draft_get', :O, jsonb_build_object('household_id', '00000000-0000-0000-0000-0000000007b1', 'draft_id', (select r#>>'{data,draft_id}' from dr)))->>'status',
          '404', 'another member cannot');
select is(pg_temp.call('document_draft_put', :X, '{"household_id": "00000000-0000-0000-0000-0000000007b1", "kind": "house_rules", "values": {}}')->>'status',
          '404', 'an outsider cannot store one');

select * from finish();
rollback;
