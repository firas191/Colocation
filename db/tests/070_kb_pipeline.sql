-- Knowledge-base pipeline and retrieval functions (migration 0007).
\ir helpers.psql
begin;
select plan(37);

-- ---------------------------------------------------------------- normalisation
select is(kb.lex_normalize('Le LOYER Réglé à l''Avance'), 'le loyer regle a l''avance', 'Latin: lower case, accents removed');
select is(kb.lex_normalize('الإِيجَارُ يُدْفَعُ'), 'الايجار يدفع', 'Arabic: harakat removed, hamza-alef unified');
select is(kb.lex_normalize('مستشفى ـــ آخر'), 'مستشفي  اخر', 'Arabic: alef maqsura to ya, tatweel removed, madda alef unified');
select is(kb.lex_normalize('ﻻ'), 'لا', 'NFKC: Arabic presentation form decomposed');
select is(kb.lex_query('Quel est le délai de préavis ?')::text, '''delai'' | ''preavis''', 'query: stop words dropped, normalised, OR-joined');
select is(kb.lex_query('ما هي مدة الإعلام')::text, '''الاعلام'' | ''مدة'' | ''هي''', 'query: Arabic stop words dropped');
select is(kb.lex_query('the of le')::text, '', 'query of stop words only is empty');

-- ---------------------------------------------------------------- fixtures
insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, timezone)
values ('ZY', 'ZY', 'pgTAP jurisdiction', 'TND', 'fr', 'UTC'), ('ZX', 'ZX', 'pgTAP other', 'TND', 'fr', 'UTC');
insert into kb.sources (id, source_key, jurisdiction_code, title, url, source_type, reliability, language)
values ('00000000-0000-0000-0000-0000000000b1', 'pgtap-law', 'ZY', 'Law', 'https://x.test/law', 'primary_law', 5, 'fr'),
       ('00000000-0000-0000-0000-0000000000b2', 'pgtap-blog', 'ZY', 'Blog', 'https://x.test/blog', 'blog', 1, 'fr'),
       ('00000000-0000-0000-0000-0000000000b3', 'pgtap-global', null, 'Global', 'https://x.test/g', 'ngo', 3, 'ar'),
       ('00000000-0000-0000-0000-0000000000b4', 'pgtap-other', 'ZX', 'Other', 'https://x.test/o', 'primary_law', 5, 'fr');

-- ---------------------------------------------------------------- store_document
select is(kb.store_document('{"source_id":"00000000-0000-0000-0000-0000000000b1","url":"https://x.test/law","http_status":200,
  "content_type":"text/html","bytes_b64":"PGh0bWw+","content":"Article 1\n\nLe dépôt de garantie est restitué.\n\nArticle 2\n\nLe loyer est payé chaque mois.","language":"fr","extractor":"html_v1"}')->>'action',
  'created', 'first fetch creates version 1');
select is(kb.store_document('{"source_id":"00000000-0000-0000-0000-0000000000b1","url":"https://x.test/law","bytes_b64":"PGh0bWw+",
  "content":"Article 1\n\nLe dépôt de garantie est restitué.\n\nArticle 2\n\nLe loyer est payé chaque mois."}')->>'action',
  'unchanged', 'same cleaned text: unchanged, no new version');
select is((select count(*)::int from kb.raw_fetches where source_id = '00000000-0000-0000-0000-0000000000b1'), 2, 'every fetch keeps its raw bytes');
select is((select encode(bytes, 'escape') || ' ' || sha256 from kb.raw_fetches where source_id = '00000000-0000-0000-0000-0000000000b1' limit 1),
  '<html> ' || encode(sha256('<html>'::bytea), 'hex'), 'raw bytes and their sha256 stored');
select is(kb.store_document('{"source_id":"00000000-0000-0000-0000-0000000000b1","url":"u","bytes_b64":"",
  "content":"Article 1\n\nLe dépôt de garantie est restitué sans retard.\n\nArticle 2\n\nLe loyer est payé chaque mois."}')->>'version',
  '2', 'changed text: version 2');
select is((select string_agg(version || ':' || status, ',' order by version) from kb.documents where source_id = '00000000-0000-0000-0000-0000000000b1'),
  '1:superseded,2:current', 'old version superseded, one current');
select throws_ok($$ select kb.store_document('{"source_id":"00000000-0000-0000-0000-0000000000b1","url":"u","content":"   "}') $$,
  '22023', 'empty document content', 'empty cleaned text rejected');

select id as doc1 from kb.documents where source_id = '00000000-0000-0000-0000-0000000000b1' and version = 1 \gset
select id as doc2 from kb.documents where source_id = '00000000-0000-0000-0000-0000000000b1' and status = 'current' \gset
select (kb.store_document('{"source_id":"00000000-0000-0000-0000-0000000000b2","url":"u","content":"Selon ce blog le dépôt de garantie n''est jamais restitué."}')->>'document_id') as docb \gset
select (kb.store_document('{"source_id":"00000000-0000-0000-0000-0000000000b3","url":"u","content":"يرجع الضمان عند انتهاء الكراء"}')->>'document_id') as docg \gset
select (kb.store_document('{"source_id":"00000000-0000-0000-0000-0000000000b4","url":"u","content":"Le dépôt de garantie dans une autre juridiction."}')->>'document_id') as doco \gset

