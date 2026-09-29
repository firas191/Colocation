-- The 24 behavioural tests of the baseline (db/baseline/schema_tests.sql),
-- rewritten as pgTAP assertions so that a wrong result fails the run instead
-- of relying on someone reading the output. Same fixtures, same order.
\ir helpers.psql
begin;
select plan(51);

insert into app.jurisdictions(code,country_code,name,default_currency,default_locale,languages,timezone,active,rules) values
 ('TN','TN','Tunisia','TND','fr-TN','{fr,ar,en}','Africa/Tunis',true,
   '{"lease_registration_required":{"value":null,"note":"sources disagree"}}'),
 ('FR','FR','France','EUR','fr-FR','{fr,en}','Europe/Paris',true,'{}'),
 ('GB','GB','United Kingdom','GBP','en-GB','{en}','Europe/London',true,'{}');
insert into app.users(id,email,display_name,role,jurisdiction_code) values
 ('00000000-0000-0000-0000-00000000000a','a@example.com','Alice','owner','TN'),
 ('00000000-0000-0000-0000-00000000000b','b@example.com','Bob','user','TN');
insert into app.listings(id,owner_id,jurisdiction_code,status,title,description,rent_minor,currency,location,public_location,city,embedding,embedding_model) values
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000a','TN','published','Chambre Ariana','chambre meublée étudiante non fumeuse Ariana wifi',250000,'TND', st_point(10.1647,36.8665)::geography, st_point(10.1650,36.8668)::geography,'Ariana', pg_temp.vec(1,1),'bge-m3'),
 ('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-00000000000a','TN','published','غرفة في المنزه','غرفة للكراء في المنزه قريبة من المترو',300000,'TND', st_point(10.1800,36.8400)::geography, st_point(10.1802,36.8402)::geography,'Tunis', pg_temp.vec(2,2),'bge-m3'),
 ('10000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-00000000000a','TN','published','Colocation Bardo','coloc etudiants Bardo proche facultés',180000,'TND', st_point(10.1400,36.8090)::geography, st_point(10.1402,36.8092)::geography,'Tunis', pg_temp.vec(3,1),'bge-m3'),
 ('10000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-00000000000a','TN','published','Luxury S+2 Lac','appartement haut standing Lac 2',1200000,'TND', st_point(10.2700,36.8350)::geography, st_point(10.2702,36.8352)::geography,'Tunis', pg_temp.vec(4,3),'bge-m3'),
 ('10000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-00000000000a','TN','draft','Draft room','not visible yet',200000,'TND', st_point(10.16,36.86)::geography, st_point(10.16,36.86)::geography,'Ariana', pg_temp.vec(5,1),'bge-m3'),
 ('10000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-00000000000a','FR','published','Chambre Lyon','chambre étudiante Lyon Part-Dieu',45000,'EUR', st_point(4.8590,45.7600)::geography, st_point(4.8592,45.7602)::geography,'Lyon', pg_temp.vec(6,1),'bge-m3');

-- T1
select is((select listing_id::text from app.search_listings(pg_temp.vec(1,1), 'chambre étudiante Ariana', 'TN', 260000, 'TND',
            st_point(10.1647,36.8665)::geography, 5000, 10) limit 1),
          '10000000-0000-0000-0000-000000000001', 'T1 hybrid search: 001 ranks first');
select is((select count(*)::int from app.search_listings(pg_temp.vec(1,1), 'chambre étudiante Ariana', 'TN', 260000, 'TND',
            st_point(10.1647,36.8665)::geography, 5000, 10)
           where listing_id in ('10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000004',
                                '10000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000006')),
          0, 'T1 excludes over-budget, out-of-radius, draft and other-jurisdiction listings');
-- T2
select is((select lexical_rank from app.search_listings(pg_temp.vec(2,2), 'غرفة المنزه', 'TN', null, null, null, null, 10)
           where listing_id = '10000000-0000-0000-0000-000000000002'), 1, 'T2 Arabic query finds 002 through the lexical leg');
-- T3
select results_eq($$ select listing_id::text from app.search_listings(pg_temp.vec(6,1), 'chambre', 'FR', null, null, null, null, 10) $$,
                  $$ values ('10000000-0000-0000-0000-000000000006') $$, 'T3 jurisdiction isolation: FR returns only 006');
