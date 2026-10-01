-- migrate:up
-- Phase 2: knowledge-base ingestion and retrieval evaluation.
-- docs/DECISIONS.md D-032 to D-041 explain the choices made here.

-- ---------------------------------------------------------------------------
-- Embedding models are data, not code (spec 5.5).
alter table ai.models
  add column kind           text not null default 'llm' check (kind in ('llm','embedding','reranker','asr','vision')),
  add column dims           integer,
  add column query_prefix   text not null default '',
  add column passage_prefix text not null default '',
  add column endpoint       text,            -- 'ollama' | 'tei'
  add column revision       text,            -- model revision when the endpoint pins one
  add column active         boolean not null default true;

insert into ai.models (name, provider, is_local, kind, dims, query_prefix, passage_prefix, endpoint, revision) values
  ('bge-m3', 'ollama', true, 'embedding', 1024, '', '', 'ollama', null),
  ('multilingual-e5-large', 'huggingface-tei', true, 'embedding', 1024, 'query: ', 'passage: ', 'tei',
   '3d7cfbdacd47fdda877c5cd8a79fbcc4f2a574f3')   -- pragma: allowlist secret (Hugging Face commit id of the model)
on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- Sources: stable key from kb/packs/<CODE>/sources.csv and fetch settings.
alter table kb.sources
  add column source_key      text unique check (source_key ~ '^[a-z0-9][a-z0-9-]{2,79}$'),
  add column fetch_config    jsonb not null default '{}'::jsonb,   -- {format, select, ...}
  add column cite_as         text,                                 -- 'COC' -> article refs 'COC art. 727'
  add column last_fetched_at timestamptz,
  add column last_status     text,
  add column last_error      text;

-- Raw bytes of every fetch (development scale; D-033).
create table kb.raw_fetches (
  id            uuid primary key default gen_random_uuid(),
  source_id     uuid not null references kb.sources(id) on delete cascade,
  fetched_at    timestamptz not null default now(),
  url           text not null,
  http_status   integer,
  content_type  text,
  byte_count    integer not null,
  sha256        text not null,
  bytes         bytea not null
);
create index on kb.raw_fetches (source_id, fetched_at desc);

alter table kb.documents
  add column raw_fetch_id uuid references kb.raw_fetches(id) on delete set null,
  add column status       text not null default 'current' check (status in ('current','superseded')),
  add column language     text,
  add column extractor    text,
  add column char_count   integer,
  add column metadata     jsonb not null default '{}'::jsonb;
create unique index documents_one_current on kb.documents (source_id) where status = 'current';

-- Character span of each chunk in its document's cleaned text: chunk content is
-- exactly substring(content from start_char+1 for end_char-start_char). Gold
-- spans are compared against these, so chunkers can be compared fairly.
alter table kb.chunks
  add column start_char integer,
  add column end_char   integer,
  add constraint chunks_span check (start_char is null or (start_char >= 0 and end_char > start_char));

-- Lexical side: normalised form (spec 10.2 step 3). Original text is kept for display.
-- unaccent() is STABLE; wrapping it with an explicit dictionary in an IMMUTABLE
-- function is the usual way to use it in a generated column.
create or replace function kb.lex_normalize(t text) returns text
language sql immutable parallel safe
set search_path = pg_catalog, public
as $$
  select lower(public.unaccent('public.unaccent'::regdictionary,
           translate(regexp_replace(normalize(coalesce(t, ''), NFKC),
                                    '[ً-ٰٟـ]', '', 'g'),   -- harakat, superscript alef, tatweel
                     'أإآٱى', 'ااااي')))                                       -- alef variants, alef maqsura
$$;

alter table kb.chunks drop column tsv;
alter table kb.chunks add column tsv tsvector
  generated always as (to_tsvector('simple', kb.lex_normalize(content))) stored;
create index chunks_tsv on kb.chunks using gin (tsv);

