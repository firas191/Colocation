-- Regression tests for migration 0003 (defects D-010 to D-014 in docs/DECISIONS.md).
-- Run against a database with only 0001 + 0002 applied, most of these fail:
-- that run is recorded in docs/TEST_REPORT.md as proof the defects existed.
\ir helpers.psql
begin;
select plan(33);

insert into app.jurisdictions(code,country_code,name,default_currency,default_locale,timezone,active)
values ('TN','TN','Tunisia','TND','fr-TN','Africa/Tunis',true);
insert into app.users(id,email,display_name,jurisdiction_code) values
 ('00000000-0000-0000-0000-00000000000a','a@example.com','Alice','TN'),
 ('00000000-0000-0000-0000-00000000000b','b@example.com','Bob','TN');
\set alice '00000000-0000-0000-0000-00000000000a'
\set bob '00000000-0000-0000-0000-00000000000b'
insert into app.consents(user_id,purpose,granted,policy_version) values
 (:'alice','terms',true,'terms-v1'), (:'bob','terms',true,'terms-v1'), (:'bob','marketing',false,'mkt-v1');
insert into app.listings(id,owner_id,jurisdiction_code,status,title,rent_minor,currency)
values ('10000000-0000-0000-0000-00000000000a',:'alice','TN','draft','Alice draft',250000,'TND');
insert into app.threads(id,kind,owner_id) values ('60000000-0000-0000-0000-00000000000a','assistant',:'alice');

-- D-010 consents
select is(pg_temp.as_user('api_user', :'bob', 'select count(*)::text from app.consents'), '2', 'D-010 Bob sees only his 2 consent rows');
select is(pg_temp.as_user('api_user', :'alice', 'select count(*)::text from app.consents'), '1', 'D-010 Alice sees only her consent row');
select is(pg_temp.as_user('api_user', :'alice',
  $$insert into app.consents(user_id,purpose,granted,policy_version) values ('00000000-0000-0000-0000-00000000000b','marketing',true,'x')$$),
  'ERROR 42501', 'D-010 Alice cannot record consent for Bob');
select is(pg_temp.as_user('api_user', :'alice',
  $$insert into app.consents(user_id,purpose,granted,policy_version) values ('00000000-0000-0000-0000-00000000000a','privacy',true,'privacy-v1')$$),
  'ROWS 1', 'D-010 Alice can record her own consent');
select is(pg_temp.as_user('api_user', :'alice', $$update app.consents set granted = false$$), 'ERROR 42501', 'D-010 consents cannot be updated (append-only)');
select is(pg_temp.as_user('api_user', :'alice', $$delete from app.consents$$), 'ERROR 42501', 'D-010 consents cannot be deleted by api_user');

-- D-011 listings column privileges
select is(pg_temp.as_user('api_user', :'alice',
  $$insert into app.listings(owner_id,jurisdiction_code,status,title) values ('00000000-0000-0000-0000-00000000000a','TN','published','x')$$),
  'ERROR 42501', 'D-011 api_user cannot insert a published listing');
select is(pg_temp.as_user('api_user', :'alice',
  $$insert into app.listings(owner_id,jurisdiction_code,title,trust_score) values ('00000000-0000-0000-0000-00000000000a','TN','x',100)$$),
  'ERROR 42501', 'D-011 api_user cannot set trust_score');
select is(pg_temp.as_user('api_user', :'alice',
  $$insert into app.listings(owner_id,jurisdiction_code,title,is_synthetic) values ('00000000-0000-0000-0000-00000000000a','TN','x',true)$$),
  'ERROR 42501', 'D-011 api_user cannot set is_synthetic');
select is(pg_temp.as_user('api_user', :'alice',
  $$insert into app.listings(owner_id,jurisdiction_code,title,rent_minor,currency) values ('00000000-0000-0000-0000-00000000000a','TN','ok draft',100000,'TND') returning status$$),
  'draft', 'D-011 api_user can create its own draft');
select is(pg_temp.as_user('api_user', :'alice',
  $$insert into app.listings(owner_id,jurisdiction_code,title) values ('00000000-0000-0000-0000-00000000000b','TN','for bob')$$),
  'ERROR 42501', 'D-011 api_user cannot create a listing owned by someone else');
select is(pg_temp.as_user('api_user', :'alice',
  $$update app.listings set status = 'published' where id = '10000000-0000-0000-0000-00000000000a'$$),
  'ERROR 42501', 'D-011 api_user cannot publish by update');
select is(pg_temp.as_user('api_user', :'alice',
  $$update app.listings set trust_verdict = 'ok', trust_score = 99 where id = '10000000-0000-0000-0000-00000000000a'$$),
  'ERROR 42501', 'D-011 api_user cannot write trust fields');
select is(pg_temp.as_user('api_user', :'alice',
  $$update app.listings set title = 'renamed' where id = '10000000-0000-0000-0000-00000000000a' returning title$$),
  'renamed', 'D-011 api_user can edit its own title');