-- T4
select is((select count(*)::int from app.search_listings(pg_temp.vec(1,1), 'chambre', 'TN', 999999999, 'EUR', null, null, 10)),
          0, 'T4 EUR budget never matches TND listings');
-- T5
select is((select count(*)::int from app.search_listings(pg_temp.vec(1,1), '', 'TN', null, null, null, null, 10)),
          4, 'T5 empty text runs dense-only and returns the 4 published TN listings');
-- T6
select is(app.or_tsquery('a & b | (c) :* ''quote'' ! \ ok')::text, '''a'' | ''b'' | ''c'' | ''quote'' | ''ok''',
          'T6 hostile tsquery characters are neutralised');

insert into kb.sources(id,jurisdiction_code,title,source_type,reliability,language) values
 ('20000000-0000-0000-0000-000000000001','TN','Code des obligations et des contrats','primary_law',5,'fr'),
 ('20000000-0000-0000-0000-000000000002','TN','Blog guide location','blog',2,'fr'),
 ('20000000-0000-0000-0000-000000000003',null,'Global scam checklist','ngo',4,'en'),
 ('20000000-0000-0000-0000-000000000004','FR','Loi 1989 rapports locatifs','primary_law',5,'fr');
insert into kb.documents(id,source_id,content,content_hash) select ('30000000-0000-0000-0000-00000000000'||n)::uuid, ('20000000-0000-0000-0000-00000000000'||n)::uuid, 'doc '||n, md5('doc '||n) from generate_series(1,4) n;
insert into kb.chunks(id,document_id,strategy,chunk_index,content,article_ref)
select ('40000000-0000-0000-0000-0000000000'||lpad((n*10+s)::text,2,'0'))::uuid, ('30000000-0000-0000-0000-00000000000'||n)::uuid,
       case s when 1 then 'fixed_500_50' else 'structure_aware_v1' end, 0,
       case n when 1 then 'article 727 bail location durée préavis trois mois huissier'
              when 2 then 'enregistrement du bail recette des finances cinq dinars par page'
              when 3 then 'never send a deposit before visiting the property'
              else 'loi 1989 bail meublé préavis' end,
       case n when 1 then 'COC art. 727' else null end
from generate_series(1,4) n, generate_series(1,2) s;
insert into kb.chunk_embeddings(chunk_id,model,embedding)
select c.id,'bge-m3', pg_temp.vec(right(c.id::text,2)::int, 1 + (right(c.id::text,2)::int % 4)) from kb.chunks c;
insert into kb.chunk_embeddings(chunk_id,model,embedding)
select c.id,'multilingual-e5-large', pg_temp.vec(right(c.id::text,2)::int + 500, 1 + (right(c.id::text,2)::int % 4)) from kb.chunks c;

-- T7
select set_eq($$ select source_type from kb.search_chunks('bge-m3','fixed_500_50', pg_temp.vec(11,2), 'préavis bail huissier', 'TN', 1::smallint, 10) $$,
              array['primary_law','blog','ngo'], 'T7 TN search returns TN and global sources only');
select is((select count(*)::int from kb.search_chunks('bge-m3','fixed_500_50', pg_temp.vec(11,2), 'préavis bail huissier', 'TN', 1::smallint, 10) k
           join kb.sources s on s.id = k.source_id where s.jurisdiction_code = 'FR'), 0, 'T7 FR source never appears in a TN search');
-- T8
select is((select count(*)::int from kb.search_chunks('bge-m3','structure_aware_v1', pg_temp.vec(11,2), 'bail', 'TN', 4::smallint, 10) where source_type = 'blog'),
          0, 'T8 reliability floor 4 excludes the blog');
-- T9
select is((select count(*)::int from kb.search_chunks('bge-m3','fixed_500_50', pg_temp.vec(11,2), 'bail','TN',1::smallint,10)), 3, 'T9 bge-m3 vectors queryable');
select is((select count(*)::int from kb.search_chunks('multilingual-e5-large','fixed_500_50', pg_temp.vec(11,2), 'bail','TN',1::smallint,10)), 3, 'T9 e5 vectors queryable on the same chunks');

