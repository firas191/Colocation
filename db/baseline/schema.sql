-- =====================================================================
-- Flatshare platform: Postgres 16 schema (worldwide, jurisdiction-aware)
-- Requires: pgvector, PostGIS, pg_trgm, pgcrypto, citext, unaccent
-- Embedding dimension 1024 (BGE-M3 and multilingual-e5-large both use 1024)
-- =====================================================================

create extension if not exists vector;
create extension if not exists postgis;
create extension if not exists pg_trgm;
create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists unaccent;

create schema if not exists app;    -- product data
create schema if not exists kb;     -- knowledge base for RAG
create schema if not exists ai;     -- prompts, executions, agent traces
create schema if not exists eval;   -- evaluation datasets and runs

-- ---------- generic helpers -----------------------------------------
create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Current end-user id for row level security. The future API sets it per
-- request: select set_config('app.user_id', '<uuid>', true);
create or replace function app.current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- =====================================================================
-- REFERENCE: currencies. Money is stored as integer minor units.
-- exponent = number of decimals (ISO 4217): EUR 2, JPY 0, TND 3 (1 dinar = 1000 millimes).
-- Example: 250 TND is stored as 250000. 45 EUR is stored as 4500.
-- =====================================================================
create table app.currencies (
  code     char(3) primary key,
  exponent smallint not null check (exponent between 0 and 4),
  symbol   text
);
insert into app.currencies(code, exponent, symbol) values
  ('TND',3,'DT'), ('EUR',2,'EUR'), ('GBP',2,'GBP'), ('USD',2,'USD'), ('CAD',2,'CAD'),
  ('CHF',2,'CHF'), ('MAD',2,'MAD'), ('DZD',2,'DZD'), ('AED',2,'AED'), ('JPY',0,'JPY'),
  ('KWD',3,'KWD'), ('BHD',3,'BHD');

