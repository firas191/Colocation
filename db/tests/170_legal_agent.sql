-- Migration 0018: the A5 Legal agent's context, knowledge-base search with numbered excerpts, follow-ups (D-087).
\ir helpers.psql
begin;
select plan(17);

insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, timezone)
values ('ZL', 'ZL', 'pgTAP legal agent', 'TND', 'fr', 'UTC'), ('ZO', 'ZO', 'pgTAP other country', 'TND', 'fr', 'UTC');
insert into app.users (id, email, display_name, role, jurisdiction_code) values
  ('00000000-0000-0000-0000-0000000000c1', 'legal@example.test', 'Asker', 'user', 'ZL');
-- one law in ZL (two fixed chunks; structure-aware chunks give the article), one global guide, one law of another country
insert into kb.sources (id, jurisdiction_code, title, url, source_type, reliability, language, source_key, cite_as) values
  ('00000000-0000-0000-0000-0000000000d1', 'ZL', 'Loi ZL', 'https://example.test/zl', 'primary_law', 5, 'fr', 'pgtap-zl-law', 'LZL'),
  ('00000000-0000-0000-0000-0000000000d2', null, 'Guide global', 'https://example.test/g', 'ngo', 3, 'fr', 'pgtap-global', null),
  ('00000000-0000-0000-0000-0000000000d3', 'ZO', 'Loi ZO', 'https://example.test/zo', 'primary_law', 5, 'fr', 'pgtap-zo-law', null);
insert into kb.documents (id, source_id, content, content_hash) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', repeat('a', 200), 'h1'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000d2', repeat('b', 100), 'h2'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000d3', repeat('c', 100), 'h3');
insert into kb.chunks (id, document_id, strategy, chunk_index, content, article_ref, start_char, end_char) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e1', 'fixed_500_50', 0, 'caution restituée deux mois', null, 0, 100),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000e1', 'fixed_500_50', 1, 'préavis du locataire', null, 100, 200),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000e1', 'structure_aware_v1', 0, 'x', 'LZL art. 4', 0, 80),
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000e1', 'structure_aware_v1', 1, 'x', 'LZL art. 5', 80, 200),
  ('00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-0000000000e2', 'fixed_500_50', 0, 'caution guide', null, 0, 100),
  ('00000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000e3', 'fixed_500_50', 0, 'caution autre pays', null, 0, 100);
-- embeddings on the first two axes; the query is on axis 1: f1 similarity 1, f5 0.707, f2 0 (f6 is in another country)
insert into kb.chunk_embeddings (chunk_id, model, embedding)
select id::uuid, 'bge-m3', ('[' || a1 || ',' || a2 || repeat(',0', 1022) || ']')::vector
  from (values ('00000000-0000-0000-0000-0000000000f1', 1, 0), ('00000000-0000-0000-0000-0000000000f2', 0, 1),
               ('00000000-0000-0000-0000-0000000000f5', 1, 1), ('00000000-0000-0000-0000-0000000000f6', 1, 0)) v(id, a1, a2);
create temp table t_q as select '[1' || repeat(',0', 1023) || ']' as v;

create temp table t_c as select app.legal_agent_context('00000000-0000-0000-0000-0000000000c1') as c;
select is((select c->>'session_id' from t_c), 'legal:user:00000000-0000-0000-0000-0000000000c1', 'own conversation, apart from the Match agent');
select is((select (c->>'num_ctx')::int = 8192 and (c->>'memory_turns')::int = 2 and c->>'agent' = 'A5_legal_agent'
                  and c->>'notice_version' = 'legal-notice-v1' from t_c), true, 'context: 8192 tokens, 2 turns, notice version');

create temp table t_s as select app.legal_search('legal:user:00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1',
  '00000000-0000-0000-0000-00000000aa01', 'caution', (select v from t_q), 'ZL') as r;
select is((select jsonb_path_query_array(r->'excerpts', '$[*].source') from t_s), '["Loi ZL", "Guide global", "Loi ZL"]'::jsonb,
          'the country''s sources and the global ones, never another country''s, by similarity');
select is((select jsonb_path_query_array(r->'excerpts', '$[*].n') from t_s), '[1, 2, 3]'::jsonb, 'numbered from 1');
select is((select r->'excerpts'->0->>'article' from t_s), 'LZL art. 4', 'article of the structure-aware chunk over the same text');
select is((select r->'excerpts'->2->>'article' from t_s), 'LZL art. 5', 'the one that overlaps most');
select is((select (r->>'best_similarity')::numeric from t_s), 1.0, 'best similarity');

-- a second search of the same request: a known excerpt keeps its number
select is(app.legal_search('legal:user:00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1',
  '00000000-0000-0000-0000-00000000aa01', 'caution', (select v from t_q), 'ZL')->'excerpts'->0->>'n', '1', 'same excerpt, same number');
select is((app.legal_sources_of('legal:user:00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000aa01')->>'searches')::int, 2,
          'two searches counted for the request');

-- next request: numbers go on, the old excerpts stay citable, a re-found one keeps its number
select is(app.legal_search('legal:user:00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1',
  '00000000-0000-0000-0000-00000000aa02', 'caution', (select v from t_q), 'ZL')->'excerpts'->0->>'n', '1', 'kept across requests');
select is(jsonb_array_length(app.legal_sources_of('legal:user:00000000-0000-0000-0000-0000000000c1',
          '00000000-0000-0000-0000-00000000aa02')->'sources'), 3, 'the previous request''s excerpts are still there');

-- lexical when the embedding failed
select is(app.legal_search('legal:user:00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1',
  '00000000-0000-0000-0000-00000000aa03', 'préavis', null, 'ZL')->>'mode', 'lexical', 'no vector: lexical search');

-- abstention threshold
update app.settings set value = '1.5' where key = 'legal.min_similarity';
create temp table t_t as select app.legal_search('legal:user:00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1',
  '00000000-0000-0000-0000-00000000aa04', 'caution', (select v from t_q), 'ZL') as r;
select is((select (r->>'found')::int = 0 and (r->>'below_threshold')::boolean from t_t), true, 'below legal.min_similarity: no excerpt');
update app.settings set value = '0' where key = 'legal.min_similarity';

-- follow-ups: the most recent conversation within match.followup_minutes
select is(app.agent_followup('00000000-0000-0000-0000-0000000000c1'), 'legal', 'a legal conversation is open');
insert into ai.match_sessions (session_id, user_id, updated_at)
values ('user:00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1', clock_timestamp() + interval '1 second');
select is(app.agent_followup('00000000-0000-0000-0000-0000000000c1'), 'match', 'a later search wins');
update ai.match_sessions set updated_at = now() - interval '2 hours'; update ai.legal_sessions set updated_at = now() - interval '2 hours';
select is(app.agent_followup('00000000-0000-0000-0000-0000000000c1'), null, 'nothing recent: no follow-up');

-- withdrawing consent forgets the legal conversation
insert into app.consents (user_id, purpose, granted, policy_version) values ('00000000-0000-0000-0000-0000000000c1', 'privacy', false, 't');
select is((select count(*)::int from ai.legal_sessions where user_id = '00000000-0000-0000-0000-0000000000c1'), 0, 'consent withdrawn: forgotten');

select * from finish();
rollback;