insert into app.listing_media(listing_id,kind,storage_key,mime,bytes,sha256,phash) values
 ('10000000-0000-0000-0000-000000000001','photo','k1','image/jpeg',100,'h1', B'1010101010101010101010101010101010101010101010101010101010101010'),
 ('10000000-0000-0000-0000-000000000006','photo','k2','image/jpeg',100,'h2', B'1010101010101010101010101010101010101010101010101010101010101011');
-- T10
select results_eq($$ select listing_id::text, distance from app.find_similar_media(B'1010101010101010101010101010101010101010101010101010101010101010', 6, '10000000-0000-0000-0000-000000000001') $$,
                  $$ values ('10000000-0000-0000-0000-000000000006', 1) $$, 'T10 near-duplicate photo found at Hamming distance 1');
-- T11
select throws_ok($$ insert into app.listings(jurisdiction_code,rent_minor) values ('TN', 1000) $$, '23514', null, 'T11 rent without currency rejected');
select throws_ok($$ insert into app.listings(jurisdiction_code,rent_minor,currency,status) values ('TN', -5,'TND','draft') $$, '23514', null, 'T11 negative rent rejected');
select throws_ok($$ insert into app.listings(jurisdiction_code,status) values ('XX','draft') $$, '23503', null, 'T11 unknown jurisdiction rejected');
select throws_ok($$ insert into app.profiles(user_id,budget_min_minor,budget_max_minor,currency) values ('00000000-0000-0000-0000-00000000000b',500,100,'TND') $$, '23514', null, 'T11 budget max < min rejected');
select throws_ok($$ insert into app.listings(jurisdiction_code,rent_minor,currency,status) values ('TN', 100,'XXX','draft') $$, '23503', null, 'T11 unknown currency rejected');

insert into ai.prompts(id,name,agent,role) values ('50000000-0000-0000-0000-000000000001','P1_router','orchestrator','routes request');
insert into ai.prompt_versions(prompt_id,version,template,status) values ('50000000-0000-0000-0000-000000000001',1,'v1','active');
-- T12
select throws_ok($$ insert into ai.prompt_versions(prompt_id,version,template,status) values ('50000000-0000-0000-0000-000000000001',2,'v2','active') $$,
                 '23505', null, 'T12 second active version rejected');
select lives_ok($$ insert into ai.prompt_versions(prompt_id,version,template,status) values ('50000000-0000-0000-0000-000000000001',3,'v3','retired') $$,
                'T12 retired version accepted');

insert into app.profiles(user_id,jurisdiction_code) values ('00000000-0000-0000-0000-00000000000a','TN'),('00000000-0000-0000-0000-00000000000b','TN');
insert into app.threads(id,kind,owner_id) values ('60000000-0000-0000-0000-00000000000a','assistant','00000000-0000-0000-0000-00000000000a'),
                                                  ('60000000-0000-0000-0000-00000000000b','assistant','00000000-0000-0000-0000-00000000000b');
insert into app.messages(thread_id,sender,content) values ('60000000-0000-0000-0000-00000000000a','user','alice secret'),('60000000-0000-0000-0000-00000000000b','user','bob secret');

\set alice '00000000-0000-0000-0000-00000000000a'
\set bob '00000000-0000-0000-0000-00000000000b'
-- T13
select is(pg_temp.as_user('api_user', :'alice', 'select count(*)::text from app.profiles'), '1', 'T13 Alice sees 1 profile');
select is(pg_temp.as_user('api_user', :'alice', 'select string_agg(content, '','') from app.messages'), 'alice secret', 'T13 Alice sees only her message');
select is(pg_temp.as_user('api_user', :'alice', 'select count(*)::text from app.listings'), '6', 'T13 Alice sees 5 published + her draft');
-- T14
select is(pg_temp.as_user('api_user', :'alice', $$insert into app.profiles(user_id) values ('00000000-0000-0000-0000-00000000000b')$$), 'ERROR 42501', 'T14 Alice cannot create a profile for Bob');
-- T15
select is(pg_temp.as_user('api_user', :'bob', 'select count(*)::text from app.profiles'), '1', 'T15 Bob sees his profile only');
select is(pg_temp.as_user('api_user', :'bob', 'select count(*)::text from app.listings'), '5', 'T15 Bob sees published listings only');
-- T16
select is(pg_temp.as_user('api_user', '', 'select count(*)::text from app.profiles'), '0', 'T16 no user: no profiles');
select is(pg_temp.as_user('api_user', '', 'select count(*)::text from app.messages'), '0', 'T16 no user: no messages');
-- T17
select is(pg_temp.as_user('n8n_worker', '', 'select count(*)::text from app.profiles'), '2', 'T17 n8n_worker bypasses RLS');

