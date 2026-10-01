# Decisions

Each entry: what was decided, why, and what it changes relative to FLATSHARE_BACKEND_SPEC.md.
"Spec defect" marks a mistake or weak decision in the specification that this project corrects.
Newest phase last. Dates are 2026-09-29 unless stated.

## Owner decisions (given in the kickoff message, recorded here)

- **D-001 Solo submission.** Assumed accepted; the owner is confirming with the instructor. Nothing blocks on it.
- **D-002 Models and budget.** Local models first, no cloud budget. A cloud fallback is added only if the owner provides an API key. `CLOUD_LLM_API_KEY` stays empty.
- **D-003 Scope of languages and jurisdictions.** French, English, Arabic including Tunisian dialect and transliterated Arabic. Jurisdictions TN, FR, GB, in that order.
- **D-004 No public launch.** Academic demo. Consent, masking, retention and erasure are still built properly.

## Phase 0 and 1

### D-005 Where things are built and tested

The owner's PC is Windows with Docker Desktop. The Linux shell that should run on it failed to start in this session, and Windows only allowed click-only access to terminals, so I could not run commands there (docs/FAILURES.md F-001). Development and testing happen in a cloud sandbox (Ubuntu 24.04, 2 vCPU, 7.8 GB RAM, no GPU) where Docker Hub, GHCR, Quay, Hugging Face and ollama.com are blocked (F-002). Consequences:

- The sandbox runs a native stack: PostgreSQL 16.13 with pgvector 0.6.0 and PostGIS 3.4.2 (Ubuntu packages), n8n 2.41.3 from npm on Node 24.21.0, Caddy 2.6.2 (Ubuntu package).
- Ollama and object storage cannot be installed there. Two small HTTP stand-ins (`tests/mocks/deps_mock.py`) answer the two health endpoints so the health workflow's logic can be tested. Every result that used them is labelled "mock" in TEST_REPORT.md. They prove nothing about the real services.
- The Docker Compose stack is the deliverable. It is verified on the owner's machine by `scripts/windows/verify.ps1`, which records every command and output in `reports/verify-<timestamp>/`. Until that log exists, compose-level results are "not run".

### D-006 PostgreSQL 18 in the compose stack (spec said 16)

n8n 2.41.3 prints on start with PostgreSQL 16: "Postgres 16 is outside the supported range and receives compatibility support only. Upgrade to Postgres 17 or newer." (observed in the sandbox: reports/phase1/n8n_startup_warnings.log). n8n and the application share one PostgreSQL server, so the server has to be 17 or newer. First choice was 17 (supported until 2029-11-08, postgresql.org/support/versioning). It failed twice on the owner's PC: there is no Debian `postgis/postgis:17-3.6` tag (F-016), and `17-3.5` is built on Debian 11 "bullseye", whose packages are no longer on the Debian mirrors, so installing anything in it fails (F-017; its Dockerfile starts `FROM docker.io/postgres:17-bullseye`). `postgis/postgis:18-3.6` is built on `postgres:18-trixie` (Debian 13, supported) and the PGDG repository has `postgresql-18-pgvector` and `postgresql-18-pgtap` (pgtap 1.3.4-1.pgdg13+1 seen in the repository listing, 2026-09-29). Chosen: PostgreSQL 18 with PostGIS 3.6, pgvector and pgTAP from PGDG packages, so no compiler is downloaded (the owner's connection to deb.debian.org timed out during the F-017 build). PostgreSQL 18 is supported until 2030-11-14. Changes that matter here: the data volume is mounted at `/var/lib/postgresql` (the 18 images keep PGDATA in `/var/lib/postgresql/18/docker`); generated columns default to VIRTUAL in 18, but every generated column in the schema says STORED explicitly. The SQL is unchanged; the pgTAP suite has run on 16.13 (sandbox) and runs on 18 through verify.ps1.

### D-007 Numbered migrations with dbmate; baseline kept byte-for-byte