-- Query side of the lexical leg: normalised words joined with OR, minus a short
-- stop-word list (French, English, Arabic). 'simple' has no stop words of its own.
create or replace function kb.lex_query(q text) returns tsquery
language sql immutable parallel safe
set search_path = pg_catalog, public
as $$
  -- Same parser and normalisation as the indexed column, so query words and
  -- document lexemes always match the same way.
  select coalesce(nullif(string_agg(quote_literal(t.lexeme), ' | ' order by t.lexeme), ''), '')::tsquery
  from unnest(to_tsvector('simple', kb.lex_normalize(q))) as t
  where length(t.lexeme) > 1
    and t.lexeme <> all (array[
      'le','la','les','un','une','des','du','de','et','ou','en','au','aux','est','sont','que','qui','quoi',
      'dans','pour','par','sur','avec','sans','ce','cet','cette','ces','il','elle','ils','on','je','tu','nous','vous',
      'mon','ma','mes','son','sa','ses','leur','leurs','se','ne','pas','plus','qu',
      'quel','quelle','quels','quelles','combien','comment','faut','peut','doit',
      'the','an','of','to','in','on','for','and','or','is','are','be','by','with','what','which','who','how','do',
      'does','can','my','it','at','as','if','from','this','that','there','much','many',
      'في','من','على','الى','الي','عن','ما','هل','او','ان','هذا','هذه','التي','الذي','مع','كم','كيف','لا'])
$$;

-- ---------------------------------------------------------------------------
-- Ingestion log: one row per source and step.
create table kb.ingest_log (
  id          bigint generated always as identity primary key,
  job_id      uuid references app.jobs(id) on delete set null,
  source_id   uuid references kb.sources(id) on delete cascade,
  source_key  text,
  step        text not null,
  status      text not null check (status in ('ok','skipped','failed')),
  detail      jsonb not null default '{}'::jsonb,
  ms          integer,
  created_at  timestamptz not null default now()
);
create index on kb.ingest_log (job_id);

