-- Migration 0035: contact reused by another owner, the trust.model setting, the note on a moderation item (D-114).
\ir helpers.psql
begin;
select plan(8);

insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, timezone)
values ('ZK', 'ZK', 'pgTAP scam check', 'TND', 'fr', 'UTC');
insert into app.users (id, email, display_name, role, jurisdiction_code) values
  ('00000000-0000-0000-0000-000000000ca1', 'a-p12s@example.test', 'Amine', 'user', 'ZK'),
  ('00000000-0000-0000-0000-000000000ca2', 'b-p12s@example.test', 'Badr', 'user', 'ZK');
\set A '''00000000-0000-0000-0000-000000000ca1'''
\set B '''00000000-0000-0000-0000-000000000ca2'''
insert into app.listings (id, owner_id, jurisdiction_code, status, kind, title, description, rent_minor, currency, rent_period, city, published_at) values
  ('00000000-0000-0000-0000-000000000cb1', :A, 'ZK', 'published', 'room', 'Chambre A', 'Appelez le +216 22 333 444 ou ecrivez a loc.zk@example.test', 400000, 'TND', 'month', 'Ville ZK', now()),
  ('00000000-0000-0000-0000-000000000cb2', :B, 'ZK', 'draft', 'room', 'Chambre B', 'Contact : 22.333.444, visite le soir.', 400000, 'TND', 'month', 'Ville ZK', null),
  ('00000000-0000-0000-0000-000000000cb3', :B, 'ZK', 'draft', 'room', 'Chambre C', 'Ecrivez a LOC.ZK@example.test.', 400000, 'TND', 'month', 'Ville ZK', null),
  ('00000000-0000-0000-0000-000000000cb4', :B, 'ZK', 'draft', 'room', 'Chambre D', 'Visite le samedi, sans numero.', 400000, 'TND', 'month', 'Ville ZK', null),
  ('00000000-0000-0000-0000-000000000cb5', :A, 'ZK', 'draft', 'room', 'Chambre E', 'Meme numero 22 333 444.', 400000, 'TND', 'month', 'Ville ZK', null);

select is(app.trust_contact_reuse('00000000-0000-0000-0000-000000000cb2')->>'other_owners', '1', 'a phone written differently, same last 8 digits');
select is(app.trust_contact_reuse('00000000-0000-0000-0000-000000000cb3')->>'other_owners', '1', 'an e-mail, case does not matter');
select is(app.trust_contact_reuse('00000000-0000-0000-0000-000000000cb4')->>'other_owners', '0', 'no contact, no signal');
select is(app.trust_contact_reuse('00000000-0000-0000-0000-000000000cb5')->>'other_owners', '0', 'the same owner reusing a number is not a signal');
select is((select x->>'points' from jsonb_array_elements(app.trust_facts('00000000-0000-0000-0000-000000000cb2')->'signals') x
            where x->>'signal' = 'contact_reused'), '-20', 'trust_facts carries contact_reused with its points');
select ok(not (app.trust_facts('00000000-0000-0000-0000-000000000cb2')#>'{signals}')::text like '%22333444%',
          'the evidence holds counts, never the contact');
select is((select value #>> '{}' from app.settings where key = 'trust.model'), 'detector', 'the detector is the default since D-117');

-- the note of the check on the moderation item
insert into app.trust_reports (id, listing_id, score, verdict, signals, explanation)
values ('00000000-0000-0000-0000-000000000cc1', '00000000-0000-0000-0000-000000000cb2', 60, 'review', '[]', 'Same phone as another owner.');
insert into app.moderation_queue (entity_type, entity_id, reason, priority, evidence)
values ('listing', '00000000-0000-0000-0000-000000000cb2', 'trust_review', 3, '{"trust_report_id": "00000000-0000-0000-0000-000000000cc1"}');
select is((select app._moderation_item(m)->>'note' from app.moderation_queue m where entity_id = '00000000-0000-0000-0000-000000000cb2'),
          'Same phone as another owner.', 'the moderator sees the note of the check');

select * from finish();
rollback;