`db/migrations/0001_baseline_schema.sql` is `schema.sql` unchanged (sha256 `2808aeeb…c29c4`, copy in `db/baseline/`). Every change is a later file. dbmate 2.36.0 was chosen because it runs plain SQL files, records applied versions in `public.schema_migrations`, and is a single static binary (upstream Makefile links Linux builds with `-static`), so it runs in the Debian PostgreSQL image and in the sandbox. Migrations 0002 to 0006 were edited in place during this phase before any deployment existed; from the first compose run on the owner's machine on, applied migrations are frozen.

### D-008 Signature covers the whole request (spec defect)

The spec signs `timestamp + "." + raw_body` only. `X-User-Id`, the method and the path are not signed, so anyone who captures one signed request can, within the 5-minute window, send the same body with another `X-User-Id` (act as another user) or to another route. The canonical string now is:

```
FS1-HMAC-SHA256\n<X-Timestamp>\n<METHOD>\n<path>\n<canonical query>\n<X-Request-Id>\n<X-User-Id>\n<X-Idempotency-Key>\n<X-Client-Ip>\n<hex sha256(raw body)>
```

Each `X-Request-Id` is accepted once per key (table `sec.request_nonces`, kept 11 minutes, longer than the ±5 minute window). The spec only rejected a repeated idempotency key with another body, which left signed GET requests replayable. Full definition and test vectors: docs/API_SIGNING.md, tests/vectors/signing.json. Contract tests `test_swapped_user_id_rejected`, `test_signature_for_other_route_rejected`, `test_replayed_request_rejected` cover it.

### D-009 Client keys live in the database, HMAC is computed there (spec: `WEBHOOK_HMAC_SECRET` env var)

Measured in n8n 2.41.3 (spike, TEST_REPORT T-9): `$env` access in Code nodes is denied ("access to env vars denied") and `require('crypto')` is disallowed. So a Code node can neither read an env secret nor compute an HMAC. Alternatives considered: re-enabling env access (exposes every env var of the n8n process, including database passwords, to every workflow); the Crypto node (the secret would sit in workflow parameters and in exported JSON). Chosen: `sec.api_clients` holds one secret per calling server; `sec.verify_request` (SECURITY DEFINER, owned by the no-login role `sec_owner`) computes the HMAC with pgcrypto and compares with a double-HMAC so timing reveals nothing. `n8n_worker` may call it but cannot read the table (pgTAP test "n8n_worker cannot read client secrets"). The secret never passes through n8n, so it never lands in n8n execution data. Side benefits: one key per client (`website`, `tests`), rotation and revocation without restarts. Contract change: new required header `X-Key-Id`.

### D-010 to D-014: security defects in the tested baseline schema (spec defects)

Found by review, proven by running `db/tests/020_security_fixes.sql` against migrations 0001+0002 only (18 of 25 assertions fail, then the file aborts because the forbidden hard delete succeeded: reports/phase1/defect_proof_020_without_0003.log). Fixed in migration 0003; all 33 assertions pass after it.

- **D-010** `app.consents` had table grants for `api_user` but no row level security: any end user could read and rewrite every user's consent history. Now: RLS, own rows only, insert and read only (append-only log).
- **D-011** `api_user` could insert or update every column of its own listing, including `status = 'published'`, `trust_score = 100`, `trust_verdict = 'ok'`, `is_synthetic`, `source`: publishing without the trust check or moderation. Now: column-level insert/update grants on owner-editable fields only, no direct delete (deletion must queue media deletion).
- **D-012** `api_user` could write messages with `sender = 'assistant'` or as another user in its own threads, and edit history. Now: insert only as `sender = 'user'` with its own id; no update or delete.
- **D-013** Every new function is executable by PUBLIC by default, and the baseline granted all app/kb/ai functions to `api_user`. Now: PUBLIC has execute on no function in app/kb/ai/eval/sec (a pgTAP test enforces this for future migrations too), and `api_user` can execute exactly `current_user_id`, `or_tsquery`, `search_listings`. Default privileges give `n8n_worker` access to future tables.
- **D-014** `app.erase_user` deleted the `listing_media` rows but the `delete_media` jobs it queued carried only the listing id, so the storage keys of the objects to delete were lost (proof: reports/phase1/defect_proof_d014_erase_on_baseline.log shows `{"listing_id": ...}` only). It also kept generated documents (PDF keys and their `inputs`), the text of reports the user wrote, job inputs, and execution links. Now all of these are removed or queued for deletion with their keys.