-- Store one fetch and, if the cleaned text changed, a new document version.
-- p = {source_id, url, http_status, content_type, bytes_b64, content, language,
--      extractor, metadata, force}
-- Returns {action: created|updated|unchanged, document_id, version, content_hash,
--          raw_sha256, char_count}.
create or replace function kb.store_document(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_source uuid := (p->>'source_id')::uuid;
  v_bytes  bytea := decode(coalesce(p->>'bytes_b64', ''), 'base64');
  v_content text := p->>'content';
  v_hash   text;
  v_raw    uuid;
  v_cur    kb.documents%rowtype;
  v_doc    uuid;
  v_ver    integer;
  v_action text;
begin
  if v_content is null or length(btrim(v_content)) = 0 then
    raise exception 'empty document content' using errcode = '22023';
  end if;
  v_hash := encode(sha256(convert_to(v_content, 'UTF8')), 'hex');
  insert into kb.raw_fetches (source_id, url, http_status, content_type, byte_count, sha256, bytes)
  values (v_source, p->>'url', (p->>'http_status')::int, p->>'content_type', length(v_bytes),
          encode(sha256(v_bytes), 'hex'), v_bytes)
  returning id into v_raw;

  select * into v_cur from kb.documents where source_id = v_source and status = 'current' for update;
  if found and v_cur.content_hash = v_hash and not coalesce((p->>'force')::boolean, false) then
    v_doc := v_cur.id; v_ver := v_cur.version; v_action := 'unchanged';
  else
    if found then
      update kb.documents set status = 'superseded' where id = v_cur.id;
      v_action := 'updated';
    else
      v_action := 'created';
    end if;
    v_ver := coalesce((select max(version) from kb.documents where source_id = v_source), 0) + 1;
    insert into kb.documents (source_id, version, content, content_hash, raw_fetch_id, status,
                              language, extractor, char_count, metadata)
    values (v_source, v_ver, v_content, v_hash, v_raw, 'current', p->>'language', p->>'extractor',
            length(v_content), coalesce(p->'metadata', '{}'::jsonb))
    returning id into v_doc;
  end if;

  update kb.sources set last_fetched_at = now(), last_status = 'fetched', last_error = null,
         retrieved_at = now()
   where id = v_source;
  return jsonb_build_object('action', v_action, 'document_id', v_doc, 'version', v_ver,
                            'content_hash', v_hash, 'raw_sha256', encode(sha256(v_bytes), 'hex'),
                            'char_count', length(v_content));
end $$;

-- What is still missing for a document: chunk counts per strategy and
-- embedding counts per (strategy, model).
create or replace function kb.document_progress(p_document uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'chunks', coalesce((select jsonb_object_agg(strategy, n) from
                (select strategy, count(*) n from kb.chunks where document_id = p_document group by 1) s), '{}'::jsonb),
    'embeddings', coalesce((select jsonb_object_agg(strategy || '|' || model, n) from
                (select c.strategy, e.model, count(*) n from kb.chunks c join kb.chunk_embeddings e on e.chunk_id = c.id
                 where c.document_id = p_document group by 1, 2) s), '{}'::jsonb))
$$;

-- Replace the chunks of one document for the strategies present in p_chunks.
-- p_chunks: [{strategy, chunk_index, start_char, end_char, heading_path[], article_ref,
--             token_count, metadata}]. Content is cut from the document text, so a
-- chunk can never differ from its span. Returns [{chunk_id, strategy, chunk_index}].
create or replace function kb.store_chunks(p_document uuid, p_chunks jsonb) returns jsonb
language plpgsql as $$
declare v_text text; v_out jsonb;
begin
  select content into v_text from kb.documents where id = p_document;
  if v_text is null then raise exception 'document % not found', p_document using errcode = 'P0002'; end if;
  delete from kb.chunks where document_id = p_document
     and strategy in (select distinct x->>'strategy' from jsonb_array_elements(p_chunks) x);
  with ins as (
    insert into kb.chunks (document_id, strategy, chunk_index, content, heading_path, article_ref,
                           token_count, metadata, start_char, end_char)
    select p_document, x->>'strategy', (x->>'chunk_index')::int,
           substr(v_text, (x->>'start_char')::int + 1, (x->>'end_char')::int - (x->>'start_char')::int),
           coalesce(array(select jsonb_array_elements_text(x->'heading_path')), '{}'),
           x->>'article_ref', (x->>'token_count')::int, coalesce(x->'metadata', '{}'::jsonb),
           (x->>'start_char')::int, (x->>'end_char')::int
    from jsonb_array_elements(p_chunks) x
    where (x->>'end_char')::int <= length(v_text)
    returning id, strategy, chunk_index
  )
  select coalesce(jsonb_agg(jsonb_build_object('chunk_id', id, 'strategy', strategy, 'chunk_index', chunk_index)
                            order by strategy, chunk_index), '[]'::jsonb)
    into v_out from ins;
  if jsonb_array_length(v_out) <> jsonb_array_length(p_chunks) then
    raise exception 'chunk span outside the document text' using errcode = '22023';
  end if;
  return v_out;
end $$;

-- Insert or replace embeddings. p_rows: [{chunk_id, embedding: [1024 floats]}].
-- The column type vector(1024) rejects any other dimension.
create or replace function kb.store_embeddings(p_model text, p_rows jsonb) returns integer
language plpgsql as $$
declare n integer;
begin
  if not exists (select 1 from ai.models where name = p_model and kind = 'embedding') then
    raise exception 'unknown embedding model %', p_model using errcode = '22023';
  end if;
  insert into kb.chunk_embeddings (chunk_id, model, embedding)
  select (x->>'chunk_id')::uuid, p_model, (x->>'embedding')::vector(1024)
  from jsonb_array_elements(p_rows) x
  on conflict (chunk_id, model) do update set embedding = excluded.embedding, created_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Retrieval (spec 10.5 steps 1 to 3). Replaces the baseline function: adds the
-- retrieval mode, only current document versions, the normalised lexical leg,
-- the dense similarity (for abstention thresholds later) and chunk spans.
drop function if exists kb.search_chunks(text, text, vector, text, text, smallint, integer);
create or replace function kb.search_chunks(
  p_model           text,
  p_strategy        text,
  q_embedding       vector(1024),
  q_text            text,
  p_jurisdiction    text default null,
  p_min_reliability smallint default 1,
  p_k               integer default 5,
  p_mode            text default 'hybrid',     -- 'dense' | 'lexical' | 'hybrid'
  p_candidates      integer default 50,
  p_rrf_k           integer default 60
) returns table (
  chunk_id uuid, rank integer, score double precision, dense_rank integer, lexical_rank integer,
  dense_similarity double precision, document_id uuid, start_char integer, end_char integer,
  source_id uuid, source_key text, source_type text, reliability smallint, article_ref text
) language sql stable as $$
  with filt as (
    select c.id as cid, e.embedding, c.tsv, c.document_id as did, c.start_char as sc, c.end_char as ec,
           s.id as sid, s.source_key as skey, s.source_type as stype, s.reliability as rel, c.article_ref as aref
    from kb.chunks c
    join kb.chunk_embeddings e on e.chunk_id = c.id and e.model = p_model
    join kb.documents d on d.id = c.document_id and d.status = 'current'
    join kb.sources s on s.id = d.source_id and s.status = 'active'
    where c.strategy = p_strategy
      and s.reliability >= p_min_reliability
      and (s.jurisdiction_code is null or s.jurisdiction_code = p_jurisdiction)
  ),
  dense as (
    select cid, (row_number() over (order by embedding <=> q_embedding))::int as r,
           1 - (embedding <=> q_embedding) as sim
    from filt
    where p_mode in ('dense', 'hybrid') and q_embedding is not null
    order by embedding <=> q_embedding limit p_candidates
  ),
  lex as (
    select cid, (row_number() over (order by ts_rank_cd(tsv, kb.lex_query(q_text), 1) desc, cid))::int as r
    from filt
    where p_mode in ('lexical', 'hybrid') and tsv @@ kb.lex_query(q_text)
    order by ts_rank_cd(tsv, kb.lex_query(q_text), 1) desc, cid limit p_candidates
  ),
  fused as (
    select coalesce(d.cid, x.cid) as cid,
           (coalesce(1.0 / (p_rrf_k + d.r), 0) + coalesce(1.0 / (p_rrf_k + x.r), 0))::double precision as score,
           d.r as dr, x.r as xr, d.sim
    from dense d full join lex x on d.cid = x.cid
  )
  select f.cid, (row_number() over (order by f.score desc, coalesce(f.dr, 999999), coalesce(f.xr, 999999), f.cid))::int,
         f.score, f.dr, f.xr, f.sim, fl.did, fl.sc, fl.ec, fl.sid, fl.skey, fl.stype, fl.rel, fl.aref
  from fused f join filt fl on fl.cid = f.cid
  order by f.score desc, coalesce(f.dr, 999999), coalesce(f.xr, 999999), f.cid
  limit p_k
$$;

-- ---------------------------------------------------------------------------
-- Evaluation: stable query ids from the dataset files, gold as quoted anchors.
alter table eval.queries add column external_id text;
create unique index queries_external on eval.queries (dataset_id, external_id);
alter table eval.runs
  add column job_id  uuid references app.jobs(id) on delete set null,
  add column status  text not null default 'running' check (status in ('running','succeeded','failed')),
  add column summary jsonb;

-- Gold spans are stored as quotes, not offsets, so they survive cleaner changes
-- that do not touch the quoted text (D-038):
--   {"spans": [{"source_key": "...", "start": "<first words>", "end": "<last words>"}]}
-- Resolves each span against the current document version. Character offsets
-- are 0-based, end exclusive. A span that cannot be found has found = false.
create or replace function eval.resolve_gold(p_gold jsonb) returns jsonb
language plpgsql stable as $$
declare
  sp jsonb; out jsonb := '[]'::jsonb;
  v_doc uuid; v_text text; s integer; e integer; n integer;
begin
  for sp in select * from jsonb_array_elements(coalesce(p_gold->'spans', '[]'::jsonb)) loop
    select d.id, d.content into v_doc, v_text
      from kb.documents d join kb.sources so on so.id = d.source_id
     where so.source_key = sp->>'source_key' and d.status = 'current';
    s := null; e := null; n := 0;
    if v_text is not null then
      s := strpos(v_text, sp->>'start');
      if s > 0 then
        -- occurrences of the start quote (an ambiguous anchor is reported, not guessed)
        n := (length(v_text) - length(replace(v_text, sp->>'start', ''))) / greatest(length(sp->>'start'), 1);
        e := strpos(substr(v_text, s), sp->>'end');
        if e > 0 then e := s - 1 + e - 1 + length(sp->>'end'); else e := null; end if;
      else
        s := null;
      end if;
    end if;
    out := out || jsonb_build_object(
      'source_key', sp->>'source_key', 'document_id', v_doc,
      'start', case when s is not null and e is not null then s - 1 end,
      'end', e,
      'found', s is not null and e is not null,
      'ambiguous', n > 1);
  end loop;
  return out;
end $$;

-- One search for the evaluation, with the time spent in the database.
-- p = {model, strategy, mode, k, candidates, rrf_k, jurisdiction, q_text, q_vec ('[..]' or null)}
create or replace function eval.timed_search(p jsonb) returns jsonb
language plpgsql stable as $$
declare t0 timestamptz := clock_timestamp(); res jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(r) order by r.rank), '[]'::jsonb) into res
  from kb.search_chunks(p->>'model', p->>'strategy', (p->>'q_vec')::vector(1024), p->>'q_text',
                        p->>'jurisdiction', 1::smallint, coalesce((p->>'k')::int, 10), coalesce(p->>'mode', 'hybrid'),
                        coalesce((p->>'candidates')::int, 50), coalesce((p->>'rrf_k')::int, 60)) r;
  return jsonb_build_object('ms', round(extract(epoch from clock_timestamp() - t0) * 1000, 2), 'results', res);
