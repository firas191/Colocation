\set ON_ERROR_STOP off
\pset pager off
\pset tuples_only on

-- deterministic pseudo-embeddings: a base direction + noise, so nearest neighbours are predictable
create or replace function pg_temp.vec(seed int, base int) returns vector(1024) language plpgsql as $$
declare arr float8[]; i int;
begin
  perform setseed((seed % 1000) / 1000.0);
  arr := array(select case when g % 16 = base then 1.0 else 0.0 end + random()*0.05 from generate_series(1,1024) g);
  return arr::vector;
end $$;

insert into app.jurisdictions(code,country_code,name,default_currency,default_locale,languages,timezone,active,rules) values
 ('TN','TN','Tunisia','TND','fr-TN','{fr,ar,en}','Africa/Tunis',true,
   '{"lease_registration_required":{"value":null,"note":"sources disagree"}}'),
 ('FR','FR','France','EUR','fr-FR','{fr,en}','Europe/Paris',true,'{}'),
 ('GB','GB','United Kingdom','GBP','en-GB','{en}','Europe/London',true,'{}');

insert into app.users(id,email,display_name,role,jurisdiction_code) values
 ('00000000-0000-0000-0000-00000000000a','a@example.com','Alice','owner','TN'),
 ('00000000-0000-0000-0000-00000000000b','b@example.com','Bob','user','TN');

-- 6 listings: 4 TN published, 1 TN draft, 1 FR published
insert into app.listings(id,owner_id,jurisdiction_code,status,title,description,rent_minor,currency,location,public_location,city,embedding,embedding_model) values
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000a','TN','published','Chambre Ariana','chambre meublée étudiante non fumeuse Ariana wifi',250000,'TND', st_point(10.1647,36.8665)::geography, st_point(10.1650,36.8668)::geography,'Ariana', pg_temp.vec(1,1),'bge-m3'),
 ('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-00000000000a','TN','published','غرفة في المنزه','غرفة للكراء في المنزه قريبة من المترو',300000,'TND', st_point(10.1800,36.8400)::geography, st_point(10.1802,36.8402)::geography,'Tunis', pg_temp.vec(2,2),'bge-m3'),
 ('10000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-00000000000a','TN','published','Colocation Bardo','coloc etudiants Bardo proche facultés',180000,'TND', st_point(10.1400,36.8090)::geography, st_point(10.1402,36.8092)::geography,'Tunis', pg_temp.vec(3,1),'bge-m3'),
 ('10000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-00000000000a','TN','published','Luxury S+2 Lac','appartement haut standing Lac 2',1200000,'TND', st_point(10.2700,36.8350)::geography, st_point(10.2702,36.8352)::geography,'Tunis', pg_temp.vec(4,3),'bge-m3'),
 ('10000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-00000000000a','TN','draft','Draft room','not visible yet',200000,'TND', st_point(10.16,36.86)::geography, st_point(10.16,36.86)::geography,'Ariana', pg_temp.vec(5,1),'bge-m3'),
 ('10000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-00000000000a','FR','published','Chambre Lyon','chambre étudiante Lyon Part-Dieu',45000,'EUR', st_point(4.8590,45.7600)::geography, st_point(4.8592,45.7602)::geography,'Lyon', pg_temp.vec(6,1),'bge-m3');

\echo == T1 hybrid search TN, budget 260000 TND, near Ariana center 5km: expect 001 (and maybe 003), not 002/004/005/006
select listing_id::text, round(score::numeric,5), dense_rank, lexical_rank, round(distance_m::numeric)
from app.search_listings(pg_temp.vec(1,1), 'chambre étudiante Ariana', 'TN', 260000, 'TND',
     st_point(10.1647,36.8665)::geography, 5000, 10);

\echo == T2 no geo filter, no budget, arabic query: expect 002 in results via lexical
select listing_id::text, dense_rank, lexical_rank from app.search_listings(pg_temp.vec(2,2), 'غرفة المنزه', 'TN', null, null, null, null, 10);

\echo == T3 jurisdiction isolation: FR search must return only 006
select listing_id::text from app.search_listings(pg_temp.vec(6,1), 'chambre', 'FR', null, null, null, null, 10);