-- =====================================================================
-- REFERENCE: jurisdictions (the unit of "worldwide")
-- Code examples: 'TN', 'FR', 'GB', 'DE', 'US-CA', 'CA-ON'
-- rules jsonb holds machine-readable local rules, each with a source url:
--   {"allowed_preference_filters": ["gender","smoking","pets"],
--    "deposit_cap_months": {"value": 1, "source": "https://..."},
--    "notice_period_days":  {"value": 90, "source": "https://..."},
--    "lease_registration_required": {"value": null, "note": "sources disagree"}}
-- =====================================================================
create table app.jurisdictions (
  code             text primary key,
  country_code     char(2) not null,
  name             text not null,
  default_currency char(3) not null references app.currencies(code),
  default_locale   text not null,
  languages        text[] not null default '{}',
  timezone         text not null,
  measurement      text not null default 'metric' check (measurement in ('metric','imperial')),
  rules            jsonb not null default '{}'::jsonb,
  legal_pack_version text,
  active           boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger trg_jurisdictions_touch before update on app.jurisdictions
  for each row execute function app.touch_updated_at();

create table app.fx_rates (
  base   char(3) not null references app.currencies(code),
  quote  char(3) not null references app.currencies(code),
  rate   numeric(18,8) not null check (rate > 0),
  as_of  date not null,
  source text not null,
  primary key (base, quote, as_of)
);

-- =====================================================================
-- USERS, CONSENT, AUDIT
-- =====================================================================
create table app.users (
  id              uuid primary key default gen_random_uuid(),
  email           citext unique,
  external_auth_id text unique,
  display_name    text,
  role            text not null default 'user' check (role in ('user','owner','moderator','admin')),
  locale          text not null default 'en',
  jurisdiction_code text references app.jurisdictions(code),
  telegram_chat_id bigint unique,
  verified_level  smallint not null default 0 check (verified_level between 0 and 3),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create trigger trg_users_touch before update on app.users
  for each row execute function app.touch_updated_at();

create table app.consents (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references app.users(id) on delete cascade,
  purpose        text not null check (purpose in
                   ('terms','privacy','cloud_llm_processing','media_processing','marketing')),
  granted        boolean not null,
  policy_version text not null,
  granted_at     timestamptz not null default now(),
  source         text not null default 'web'
);
create index on app.consents (user_id, purpose, granted_at desc);

create table app.audit_log (
  id         bigint generated always as identity primary key,
  actor_id   uuid,
  action     text not null,
  entity     text not null,
  entity_id  text,
  detail     jsonb not null default '{}'::jsonb,
  at         timestamptz not null default now()
);
create index on app.audit_log (entity, entity_id);
create index on app.audit_log (at desc);

-- =====================================================================
-- SEEKER PROFILES (only user-declared attributes; never inferred)
-- =====================================================================
create table app.profiles (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null unique references app.users(id) on delete cascade,
  jurisdiction_code text references app.jurisdictions(code),
  budget_min_minor bigint check (budget_min_minor >= 0),
  budget_max_minor bigint check (budget_max_minor >= 0),
  currency       char(3) references app.currencies(code),
  anchor_point   geography(Point,4326),           -- campus, workplace, city centre
  anchor_label   text,
  max_commute_min smallint,
  search_area    geography(Point,4326),
  search_radius_m integer,
  move_in_from   date,
  move_in_to     date,
  min_stay_months smallint,
  declared_preferences jsonb not null default '{}'::jsonb,  -- e.g. {"smoking":"no","pets":"ok"}
  languages      text[] not null default '{}',
  raw_text       text,                             -- masked original request
  profile_version integer not null default 1,
  embedding      vector(1024),
  embedding_model text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (budget_max_minor is null or budget_min_minor is null or budget_max_minor >= budget_min_minor)
);
create trigger trg_profiles_touch before update on app.profiles
  for each row execute function app.touch_updated_at();

-- =====================================================================
-- LISTINGS
-- =====================================================================
create table app.listings (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid references app.users(id) on delete set null,
  jurisdiction_code text not null references app.jurisdictions(code),
  kind           text not null default 'room' check (kind in ('room','shared_flat','roommate_wanted')),
  source         text not null default 'user' check (source in ('user','partner','seed','synthetic')),
  is_synthetic   boolean not null default false,
  status         text not null default 'draft' check (status in
                   ('draft','processing','pending_review','published','rejected','archived')),
  title          text,
  description    text,
  description_lang text,
  rent_minor     bigint check (rent_minor >= 0),
  currency       char(3) references app.currencies(code),
  deposit_minor  bigint check (deposit_minor >= 0),
  bills_included boolean,
  available_from date,
  min_stay_months smallint,
  bedrooms       smallint,
  bathrooms      smallint,
  total_area_m2  numeric(7,2),
  room_area_m2   numeric(7,2),
  furnished      boolean,
  current_flatmates smallint,
  amenities      text[] not null default '{}',
  house_rules    jsonb not null default '{}'::jsonb,       -- declared by the owner
  location       geography(Point,4326),                    -- exact, never exposed publicly
  public_location geography(Point,4326),                   -- fuzzed for display
  country_code   char(2),
  admin_area     text,
  city           text,
  neighbourhood  text,
  extraction     jsonb not null default '{}'::jsonb,       -- raw extractor output + confidence
  trust_score    smallint check (trust_score between 0 and 100),
  trust_verdict  text check (trust_verdict in ('ok','review','block')),
  embedding      vector(1024),
  embedding_model text,
  tsv            tsvector generated always as (
                   to_tsvector('simple',
                     coalesce(title,'') || ' ' || coalesce(description,'') || ' ' ||
                     coalesce(city,'') || ' ' || coalesce(neighbourhood,''))) stored,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  published_at   timestamptz,
  check (rent_minor is null or currency is not null)
);
create trigger trg_listings_touch before update on app.listings
  for each row execute function app.touch_updated_at();
create index listings_status_j_idx  on app.listings (jurisdiction_code, status);
create index listings_public_geo    on app.listings using gist (public_location);
create index listings_geo           on app.listings using gist (location);
create index listings_tsv           on app.listings using gin (tsv);
create index listings_amenities     on app.listings using gin (amenities);
create index listings_embedding     on app.listings using hnsw (embedding vector_cosine_ops);

create table app.listing_media (
  id          uuid primary key default gen_random_uuid(),
  listing_id  uuid not null references app.listings(id) on delete cascade,
  kind        text not null check (kind in
                ('photo','video','audio','panorama','floorplan','splat','pdf','proof_code_photo')),
  storage_key text not null,
  mime        text not null,
  bytes       bigint not null check (bytes >= 0),
  sha256      text not null,
  phash       bit(64),                        -- perceptual hash for duplicate detection
  width       integer,
  height      integer,
  duration_s  numeric(8,2),
  analysis    jsonb not null default '{}'::jsonb,   -- vision / ASR output
  transcript  text,
  transcript_lang text,
  moderation  text not null default 'pending' check (moderation in ('pending','ok','blurred','rejected')),
  created_at  timestamptz not null default now(),
  unique (listing_id, sha256)
);
create index listing_media_phash on app.listing_media (phash) where phash is not null;
create index listing_media_listing on app.listing_media (listing_id, kind);

create table app.trust_reports (
  id          uuid primary key default gen_random_uuid(),
  listing_id  uuid not null references app.listings(id) on delete cascade,
  score       smallint not null check (score between 0 and 100),   -- higher = safer
  verdict     text not null check (verdict in ('ok','review','block')),
  signals     jsonb not null,                 -- [{"signal":"price_anomaly","weight":-25,"evidence":"..."}]
  explanation text,
  prompt_version_id uuid,
  model       text,
  created_at  timestamptz not null default now()
);
create index on app.trust_reports (listing_id, created_at desc);

create table app.moderation_queue (
  id          bigint generated always as identity primary key,
  entity_type text not null check (entity_type in ('listing','media','message','user','report')),
  entity_id   uuid not null,
  reason      text not null,
  priority    smallint not null default 5,
  status      text not null default 'open' check (status in ('open','in_review','approved','rejected')),
  assigned_to uuid references app.users(id),
  decision_note text,
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);
create index on app.moderation_queue (status, priority, created_at);

create table app.reports (
  id          bigint generated always as identity primary key,
  reporter_id uuid references app.users(id) on delete set null,
  listing_id  uuid references app.listings(id) on delete cascade,
  reason      text not null,
  detail      text,
  created_at  timestamptz not null default now()
);

-- =====================================================================
-- CONVERSATIONS (assistant sessions and, later, peer messaging)
-- =====================================================================
create table app.threads (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('assistant','peer')),
  owner_id    uuid not null references app.users(id) on delete cascade,
  listing_id  uuid references app.listings(id) on delete set null,
  channel     text not null default 'api' check (channel in ('api','web','telegram','whatsapp','test')),
  created_at  timestamptz not null default now()
);
create table app.messages (
  id          bigint generated always as identity primary key,
  thread_id   uuid not null references app.threads(id) on delete cascade,
  sender      text not null check (sender in ('user','assistant','system','peer')),
  sender_user_id uuid references app.users(id) on delete set null,
  content     text,
  content_masked text,                         -- PII-masked copy that may go to cloud LLMs
  media_ids   uuid[] not null default '{}',
  created_at  timestamptz not null default now()
);
create index on app.messages (thread_id, created_at);

create table app.matches (
  id          bigint generated always as identity primary key,
  profile_id  uuid not null references app.profiles(id) on delete cascade,
  listing_id  uuid not null references app.listings(id) on delete cascade,
  score       numeric(6,4) not null,
  reasons     jsonb not null default '[]'::jsonb,
  retrieval_debug jsonb,
  created_at  timestamptz not null default now(),
  unique (profile_id, listing_id)
);

create table app.generated_documents (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references app.users(id) on delete cascade,
  jurisdiction_code text references app.jurisdictions(code),
  kind        text not null check (kind in ('roommate_agreement','inventory_checklist','other')),
  language    text not null,
  storage_key text not null,
  inputs      jsonb not null,
  legal_notice_version text,
  created_at  timestamptz not null default now()
);

-- Asynchronous jobs (transcription, photo analysis, 3D reconstruction ...)
create table app.jobs (
  id              uuid primary key default gen_random_uuid(),
  type            text not null,
  status          text not null default 'queued' check (status in
                    ('queued','running','succeeded','failed','cancelled')),
  input           jsonb not null default '{}'::jsonb,
  output          jsonb,
  error           text,
  attempts        smallint not null default 0,
  max_attempts    smallint not null default 3,
  idempotency_key text unique,
  requested_by    uuid references app.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz
);
create index on app.jobs (status, created_at);

-- =====================================================================
-- KNOWLEDGE BASE (RAG): sources -> documents -> chunks -> embeddings
-- chunks and embeddings are separate so chunkers and embedding models
-- can be compared on the same corpus.
-- =====================================================================
create table kb.sources (
  id             uuid primary key default gen_random_uuid(),
  jurisdiction_code text references app.jurisdictions(code),    -- null = global
  title          text not null,
  url            text,
  publisher      text,
  source_type    text not null check (source_type in
                   ('primary_law','regulator','government_guide','ngo','commercial_guide','blog','internal')),
  reliability    smallint not null check (reliability between 1 and 5),
  language       text not null,
  published_at   date,
  retrieved_at   timestamptz not null default now(),
  license        text,
  status         text not null default 'active' check (status in ('active','stale','removed')),
  notes          text
);
create index on kb.sources (jurisdiction_code, source_type);

create table kb.documents (
  id           uuid primary key default gen_random_uuid(),
  source_id    uuid not null references kb.sources(id) on delete cascade,
  version      integer not null default 1,
  content      text not null,
  content_hash text not null,
  created_at   timestamptz not null default now(),
  unique (source_id, version)
);

create table kb.chunks (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references kb.documents(id) on delete cascade,
  strategy      text not null,                 -- 'fixed_500_50', 'structure_aware_v1', ...
  chunk_index   integer not null,
  content       text not null,
  heading_path  text[] not null default '{}',
  article_ref   text,                          -- e.g. 'COC art. 727', 'section 21'
  token_count   integer,
  metadata      jsonb not null default '{}'::jsonb,
  tsv           tsvector generated always as (to_tsvector('simple', content)) stored,
  unique (document_id, strategy, chunk_index)
);
create index chunks_tsv on kb.chunks using gin (tsv);
create index chunks_strategy on kb.chunks (strategy);

create table kb.chunk_embeddings (
  chunk_id   uuid not null references kb.chunks(id) on delete cascade,
  model      text not null,                    -- 'bge-m3', 'multilingual-e5-large'
  embedding  vector(1024) not null,
  created_at timestamptz not null default now(),
  primary key (chunk_id, model)
);
-- one partial HNSW index per embedding model
create index emb_bge_m3  on kb.chunk_embeddings using hnsw (embedding vector_cosine_ops)
  where model = 'bge-m3';
create index emb_e5_l    on kb.chunk_embeddings using hnsw (embedding vector_cosine_ops)
  where model = 'multilingual-e5-large';

-- =====================================================================
-- AI: prompt registry, executions, agent traces
-- =====================================================================
create table ai.prompts (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,            -- 'P1_router', 'P5_legal_answerer'
  agent       text not null,
  role        text not null,                   -- role in the system (exam requirement)
  created_at  timestamptz not null default now()
);
create table ai.prompt_versions (
  id          uuid primary key default gen_random_uuid(),
  prompt_id   uuid not null references ai.prompts(id) on delete cascade,
  version     integer not null,
  techniques  text[] not null default '{}',    -- few_shot, cot, structured_output, role, guardrails
  template    text not null,
  output_schema jsonb,
  model       text,
  params      jsonb not null default '{}'::jsonb,
  status      text not null default 'draft' check (status in ('draft','active','retired')),
  changelog   text,
  created_at  timestamptz not null default now(),
  unique (prompt_id, version)
);
create unique index one_active_version on ai.prompt_versions (prompt_id) where status = 'active';

create table ai.prompt_failures (
  id                  bigint generated always as identity primary key,
  prompt_version_id   uuid not null references ai.prompt_versions(id) on delete cascade,
  category            text not null,           -- hallucination, wrong_unit, wrong_language, format ...
  input               text not null,
  observed_output     text not null,
  expected_output     text,
  fixed_in_version_id uuid references ai.prompt_versions(id),
  created_at          timestamptz not null default now()
);

create table ai.models (
  name            text primary key,            -- 'qwen3:8b', 'gpt-...', 'claude-...'
  provider        text not null,
  is_local        boolean not null,
  region          text,
  usd_per_mtok_in  numeric(10,4),
  usd_per_mtok_out numeric(10,4)
);

create table ai.executions (
  id             uuid primary key default gen_random_uuid(),
  request_id     uuid not null,
  workflow       text not null,
  n8n_execution_id text,
  user_id        uuid references app.users(id) on delete set null,
  channel        text,
  status         text not null default 'running' check (status in ('running','succeeded','failed')),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  latency_ms     integer,
  tokens_in      integer not null default 0,
  tokens_out     integer not null default 0,
  cost_usd       numeric(12,6) not null default 0,
  error          text
);
create index on ai.executions (request_id);
create index on ai.executions (started_at desc);

create table ai.agent_steps (
  id             bigint generated always as identity primary key,
  execution_id   uuid not null references ai.executions(id) on delete cascade,
  step_index     integer not null,
  agent          text not null,
  prompt_version_id uuid references ai.prompt_versions(id),
  model          text,
  input          jsonb,
  output         jsonb,
  tool_calls     jsonb not null default '[]'::jsonb,
  latency_ms     integer,
  tokens_in      integer not null default 0,
  tokens_out     integer not null default 0,
  cost_usd       numeric(12,6) not null default 0,
  error          text,
  unique (execution_id, step_index)
);

-- =====================================================================
-- EVAL
-- =====================================================================
create table eval.datasets (
  id       uuid primary key default gen_random_uuid(),
  name     text not null,
  kind     text not null check (kind in ('retrieval','asr','trust','extraction','legal_qa','matching')),
  version  integer not null default 1,
  notes    text,
  unique (name, version)
);
create table eval.queries (
  id            uuid primary key default gen_random_uuid(),
  dataset_id    uuid not null references eval.datasets(id) on delete cascade,
  jurisdiction_code text,
  language      text,
  query         text not null,
  gold          jsonb not null,                -- gold chunk ids / expected answer / reference transcript
  tags          text[] not null default '{}'   -- 'arabizi','code_switch','contradiction','abstain'
);
create table eval.runs (
  id          uuid primary key default gen_random_uuid(),
  dataset_id  uuid not null references eval.datasets(id),
  config      jsonb not null,                  -- {"strategy":"fixed_500_50","model":"bge-m3","k":5,"rerank":false}
  git_sha     text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);
create table eval.results (
  run_id      uuid not null references eval.runs(id) on delete cascade,
  query_id    uuid not null references eval.queries(id) on delete cascade,
  retrieved   jsonb not null,
  metrics     jsonb not null,
  primary key (run_id, query_id)
);

-- =====================================================================
-- SEARCH FUNCTIONS (hybrid: dense + lexical, fused with RRF)
-- =====================================================================

-- Turn free text into an OR tsquery safely (plainto_tsquery sanitises the text)
create or replace function app.or_tsquery(q text) returns tsquery
language sql immutable as $$
  select replace(plainto_tsquery('simple', coalesce(q,''))::text, '&', '|')::tsquery
$$;

create or replace function app.search_listings(
  q_embedding  vector(1024),
  q_text       text,
  p_jurisdiction text,
  p_max_rent_minor bigint default null,
  p_currency   char(3) default null,
  p_center     geography default null,
  p_radius_m   integer default null,
  p_limit      integer default 20
) returns table (
  listing_id uuid, score double precision, dense_rank integer, lexical_rank integer,
  distance_m double precision
) language sql stable as $$
  with filt as (
    select l.id, l.embedding, l.tsv,
           case when p_center is not null then st_distance(l.public_location, p_center) end as dist
    from app.listings l
    where l.status = 'published'
      and l.jurisdiction_code = p_jurisdiction
      and (p_max_rent_minor is null or (l.rent_minor <= p_max_rent_minor and l.currency = p_currency))
      and (p_center is null or p_radius_m is null or st_dwithin(l.public_location, p_center, p_radius_m))
  ),
  dense as (
    select id, (row_number() over (order by embedding <=> q_embedding))::int as r
    from filt where embedding is not null and q_embedding is not null
    order by embedding <=> q_embedding limit 100
  ),
  lex as (
    select id, (row_number() over (order by ts_rank_cd(tsv, app.or_tsquery(q_text)) desc))::int as r
    from filt where tsv @@ app.or_tsquery(q_text)
    order by ts_rank_cd(tsv, app.or_tsquery(q_text)) desc limit 100
  )
  select coalesce(d.id, x.id) as listing_id,
         (coalesce(1.0/(60 + d.r), 0) + coalesce(1.0/(60 + x.r), 0))::double precision as score,
         d.r, x.r,
         (select f.dist from filt f where f.id = coalesce(d.id, x.id))
  from dense d full join lex x on d.id = x.id
  order by 2 desc
  limit p_limit
$$;

create or replace function kb.search_chunks(
  p_model      text,
  p_strategy   text,
  q_embedding  vector(1024),
  q_text       text,
  p_jurisdiction text default null,
  p_min_reliability smallint default 1,
  p_k          integer default 5
) returns table (
  chunk_id uuid, score double precision, dense_rank integer, lexical_rank integer,
  source_id uuid, source_type text, reliability smallint, article_ref text
) language sql stable as $$
  with filt as (
    select c.id as cid, e.embedding, c.tsv, s.id as sid, s.source_type, s.reliability, c.article_ref
    from kb.chunks c
    join kb.chunk_embeddings e on e.chunk_id = c.id and e.model = p_model
    join kb.documents d on d.id = c.document_id
    join kb.sources s on s.id = d.source_id and s.status = 'active'
    where c.strategy = p_strategy
      and s.reliability >= p_min_reliability
      and (s.jurisdiction_code is null or s.jurisdiction_code = p_jurisdiction)
  ),
  dense as (
    select cid, (row_number() over (order by embedding <=> q_embedding))::int as r
    from filt order by embedding <=> q_embedding limit 50
  ),
  lex as (
    select cid, (row_number() over (order by ts_rank_cd(tsv, app.or_tsquery(q_text)) desc))::int as r
    from filt where tsv @@ app.or_tsquery(q_text)
    order by ts_rank_cd(tsv, app.or_tsquery(q_text)) desc limit 50
  ),
  fused as (
    select coalesce(d.cid, x.cid) as cid,
           (coalesce(1.0/(60 + d.r), 0) + coalesce(1.0/(60 + x.r), 0))::double precision as score,
           d.r as dr, x.r as xr
    from dense d full join lex x on d.cid = x.cid
  )
  select f.cid, f.score, f.dr, f.xr, fl.sid, fl.source_type, fl.reliability, fl.article_ref
  from fused f join filt fl on fl.cid = f.cid
  order by f.score desc
  limit p_k
$$;

-- Near-duplicate photo lookup (Hamming distance on 64-bit perceptual hash)
create or replace function app.find_similar_media(p_phash bit(64), p_max_distance int default 6,
                                                  p_exclude_listing uuid default null)
returns table (media_id uuid, listing_id uuid, distance int)
language sql stable as $$
  select m.id, m.listing_id, bit_count(m.phash # p_phash)::int as distance
  from app.listing_media m
  where m.phash is not null
    and (p_exclude_listing is null or m.listing_id <> p_exclude_listing)
    and bit_count(m.phash # p_phash) <= p_max_distance
  order by distance
$$;

-- Right to erasure: remove personal data, keep referential integrity
create or replace function app.erase_user(p_user uuid) returns void
language plpgsql as $$
begin
  update app.messages set content = null, content_masked = null, sender_user_id = null
    where sender_user_id = p_user
       or thread_id in (select id from app.threads where owner_id = p_user);
  delete from app.profiles where user_id = p_user;
  insert into app.jobs(type, input, idempotency_key)
    select 'delete_media', jsonb_build_object('listing_id', l.id), 'erase-media-' || l.id
    from app.listings l where l.owner_id = p_user
    on conflict (idempotency_key) do nothing;
  delete from app.listing_media where listing_id in (select id from app.listings where owner_id = p_user);
  update app.listings set status = 'archived', owner_id = null, location = null,
         public_location = null, description = null, title = null where owner_id = p_user;
  update app.users set email = null, external_auth_id = null, display_name = null,
         telegram_chat_id = null, deleted_at = now() where id = p_user;
  insert into app.audit_log(actor_id, action, entity, entity_id)
    values (p_user, 'erase_user', 'user', p_user::text);
end $$;

-- =====================================================================
-- ROLES AND ROW LEVEL SECURITY
-- n8n_worker: service role used by n8n (bypasses RLS, least-privilege grants)
-- api_user:   role the future website API uses; RLS applies
-- =====================================================================
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'n8n_worker') then
    create role n8n_worker login bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'api_user') then
    create role api_user login;
  end if;
end $$;

grant usage on schema app, kb, ai, eval to n8n_worker, api_user;
grant select, insert, update, delete on all tables in schema app, kb, ai, eval to n8n_worker;
grant usage, select on all sequences in schema app, kb, ai, eval to n8n_worker;
grant execute on all functions in schema app, kb, ai to n8n_worker, api_user;
revoke execute on function app.erase_user(uuid) from public, api_user;
grant  execute on function app.erase_user(uuid) to n8n_worker;

grant select on app.jurisdictions, app.listing_media to api_user;
-- Column-level grant: the exact address (location), raw extraction output and
-- embedding model name are NOT readable through the user-facing role.
-- trust_reports (fraud signals) are not exposed either; only trust_score/verdict are.
grant select (id, owner_id, jurisdiction_code, kind, source, is_synthetic, status, title,
  description, description_lang, rent_minor, currency, deposit_minor, bills_included,
  available_from, min_stay_months, bedrooms, bathrooms, total_area_m2, room_area_m2,
  furnished, current_flatmates, amenities, house_rules, public_location, country_code,
  admin_area, city, neighbourhood, trust_score, trust_verdict, embedding, tsv,
  created_at, updated_at, published_at)
  on app.listings to api_user;
grant select, insert, update, delete on app.profiles, app.threads, app.messages, app.consents to api_user;
grant usage, select on all sequences in schema app to api_user;

alter table app.profiles enable row level security;
alter table app.threads  enable row level security;
alter table app.messages enable row level security;

create policy profiles_owner on app.profiles
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy threads_owner on app.threads
  using (owner_id = app.current_user_id()) with check (owner_id = app.current_user_id());
create policy messages_owner on app.messages
  using (thread_id in (select id from app.threads where owner_id = app.current_user_id()))
  with check (thread_id in (select id from app.threads where owner_id = app.current_user_id()));

-- Public listings visible to api_user; drafts only to their owner
alter table app.listings enable row level security;
create policy listings_public on app.listings for select
  using (status = 'published' or owner_id = app.current_user_id());
create policy listings_owner_write on app.listings for all
  using (owner_id = app.current_user_id()) with check (owner_id = app.current_user_id());
grant insert, update, delete on app.listings to api_user;

alter table app.listing_media enable row level security;
create policy media_follows_listing on app.listing_media for select
  using (listing_id in (select id from app.listings));