end $$;

-- ---------------------------------------------------------------------------
-- Settings for the pipeline (no secrets).
insert into app.settings (key, value, description) values
  ('kb.tei_base_url',      '"http://tei:80"', 'Text Embeddings Inference (multilingual-e5-large, tokenizer)'),
  ('kb.user_agent',        '"FlatshareKB/0.2 (+student project; contact: repository owner)"', 'User-Agent for source fetches and robots.txt'),
  ('kb.fetch_timeout_ms',  '60000', 'Timeout for one source fetch'),
  ('kb.embed_timeout_ms',  '600000', 'Timeout for one embedding batch'),
  ('kb.batch_bge',         '32', 'Texts per Ollama embedding request'),
  ('kb.batch_e5',          '16', 'Texts per TEI embedding request'),
  ('kb.batch_tokenize',    '32', 'Text pieces per TEI tokenize request'),
  ('kb.embedding_models',  '["bge-m3", "multilingual-e5-large"]', 'Models every chunk is embedded with'),
  ('kb.strategies',        '["fixed_500_50", "structure_aware_v1"]', 'Chunking strategies applied at ingestion'),
  ('eval.relevance_overlap', '0.5', 'A chunk is relevant if it overlaps a gold span by this fraction of the shorter of the two')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Grants (D-012: nothing is executable by PUBLIC; n8n_worker gets what it calls).