### D-015 Assertion-based database tests (pgTAP)

`schema_tests.sql` prints results that a person has to read. It was ported 1:1 to pgTAP (`db/tests/010_baseline_behaviour.sql`, 51 assertions with the expected values stated) so a wrong result fails the run. pgTAP 1.3.2 in the sandbox; the compose image installs the PGDG package.

### D-016 Rate limits in PostgreSQL, not Redis (spec: Redis counters)

Measured: with Redis stopped, a request to a workflow using the n8n Redis node did not answer within 60 s, even with the node's error output enabled (reports/phase1/redis_node_outage_spike.log). The node's client retries a lost connection 10 times with exponential backoff (read in `n8n-nodes-base/dist/nodes/Redis/utils.js`). A cache outage would hang every API request. PostgreSQL is already on the request path, so the counters (`app.rate_counters`, unlogged, fixed one-minute windows) are updated in the same call that verifies the signature: one database round trip for signature, user context and both counters (`app.gateway_check`). Which IP is counted: the signed `X-Client-Ip` only when the signature is valid, otherwise the address the proxy saw, because an unsigned header could be set to anything to escape the limit (pgTAP test "spoofed X-Client-Ip bucket untouched").

### D-017 Redis only in the `queue` profile

Nothing on the request path uses Redis in this phase. It stays in `docker-compose.yml` under the `queue` profile for n8n queue mode in the load tests (phase 9). A running but unused service adds surface without value.

### D-018 Garage instead of MinIO for object storage (spec: MinIO)

MinIO stopped publishing community Docker images from October 2025 and the community repository was archived on 2026-02-13 (github.com/milvus-io/milvus/issues/53430, fetched 2026-09-29); the last published images carry a known high-severity CVE (minimus.io article, fetched 2026-09-29). Garage v2.4.1 (released 2026-09-08, garagehq.deuxfleurs.fr/_releases.html) implements presigned URLs, bucket CORS, DeleteObjects and lifecycle expiration (partially: expiration and multipart abort only) per its S3 compatibility page (fetched 2026-09-29). These cover the upload flow and retention needs. Since v2.3.0 `server --single-node --default-bucket` creates the layout, bucket and key from environment variables, so no init script is needed. Garage's licence is not yet recorded in the component register: to do before any distribution.

### D-019 Reverse proxy rules

Caddy exposes `/v1/*` only and rewrites it to n8n's production webhooks (`/webhook/v1/*`). n8n answers some failures itself before any workflow runs (unknown route, unparsable JSON body, its own database down, an unexpected workflow error). Those answers do not follow the envelope and, without `NODE_ENV=production`, contain stack traces (observed). The proxy recognises them by the missing `X-Request-Id` header and replaces them with the envelope. Body limit 1 MiB, refused up front from `Content-Length` with a new error code `PAYLOAD_TOO_LARGE` (413) added to the contract. The n8n editor, REST API and test webhooks are not reachable through the proxy (test `test_n8n_internals_not_reachable_through_proxy`).

### D-020 n8n editor on 127.0.0.1:5678 (spec: only the proxy publishes ports)

The owner needs the editor to read workflows and executions. It is published on the loopback interface only, not through the proxy.

### D-021 n8n task runners in external mode

n8n 2.41.3 logs that internal task-runner mode is deprecated (reports/phase1/n8n_startup_warnings.log). The compose stack runs `n8nio/runners:2.41.3` next to n8n (versions must match). Not tested in the sandbox, which uses internal mode; every Code node in the contract suite depends on it, so a broken runner setup fails the compose run visibly.