\echo == T4 currency safety: budget in EUR against TND listings must return nothing
select count(*) from app.search_listings(pg_temp.vec(1,1), 'chambre', 'TN', 999999999, 'EUR', null, null, 10);

\echo == T5 empty query text must not error (dense only)
select count(*) from app.search_listings(pg_temp.vec(1,1), '', 'TN', null, null, null, null, 10);

\echo == T6 tsquery sanitisation with hostile characters must not error
select app.or_tsquery('a & b | (c) :* ''quote'' ! \ ok')::text;

-- KB
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

\echo == T7 KB search TN with strategy filter: only TN + global sources, only strategy A; FR source must never appear
select source_type, reliability, article_ref, lexical_rank is not null as lex_hit
from kb.search_chunks('bge-m3','fixed_500_50', pg_temp.vec(11,2), 'préavis bail huissier', 'TN', 1::smallint, 10);

\echo == T8 reliability floor 4: blog (reliability 2) must be excluded
select count(*) filter (where source_type='blog') as blog_rows, count(*) as total
from kb.search_chunks('bge-m3','structure_aware_v1', pg_temp.vec(11,2), 'bail', 'TN', 4::smallint, 10);

\echo == T9 both embedding models queryable on same chunks
select (select count(*) from kb.search_chunks('bge-m3','fixed_500_50', pg_temp.vec(11,2), 'bail','TN',1::smallint,10)) as m1,
       (select count(*) from kb.search_chunks('multilingual-e5-large','fixed_500_50', pg_temp.vec(11,2), 'bail','TN',1::smallint,10)) as m2;

-- media / phash
insert into app.listing_media(listing_id,kind,storage_key,mime,bytes,sha256,phash) values
 ('10000000-0000-0000-0000-000000000001','photo','k1','image/jpeg',100,'h1', B'1010101010101010101010101010101010101010101010101010101010101010'),
 ('10000000-0000-0000-0000-000000000006','photo','k2','image/jpeg',100,'h2', B'1010101010101010101010101010101010101010101010101010101010101011');
\echo == T10 near-duplicate photo (hamming distance 1) found from another listing: expect distance 1
select listing_id::text, distance from app.find_similar_media(B'1010101010101010101010101010101010101010101010101010101010101010', 6, '10000000-0000-0000-0000-000000000001');

-- constraints
\echo == T11 constraints (each must FAIL)
insert into app.listings(jurisdiction_code,rent_minor) values ('TN', 1000);
insert into app.listings(jurisdiction_code,rent_minor,currency,status) values ('TN', -5,'TND','draft');
insert into app.listings(jurisdiction_code,status) values ('XX','draft');
insert into app.profiles(user_id,budget_min_minor,budget_max_minor,currency) values ('00000000-0000-0000-0000-00000000000b',500,100,'TND');
insert into app.listings(jurisdiction_code,rent_minor,currency,status) values ('TN', 100,'XXX','draft');  -- unknown currency must FAIL

-- prompt registry
insert into ai.prompts(id,name,agent,role) values ('50000000-0000-0000-0000-000000000001','P1_router','orchestrator','routes request');
insert into ai.prompt_versions(prompt_id,version,template,status) values ('50000000-0000-0000-0000-000000000001',1,'v1','active');
\echo == T12 second active version for same prompt must FAIL, retired one must pass
insert into ai.prompt_versions(prompt_id,version,template,status) values ('50000000-0000-0000-0000-000000000001',2,'v2','active');
insert into ai.prompt_versions(prompt_id,version,template,status) values ('50000000-0000-0000-0000-000000000001',3,'v3','retired');

-- RLS
insert into app.profiles(user_id,jurisdiction_code) values ('00000000-0000-0000-0000-00000000000a','TN'),('00000000-0000-0000-0000-00000000000b','TN');
insert into app.threads(id,kind,owner_id) values ('60000000-0000-0000-0000-00000000000a','assistant','00000000-0000-0000-0000-00000000000a'),
                                                  ('60000000-0000-0000-0000-00000000000b','assistant','00000000-0000-0000-0000-00000000000b');