-- T18
select lives_ok($$ select app.erase_user('00000000-0000-0000-0000-00000000000a') $$, 'T18 erase_user(Alice) runs');
select is((select count(*)::int from app.profiles where user_id = :'alice'), 0, 'T18 profile deleted');
select is((select count(*)::int from app.messages where thread_id = '60000000-0000-0000-0000-00000000000a' and content is not null), 0, 'T18 messages blanked');
select is((select count(*)::int from app.listings where jurisdiction_code = 'TN' and status = 'archived'), 5, 'T18 TN listings archived');
select is((select count(*)::int from app.listings where jurisdiction_code = 'TN' and title is not null), 0, 'T18 titles removed');
select is((select count(*)::int from app.listing_media where listing_id = '10000000-0000-0000-0000-000000000001'), 0, 'T18 media rows deleted');
select is((select count(*)::int from app.jobs where type = 'delete_media'), 6, 'T18 one delete_media job per listing');
select ok((select email is null and deleted_at is not null from app.users where id = :'alice'), 'T18 user row anonymised');
select is((select count(*)::int from app.listings where status = 'archived' and (location is not null or public_location is not null)), 0, 'T18 no location left on erased listings');
select is((select count(*)::int from app.messages where content = 'bob secret'), 1, 'T18 Bob untouched');

insert into app.listings(id,jurisdiction_code,status,title,rent_minor,currency) values ('10000000-0000-0000-0000-0000000000ff','TN','draft','hidden draft',1,'TND');
insert into app.listings(id,jurisdiction_code,status,title,rent_minor,currency,public_location) values ('10000000-0000-0000-0000-0000000000fe','TN','published','visible',1,'TND', st_point(10,36)::geography);
insert into app.listing_media(listing_id,kind,storage_key,mime,bytes,sha256) values
 ('10000000-0000-0000-0000-0000000000ff','photo','kd','image/jpeg',1,'hd'),
 ('10000000-0000-0000-0000-0000000000fe','photo','kp','image/jpeg',1,'hp');
-- T19-T22
select is(pg_temp.as_user('api_user', '', 'select location::text from app.listings limit 1'), 'ERROR 42501', 'T19 api_user cannot read exact location');
select is(pg_temp.as_user('api_user', '', 'select (count(public_location) > 0)::text from app.listings'), 'true', 'T20 api_user reads public_location');
select is(pg_temp.as_user('api_user', '', 'select count(*)::text from app.trust_reports'), 'ERROR 42501', 'T21 api_user cannot read trust_reports');
select is(pg_temp.as_user('api_user', '', $$select app.erase_user('00000000-0000-0000-0000-00000000000b')::text$$), 'ERROR 42501', 'T22 api_user cannot erase');
-- T23
select is(pg_temp.as_user('api_user', :'bob', 'select string_agg(storage_key, '','' order by storage_key) from app.listing_media'), 'kp', 'T23 media of drafts hidden, media of published visible');
-- T24
select is(pg_temp.as_user('n8n_worker', '', 'select (count(location) >= 0)::text from app.listings'), 'true', 'T24 n8n_worker reads location');
select is(pg_temp.as_user('n8n_worker', '', $$select app.erase_user('00000000-0000-0000-0000-00000000000b')::text$$), '', 'T24 n8n_worker can erase');
select is((select deleted_at is not null from app.users where id = :'bob'), true, 'T24 erase by n8n_worker took effect');

-- Extra: role attributes the security model depends on
select ok((select rolbypassrls from pg_roles where rolname = 'n8n_worker'), 'n8n_worker has BYPASSRLS');
select ok(not (select rolbypassrls from pg_roles where rolname = 'api_user'), 'api_user does not bypass RLS');
select ok(not (select rolsuper from pg_roles where rolname = 'n8n_worker'), 'n8n_worker is not superuser');
select ok(not (select rolsuper from pg_roles where rolname = 'api_user'), 'api_user is not superuser');

select * from finish();
rollback;