revoke execute on all functions in schema kb, eval from public;
grant usage on schema eval to n8n_worker;
grant select, insert, update, delete on kb.raw_fetches, kb.ingest_log to n8n_worker;
grant usage, select on all sequences in schema kb to n8n_worker;
grant execute on function kb.lex_normalize(text), kb.lex_query(text),
  kb.store_document(jsonb), kb.document_progress(uuid), kb.store_chunks(uuid, jsonb),
  kb.store_embeddings(text, jsonb),
  kb.search_chunks(text, text, vector, text, text, smallint, integer, text, integer, integer),
  eval.resolve_gold(jsonb), eval.timed_search(jsonb) to n8n_worker;

-- migrate:down
drop function if exists eval.timed_search(jsonb);
drop function if exists eval.resolve_gold(jsonb);
alter table eval.runs drop column if exists summary, drop column if exists status, drop column if exists job_id;
drop index if exists eval.queries_external;
alter table eval.queries drop column if exists external_id;
drop function if exists kb.search_chunks(text, text, vector, text, text, smallint, integer, text, integer, integer);
drop function if exists kb.store_embeddings(text, jsonb);
drop function if exists kb.store_chunks(uuid, jsonb);
drop function if exists kb.document_progress(uuid);
drop function if exists kb.store_document(jsonb);
drop table if exists kb.ingest_log;
alter table kb.chunks drop column tsv;
alter table kb.chunks add column tsv tsvector generated always as (to_tsvector('simple', content)) stored;
create index chunks_tsv on kb.chunks using gin (tsv);
drop function if exists kb.lex_query(text);
drop function if exists kb.lex_normalize(text);
alter table kb.chunks drop constraint if exists chunks_span, drop column if exists end_char, drop column if exists start_char;
drop index if exists kb.documents_one_current;
alter table kb.documents drop column if exists metadata, drop column if exists char_count, drop column if exists extractor,
  drop column if exists language, drop column if exists status, drop column if exists raw_fetch_id;
drop table if exists kb.raw_fetches;
alter table kb.sources drop column if exists last_error, drop column if exists last_status, drop column if exists last_fetched_at,
  drop column if exists cite_as, drop column if exists fetch_config, drop column if exists source_key;
delete from ai.models where name in ('bge-m3', 'multilingual-e5-large');
alter table ai.models drop column if exists active, drop column if exists revision, drop column if exists endpoint,
  drop column if exists passage_prefix, drop column if exists query_prefix, drop column if exists dims, drop column if exists kind;
delete from app.settings where key like 'kb.%' or key = 'eval.relevance_overlap';
-- the baseline search function is restored by re-running 0001's definition if needed