-- ---------------------------------------------------------------- store_chunks
select is(jsonb_array_length(kb.store_chunks(:'doc2', '[
  {"strategy":"s","chunk_index":0,"start_char":0,"end_char":57,"heading_path":["Titre"],"article_ref":"art. 1","token_count":10},
  {"strategy":"s","chunk_index":1,"start_char":59,"end_char":100,"article_ref":"art. 2","token_count":9}]')), 2, 'two chunks stored');
select is((select content from kb.chunks where document_id = :'doc2' and chunk_index = 0), 'Article 1' || chr(10) || chr(10) || 'Le dépôt de garantie est restitué sans retard.',
  'chunk content is cut from the document by its span');
select is((select heading_path[1] || ' ' || article_ref from kb.chunks where document_id = :'doc2' and chunk_index = 0), 'Titre art. 1', 'heading path and article ref kept');
select throws_ok(format($$ select kb.store_chunks(%L, '[{"strategy":"s","chunk_index":0,"start_char":0,"end_char":9999}]') $$, :'doc2'),
  '22023', 'chunk span outside the document text', 'span beyond the text rejected');
select is(jsonb_array_length(kb.store_chunks(:'doc2', '[{"strategy":"s","chunk_index":0,"start_char":0,"end_char":57}]')), 1, 'storing again replaces that strategy''s chunks');
select is((select count(*)::int from kb.chunks where document_id = :'doc2'), 1, 'old chunks of the strategy are gone');
select lives_ok(format($$ select kb.store_chunks(%L, '[{"strategy":"s","chunk_index":0,"start_char":0,"end_char":9}]') $$, :'doc1'), 'chunk the superseded version (for the search test)');
select lives_ok(format($$ select kb.store_chunks(%L, '[{"strategy":"s","chunk_index":0,"start_char":0,"end_char":57}]') $$, :'docb'), 'chunk the blog');
select lives_ok(format($$ select kb.store_chunks(%L, '[{"strategy":"s","chunk_index":0,"start_char":0,"end_char":29}]') $$, :'docg'), 'chunk the global document');
select lives_ok(format($$ select kb.store_chunks(%L, '[{"strategy":"s","chunk_index":0,"start_char":0,"end_char":47}]') $$, :'doco'), 'chunk the other jurisdiction');

-- ---------------------------------------------------------------- store_embeddings
select throws_ok($$ select kb.store_embeddings('no-such-model', '[]') $$, '22023', 'unknown embedding model no-such-model', 'unknown model rejected');
select throws_ok(format($$ select kb.store_embeddings('bge-m3', '[{"chunk_id":"%s","embedding":[1,2,3]}]') $$,
  (select id from kb.chunks where document_id = :'doc2')), '22000', null, 'wrong dimension rejected by vector(1024)');
select is(kb.store_embeddings('bge-m3', (select jsonb_agg(jsonb_build_object('chunk_id', c.id,
  'embedding', (pg_temp.vec(n, n)::text)::jsonb)) from (select id, row_number() over (order by id)::int as n from kb.chunks) c(id, n)
  join kb.chunks using (id))), 5, 'embeddings stored for all five chunks');

-- ---------------------------------------------------------------- search_chunks
select is((select string_agg(source_key, ',' order by rank) from kb.search_chunks('bge-m3', 's', null, 'dépôt garantie restitué', 'ZY', 1::smallint, 10, 'lexical')),
  'pgtap-law,pgtap-blog', 'lexical: only current versions of the jurisdiction (+global), law ranked first');
select is((select count(*)::int from kb.search_chunks('bge-m3', 's', null, 'dépôt garantie', 'ZY', 3::smallint, 10, 'lexical')), 1,
  'minimum reliability filters the blog out');
select is((select string_agg(source_key, ',' order by rank) from kb.search_chunks('bge-m3', 's', null, 'الضمان', 'ZY', 1::smallint, 10, 'lexical')),
  'pgtap-global', 'global sources are included; Arabic lexical match');
select is((select count(*)::int from kb.search_chunks('bge-m3', 's', (select embedding from kb.chunk_embeddings limit 1), 'zzz', 'ZY', 1::smallint, 10, 'dense')), 3,
  'dense: every current chunk of ZY and global is a candidate, other jurisdictions and old versions are not');
select ok((select bool_and(dense_similarity between -1 and 1.0000001) from kb.search_chunks('bge-m3', 's', (select embedding from kb.chunk_embeddings limit 1), 'dépôt', 'ZY', 1::smallint, 10, 'hybrid')),
  'hybrid returns the dense similarity');

-- ---------------------------------------------------------------- gold and timed search
select is(eval.resolve_gold('{"spans":[{"source_key":"pgtap-law","start":"Le dépôt","end":"sans retard."}]}')->0->>'start', '11', 'gold resolved to 0-based offsets');
select is(eval.resolve_gold('{"spans":[{"source_key":"pgtap-law","start":"Article","end":"retard."},{"source_key":"pgtap-law","start":"absent","end":"x"}]}')::text ~ '"ambiguous": true.*"found": false', true,
  'ambiguous start quote and missing quote are reported');
select ok((eval.timed_search('{"model":"bge-m3","strategy":"s","mode":"lexical","k":5,"jurisdiction":"ZY","q_text":"loyer"}')->>'ms')::numeric >= 0, 'timed search reports milliseconds');

-- ---------------------------------------------------------------- grants
select is(pg_temp.as_user('n8n_worker', '', $$ select count(*)::text from kb.search_chunks('bge-m3', 's', null, 'restitué', 'ZY', 1::smallint, 5, 'lexical') $$),
  '2', 'n8n_worker can search');
select is(pg_temp.as_user('api_user', '', $$ select kb.store_document('{}')::text $$), 'ERROR 42501', 'api_user cannot write the knowledge base');

select * from finish();
rollback;