### D-022 n8n execution data retention

Successful executions are not saved (`saveDataSuccessExecution: none`). Failed executions are saved for 7 days (`EXECUTIONS_DATA_MAX_AGE=168`) because they are needed to debug; they can contain request bodies, which is personal data. `ai.executions` keeps codes, reasons and redacted details only: PostgreSQL error details that echo values (for example an email in a unique violation) are redacted before logging, and a check over the whole sandbox run found no `@` in any logged error.

### D-023 Workflows generated from code

`n8n/build.py` writes the workflow JSON; Code-node JavaScript lives in `n8n/src` and shared pure helpers in `n8n/src/lib` are unit-tested with Node's test runner and inlined at build time. `build.py --check` fails if the committed JSON is stale. Edits made in the n8n editor must be ported back to the source (RUNBOOK). Reason: the same canonicalisation code is then tested outside n8n, reviewed in git, and identical in every workflow.

### D-024 Route parameters need a proxy rewrite (spec: verify how n8n handles them)

In n8n 2.41.3 a webhook path with a parameter (`listings/:id/analyze`) is registered under `/webhook/<webhookId>/listings/:id/analyze`. Giving several workflows the same webhookId so the URLs look like `/webhook/v1/...` does not work: only one of three routes answered (F-003). The first parameterised route (phase 3) will get a per-route rewrite in the Caddyfile and a contract test. No parameterised route exists yet.

### D-025 Ollama in a container by default

Hardware (reports/env-check.txt, 2026-09-29): Windows 11 Pro, Intel i7-11800H (8 cores, 16 threads), 23.7 GB RAM of which Docker Desktop gets 12.4 GB, NVIDIA GeForce GTX 1650 Max-Q with 4 GB VRAM (driver 610.88, compute capability 7.5), visible inside Docker. Disk: D: 130.6 GB free, C: 13.9 GB free (Docker Desktop keeps its images on C: by default). Ollama is not installed on Windows. Consequences: bge-m3 is meant to run on the GPU (whether Ollama actually placed it there was not measured in T-13); local LLMs are limited to models that fit in 4 GB VRAM (quantised models of a few billion parameters), larger ones would run on CPU; the choice is benchmarked in phase 3. 3D reconstruction on 4 GB VRAM is doubtful and stays last (phase 10).


The compose stack runs `ollama/ollama:0.34.4`; `docker-compose.gpu.yml` adds the NVIDIA GPU when `docker run --gpus all ... nvidia-smi` works (verify.ps1 checks this and chooses). An Ollama already installed on Windows can be used instead with `OLLAMA_BASE_URL=http://host.docker.internal:11434`. Model choices beyond the embedding model are made in phase 3 with benchmarks on this GPU.

### D-026 Health endpoint

`GET /v1/health` is signed like every route (it reveals versions). Docker health checks use the services' own internal checks. It answers 200 only when the database, object storage and Ollama answer and the embedding model is present; otherwise 503 with the failing check. Per-dependency latency is not measured.

### D-027 Launch jurisdictions seeded inactive

`db/seed/jurisdictions.sql` inserts TN, FR, GB with currency, locale, languages and timezone, `active = false` and empty `rules`. Rules are filled only from primary sources in the pack phases. Whether GB splits into GB-ENG, GB-WLS, GB-SCT, GB-NIR is decided in phase 6 from the legislation texts.

### D-028 Strict request contract

`Content-Type: application/json` is required for bodies, the body must be a JSON object, unknown fields are rejected with `unknown_field` (so a client cannot, for example, send `role`), and nested query parameters (`a[b]=1`) are rejected because they cannot be canonicalised unambiguously.

### D-029 Idempotency semantics