insert into app.messages(thread_id,sender,content) values ('60000000-0000-0000-0000-00000000000a','user','alice secret'),('60000000-0000-0000-0000-00000000000b','user','bob secret');

\echo == T13 RLS as api_user acting as Alice: sees 1 profile, 1 message, own draft + 5 published listings only
set role api_user;
select set_config('app.user_id','00000000-0000-0000-0000-00000000000a', false);
select count(*) as profiles_visible from app.profiles;
select content as messages_visible from app.messages;
select count(*) as listings_visible from app.listings;
\echo == T14 Alice cannot insert a profile for Bob (must FAIL)
insert into app.profiles(user_id) values ('00000000-0000-0000-0000-00000000000b');
select set_config('app.user_id','00000000-0000-0000-0000-00000000000b', false);
\echo == T15 as Bob: sees own profile, not Alice draft listing (published only => 5)
select count(*) as profiles_visible from app.profiles;
select count(*) as listings_visible from app.listings;
\echo == T16 no user set: sees nothing private
select set_config('app.user_id','', false);
select count(*) as profiles_visible from app.profiles;
select count(*) as messages_visible from app.messages;
reset role;

\echo == T17 n8n_worker bypasses RLS: sees everything
set role n8n_worker;
select count(*) as profiles_visible_to_worker from app.profiles;
reset role;

\echo == T18 erase_user(Alice): profile gone, messages blanked, listings archived and anonymised, media deleted, jobs queued
select app.erase_user('00000000-0000-0000-0000-00000000000a');
select count(*) as alice_profiles from app.profiles where user_id='00000000-0000-0000-0000-00000000000a';
select count(*) as alice_messages_with_content from app.messages where thread_id='60000000-0000-0000-0000-00000000000a' and content is not null;
select count(*) filter (where status='archived') as archived, count(*) filter (where title is not null) as titles_left from app.listings where jurisdiction_code='TN';
select count(*) as media_left from app.listing_media where listing_id='10000000-0000-0000-0000-000000000001';
select count(*) as delete_jobs from app.jobs where type='delete_media';
select email is null as email_null, deleted_at is not null as deleted from app.users where id='00000000-0000-0000-0000-00000000000a';
select count(*) as erased_listings_with_any_location from app.listings where status='archived' and (location is not null or public_location is not null);
select count(*) as bob_untouched from app.messages where content='bob secret';

-- ================= security regression tests (run after seed) =================
insert into app.listings(id,jurisdiction_code,status,title,rent_minor,currency) values ('10000000-0000-0000-0000-0000000000ff','TN','draft','hidden draft',1,'TND');
insert into app.listings(id,jurisdiction_code,status,title,rent_minor,currency,public_location) values ('10000000-0000-0000-0000-0000000000fe','TN','published','visible',1,'TND', st_point(10,36)::geography);
insert into app.listing_media(listing_id,kind,storage_key,mime,bytes,sha256) values
 ('10000000-0000-0000-0000-0000000000ff','photo','kd','image/jpeg',1,'hd'),
 ('10000000-0000-0000-0000-0000000000fe','photo','kp','image/jpeg',1,'hp');
\echo == T19 api_user must NOT read exact location (must FAIL)
set role api_user;
select location from app.listings limit 1;
\echo == T20 api_user CAN read public_location and other public columns
select count(public_location) > 0 as can_read_public_location from app.listings;
\echo == T21 api_user must NOT read trust_reports (must FAIL)
select * from app.trust_reports limit 1;
\echo == T22 api_user must NOT execute erase_user (must FAIL)
select app.erase_user('00000000-0000-0000-0000-00000000000b');
reset role;
\echo == T23 media of unpublished listings hidden from api_user; media of published visible
set role api_user;
select set_config('app.user_id','00000000-0000-0000-0000-00000000000b', false);
select storage_key from app.listing_media order by 1;
reset role;
\echo == T24 n8n_worker CAN execute erase_user and read location
set role n8n_worker;
select count(location) >= 0 as worker_reads_location from app.listings;
select app.erase_user('00000000-0000-0000-0000-00000000000b') is not null as worker_can_erase;
reset role;