select is(pg_temp.as_user('api_user', :'bob',
  $$update app.listings set title = 'hijack' where id = '10000000-0000-0000-0000-00000000000a' returning title$$),
  'NULL', 'D-011 Bob cannot edit Alice''s listing (0 rows)');
select is(pg_temp.as_user('api_user', :'alice',
  $$delete from app.listings where id = '10000000-0000-0000-0000-00000000000a'$$),
  'ERROR 42501', 'D-011 api_user cannot hard-delete a listing');

-- D-012 messages
select is(pg_temp.as_user('api_user', :'alice',
  $$insert into app.messages(thread_id,sender,sender_user_id,content) values ('60000000-0000-0000-0000-00000000000a','assistant','00000000-0000-0000-0000-00000000000a','fake')$$),
  'ERROR 42501', 'D-012 api_user cannot write assistant messages');
select is(pg_temp.as_user('api_user', :'alice',
  $$insert into app.messages(thread_id,sender,sender_user_id,content) values ('60000000-0000-0000-0000-00000000000a','user','00000000-0000-0000-0000-00000000000b','spoof')$$),
  'ERROR 42501', 'D-012 api_user cannot write messages as another user');
select is(pg_temp.as_user('api_user', :'alice',
  $$insert into app.messages(thread_id,sender,sender_user_id,content) values ('60000000-0000-0000-0000-00000000000a','user','00000000-0000-0000-0000-00000000000a','hello') returning content$$),
  'hello', 'D-012 api_user can write its own user message');
select is(pg_temp.as_user('api_user', :'alice', $$update app.messages set content = 'edited'$$), 'ERROR 42501', 'D-012 messages cannot be edited');

-- D-013 function privileges
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('app','kb','ai','eval','sec')
             and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))),
          0, 'D-013 no function in app/kb/ai/eval/sec is executable by PUBLIC');
select set_eq($$ select n.nspname || '.' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname in ('app','kb','ai','eval','sec') and has_function_privilege('api_user', p.oid, 'execute') $$,
              array['app.current_user_id','app.or_tsquery','app.search_listings'],
              'D-013 api_user can execute exactly three functions');
select is(pg_temp.as_user('api_user', '', $$select count(*)::text from app.find_similar_media(B'0000000000000000000000000000000000000000000000000000000000000000')$$),
          'ERROR 42501', 'D-013 api_user cannot run the duplicate-photo lookup');
create table app.zz_future_table (id int);
select ok(has_table_privilege('n8n_worker', 'app.zz_future_table', 'insert'), 'D-013 default privileges: n8n_worker can write new tables');
select ok(not has_table_privilege('api_user', 'app.zz_future_table', 'select'), 'D-013 default privileges: api_user gets nothing on new tables');

-- D-014 erase_user completeness
insert into app.listing_media(listing_id,kind,storage_key,mime,bytes,sha256) values
 ('10000000-0000-0000-0000-00000000000a','photo','listings/a/p1.jpg','image/jpeg',10,'s1'),
 ('10000000-0000-0000-0000-00000000000a','audio','listings/a/v1.ogg','audio/ogg',10,'s2');
insert into app.generated_documents(user_id,kind,language,storage_key,inputs)
values (:'alice','roommate_agreement','fr','docs/a/agreement.pdf','{"names":["Alice","Carol"]}');
insert into app.reports(reporter_id,listing_id,reason,detail) values (:'alice',null,'scam','Alice wrote this text');
insert into app.jobs(type,input,requested_by) values ('transcribe','{"text":"my phone is 22 000 000"}',:'alice');
insert into ai.executions(request_id,workflow,user_id) values (gen_random_uuid(),'wf.test',:'alice');
insert into app.idempotency_keys(scope,idem_key,route,body_sha256,state,user_id)
values ('k:'||:'alice','key-12345678','POST /v1/x',repeat('a',64),'completed',:'alice');

select lives_ok($$ select app.erase_user('00000000-0000-0000-0000-00000000000a') $$, 'D-014 erase_user runs');
select is((select input->'storage_keys' from app.jobs where idempotency_key = 'erase-media-10000000-0000-0000-0000-00000000000a'),
          '["listings/a/p1.jpg", "listings/a/v1.ogg"]'::jsonb, 'D-014 media deletion job carries the storage keys');
select is((select input->'storage_keys' from app.jobs where idempotency_key = 'erase-docs-' || :'alice'),
          '["docs/a/agreement.pdf"]'::jsonb, 'D-014 generated PDFs are queued for deletion');
select is((select count(*)::int from app.generated_documents where user_id = :'alice'), 0, 'D-014 generated document rows removed');
select ok((select reporter_id is null and detail is null from app.reports where reason = 'scam'), 'D-014 report text and reporter removed');
select ok((select requested_by is null and status = 'cancelled' and input = '{"erased": true}'::jsonb from app.jobs where type = 'transcribe'),
          'D-014 queued job cancelled and its input scrubbed');
select is((select count(*)::int from ai.executions where user_id = :'alice'), 0, 'D-014 execution rows unlinked');
select is((select count(*)::int from app.idempotency_keys where user_id = :'alice'), 0, 'D-014 stored responses removed');

select * from finish();
rollback;