Scope is `<key id>:<user id or anon>`. Same key + same method, route and body hash: the stored response is returned unchanged (including the original `request_id`). Same key with a different route or body: 409 `CONFLICT`. Key still being processed: 409. A key left `in_progress` for more than 300 s (crashed handler) can be taken over. Responses with status 5xx release the key so the client can retry; 2xx and 4xx are stored. Stored responses can hold personal data: rows carry `user_id` for erasure, and the phase 7 retention job will delete rows older than 24 hours.

### D-030 The connected n8n Cloud workspace is not the runtime

The session has access to an n8n Cloud workspace. It is not used to run these workflows: it cannot reach the local database, storage or models, and personal data would leave the owner's machine, which the routing policy (spec 13.3) and the Tunisian transfer rules listed as leads in spec 3.1 argue against. The runtime is the self-hosted n8n in the compose stack.

### D-031 Which environment values the secret scan treats as secrets

A variable is a secret when its name ends in `PASSWORD`, `SECRET`, `SECRET_KEY`, `SECRET_ACCESS_KEY`, `TOKEN`, `API_KEY` or `ENCRYPTION_KEY`. Other variables (database names, bucket name, URLs, ports, model name, key ids) are configuration whose defaults are in the repository on purpose; scanning them made the check fail on every correct setup (FAILURES F-019). Key ids (`FLATSHARE_*_KEY_ID`, `S3_ACCESS_KEY_ID`) travel in request headers and are not secret on their own. To keep a new secret from slipping through under an unusual name, `tests/unit/test_secret_scan.py` requires every variable in `.env.example` to be either secret by name or listed as configuration in the test.

## Phase 2 (knowledge base and retrieval evaluation)

### D-032 TN pack v1: what is in it and what is not

17 TN sources and 3 global ones (`kb/packs/TN/sources.csv`, `kb/packs/GLOBAL/sources.csv`): the Code des obligations et des contrats in French and Arabic from legislation.tn (whole code, lease of things from article 727), the data-protection law 2004-63 in French and Arabic, the INPDP procedures, the 2017 registration-duties code from the Ministry of Finance, a 2014 study published by the housing ministry, the IORT compilation of landlord-tenant texts, and lower-reliability sources chosen because they disagree with each other on registration, fees and sub-letting (spec 10.1: "include a few lower-reliability sources"). The spec targets 25 to 40 documents per pack; v1 has 20 including global ones, and the report records the real counts. Whole documents are ingested, not slices: retrieval has to find the right articles among unrelated ones, as it will in use. The URLs are leads found by web search; whether each one fetches, and what it contains, is only known after the first ingestion on the owner's PC (the cloud sandbox cannot reach these sites, F-002).

### D-033 Raw fetches are stored in PostgreSQL

Every fetch keeps its bytes, sha256, URL, status and content type in `kb.raw_fetches` (bytea), linked from the document version it produced. Object storage (spec 5.1) is meant for user media with presigned uploads (phase 4); for a few tens of public documents a table is simpler, transactional with the document row, and covered by the same backup. Revisit if the corpus grows past a few hundred MB.

### D-034 multilingual-e5-large runs in Text Embeddings Inference on the CPU

Ollama's library has no official build of multilingual-e5-large, and converted community builds would need checking against the reference implementation. Hugging Face's Text Embeddings Inference (TEI) loads the original model at a pinned revision (`3d7cfbd`, read from the Hugging Face API on 2026-10-01), applies the model's own pooling and normalisation, and also exposes the tokenizer (D-035). The CPU image is used: the GTX 1650 has 4 GB, already used by bge-m3, and is needed for local LLMs in phase 3. Only e5 (the comparison model) runs on the CPU; its ingestion time is measured, not assumed. Image `ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.4` (v1.9.4 is the latest release on GitHub; the `cpu-1.9.4-grpc` sibling tag was seen on the package page, the plain tag is checked by verify.ps1). The prefixes "query: " and "passage: " are stored in `ai.models` and applied by the workflows.

### D-035 Token counts come from the XLM-RoBERTa tokenizer served by TEI

Spec 10.3 counts tokens with the embedding model's tokenizer. bge-m3 and multilingual-e5-large are both XLM-RoBERTa models with the same SentencePiece vocabulary, so one tokenizer serves both; this is stated by the model cards, not measured here (verify.ps1 logs a tokenization sample). Documents are cut into pieces of at most 1,000 characters at whitespace before calling `/tokenize`, which keeps requests small and does not change SentencePiece tokens. TEI may return offsets in characters or in UTF-8 bytes; the code detects which on each piece and converts (`kb/lib/tokens.js`, tested both ways). TEI 1.9.4 on the owner's PC returned byte offsets (T-19).

### D-036 Lexical leg: normalised text, simple parser, short stop-word list

`kb.chunks.tsv` is generated from `kb.lex_normalize(content)`: NFKC, Arabic diacritics and tatweel removed, alef variants and alef maqsura unified, Latin accents removed, lower case (spec 10.2 step 3). The original text is kept for display. Queries go through the same parser and normalisation, minus a short French, English and Arabic stop-word list, and are OR-joined. No stemming: French plurals and Arabic clitics (بـ, الـ, و) do not match their base form. That is a known weakness of the lexical leg; dense retrieval covers part of it, and the per-mode results show how much.

### D-037 Source types for news and private sites

`kb.sources.source_type` has no "news" value. News articles are typed `commercial_guide` with reliability 3 for a named outlet, which keeps them below official guidance and above blogs. The spec's appendix C calls diwan.tn a "state portal"; its own about page names a private company (Diwan Services Web SARL), so it is `commercial_guide`, reliability 3. The Imprimerie Officielle compilation of landlord-tenant texts is `primary_law` with reliability 4 because it is hosted by a private company, not by the publisher.

### D-038 Gold spans are quotes, resolved at evaluation time

A gold span is stored as `{source_key, start quote, end quote}` and resolved against the current document version when an evaluation starts (`eval.resolve_gold`). Offsets would silently point at the wrong text after any cleaner change; quotes either still match or fail loudly. An evaluation whose gold cannot be found, or whose start quote appears more than once, fails before computing anything (no partial numbers). Gold is defined on the cleaned text, independently of chunking (spec 10.7).

### D-039 Relevance and metrics

A retrieved chunk is relevant when it overlaps a gold span of the same document by at least half of the shorter of the two (setting `eval.relevance_overlap`). Using the shorter length means a small chunk inside a long gold article counts, and a long chunk that contains a short gold sentence counts. Each gold span is credited once: Recall@k is the share of gold spans reached in the top k; nDCG@10 gives gain 1 to a chunk that reaches a not-yet-credited gold span, with the ideal ranking computed from the number of gold spans. This keeps a chunker that cuts one passage in two from scoring twice. Queries without gold spans (out of scope) are stored and excluded from retrieval metrics; they are for the abstention test of phase 6.

### D-040 What "latency per query" means in the evaluation

Database search time measured inside PostgreSQL (`eval.timed_search`) plus the embedding time per query, where all queries of a run are embedded in batches and the total is divided by the number of queries. No network hop, no reranker, no answer generation. It is a component figure for comparing configurations on the same machine, not the user-facing latency of `/v1/legal/ask`.

### D-041 Admin endpoints and jobs before the general job worker

The spec lists `POST /v1/admin/eval/runs`, `GET /v1/admin/eval/runs/:id` and `GET /v1/jobs/:id`; ingestion has no endpoint in spec 6.3 (only "manual and scheduled"). `POST /v1/admin/kb/ingest` is added so ingestion is triggered, authorised (role admin) and logged like any other call. Both admin calls create an `app.jobs` row, start the worker workflow without waiting, and answer 202. The general job worker, retries and the reaper are phase 4. Until then a worker that fails inside a step marks its job failed ("Job failed" branch, F-025); a crash of n8n itself leaves the job `running`.

### D-042 Retrieval function replaced

`kb.search_chunks` gains a mode (dense, lexical, hybrid), candidate count and RRF constant as parameters, searches only current document versions, uses the normalised lexical column, and returns the dense similarity (for the abstention threshold of phase 6) and the chunk span (for evaluation). The HNSW index is still not used because the filtered set is a CTE (spec observation below); every search is an exact scan, and its time is measured in each run.

### D-043 robots.txt

Each fetch first reads `/robots.txt` of the host with User-Agent `FlatshareKB/0.2`, applies RFC 9309 (most specific group, longest rule, Allow wins a tie), and skips the source when disallowed. A robots.txt answering 4xx means no restriction; 5xx or no answer means do not fetch (RFC 9309 section 2.3.1). Sites' terms of use are not checked automatically; the `license` column records what is known, and texts stay internal (D-044).

### D-044 Fetched texts are not committed

Cleaned texts and raw files are exported to `kb/packs/<CODE>/documents/` for reading and gold-set work, and that folder is git-ignored: most sources are copyrighted guides and news that may be used internally for retrieval but not redistributed (spec 10.1). Reproducibility comes from `sources.csv` (URL), the retrieval time and the content hashes in the report.

### D-045 Test fixtures and a test jurisdiction

Ingestion tests fetch synthetic HTML and PDF files from a `fixtures` service (profile test, Caddy file server, not published) and use jurisdiction `QZ` (ISO user-assigned range) with source keys `test-*`, so the real TN pack in the same database is never touched. The fixture texts say they are synthetic; they are not law.

### D-046 The health endpoint does not check TEI yet

`GET /v1/health` checks what the user-facing API needs. TEI is only used by admin ingestion and evaluation in this phase; verify.ps1 and `scripts/kb.py` check it before use. It joins the health check when a user-facing route depends on it.

### D-047 TN pack v1.1 after the first ingestion

The first complete run on the owner's PC (T-21) skipped four sources at the robots.txt step (`tn-coc-fr`, `tn-coc-ar` on legislation.tn; `tn-lo-2004-63-ar`, `tn-inpdp-procedures` on inpdp.tn) and got a 404 for `tn-web6-droits-locataire`. The job output did not yet say whether robots.txt disallowed the path or could not be reached; it does now (reason, rule and robots.txt status per skipped source). Changes:
- The COC articles on the lease of things (727 to 827) are added from jurisitetunisie.com, nine section pages, typed `primary_law` with reliability 3 (law text reproduced by a private site, copyright on the compilation, internal use only). The official rows stay; if legislation.tn becomes fetchable, it is preferred and the reproductions can be removed.
- The Arabic COC is added from the CAWTAR legal database (NGO), reliability 3; whether that text is the consolidated version is not verified.
- The Arabic law 2004-63 is added from igppp.tn (public body), reliability 5.
- The Ministry of Justice page of civil questions (cites COC 788 and 791) is added as `government_guide`, 4.
- `tn-web6-droits-locataire` is removed (the page answers 404; it is marked `removed`, not deleted).
- Africa-laws.org (another copy of the official COC) was considered and dropped: its robots.txt disallows fetching.

## Spec observations scheduled for later phases

- **Rent period.** `app.listings` has no rent period, but P3's schema and GB practice include weekly rents. Comparing a weekly rent with a monthly budget gives wrong results. Phase 3 adds `rent_period` and a monthly-equivalent column used by `search_listings`.
- **Job scheduling fields.** `app.jobs` has no `next_attempt_at`, lease or timeout column, which the backoff and reaper behaviour in spec 5.6 needs. Added with the job worker (phase 4).
- **HNSW and the materialised CTE.** In `search_listings` the filtered CTE is referenced three times, so PostgreSQL materialises it and the HNSW index cannot be used; every search is an exact scan. Fine for hundreds of listings; measured in phase 3 before changing.
- **Cleanup of gateway tables.** `sec.request_nonces` is trimmed on every accepted request; `app.idempotency_keys` and `app.rate_counters` need the scheduled retention workflow (phase 7).
