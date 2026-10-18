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

Second run (T-23): the robots.txt reasons are now recorded. legislation.tn (`tn-coc-fr`, `tn-coc-ar`) answers its robots.txt with HTTP 503; inpdp.tn (`tn-lo-2004-63-ar`, `tn-inpdp-procedures`) did not answer at all (network error, reported as status 0). RFC 9309 section 2.3.1.4 treats a server error or an unreachable robots.txt as "complete disallow", so these four stay skipped; the job will retry them on every run. The replacements above cover them.

### D-048 Charset when the declaration is wrong

HTML gives the Content-Type header precedence over `<meta charset>`. Two real cases broke that (F-032): a server default `charset=utf-8` over a windows-1256 page, and a UTF-8 page whose template contains a few Latin-1 bytes. Rule, applied only when the chosen charset is UTF-8 and the bytes are not valid UTF-8 (RFC 3629): use another declared charset if there is one; else, if valid multi-byte UTF-8 sequences outnumber the invalid bytes, keep UTF-8 and read each invalid byte as windows-1252; else fail with `decoding_failed`. Detection libraries (chardet and similar) were not used: they guess, and a wrong guess garbles text silently, while every case here has a declaration to check. The chosen charset, its source (header, meta, default), the number of invalid bytes and a note are stored in the document metadata, and a page whose extracted text still has more than 0.1% replacement characters fails.

### D-049 Embedding requests are sent one at a time

The HTTP Request node sends all its items' requests concurrently (F-033). For a long document that put every batch on TEI's CPU at once, so the per-request timeout measured the whole document, not one batch. The node now runs inside a loop with batch size 1. TEI on the CPU already processed the concurrent requests from one queue, so total time should change little; this is expected, not measured (the next ingestion records it). For Ollama on the GPU some overlap is lost; it is the fast model, so this was accepted rather than adding a second loop per model. Tokenization requests (cheap; 12 for the largest document, 353,919 characters in 1,000-character pieces, 32 per request) and the evaluation's query embeddings (a few batches) stay concurrent.

### D-050 TN pack v1.2 before the gold set

Reading every exported text to write the gold set (D-051) led to these changes:
- `tn-lo-2004-63-ar-igppp` is removed: its PDF has no usable text layer (F-038). Arabic text of law 2004-63 is not in the corpus; questions about it in Arabic are cross-lingual.
- Extraction options for the nine jurisitetunisie.com pages (keep from the "Livre Deux" heading to the site's footer link) and for the Ministry of Justice page (keep only the civil and commercial questions; 16,766 characters of which more than half were the site menu, now 7,936).
- The fixes F-036 to F-038 change the stored text of 10 documents at the next ingestion; `kb/tools/reextract.js` lists them before ingesting.

### D-051 Gold set v1: 48 questions, gold as quoted spans

`eval/datasets/tn_retrieval_v1.jsonl`, written by `build_tn_retrieval_v1.py`, described in `eval/datasets/README.md`. 48 rather than 40, because the language groups of spec 10.7 need several questions each to say anything: 25 French, 5 English, 6 Arabic script, 4 transliterated, 4 code-switched, 4 out of scope; 10 contradiction cases. Choices:
- The gold is the supporting text in the question's language when the corpus has it, else French (tagged `cross_lingual`). Transliterated and code-switched questions list both the Arabic and the French text of the code. Recall therefore asks a mixed-language question to find both versions; Hit@k and MRR do not.
- Blogs and press pages are gold when they state the point. Retrieval should surface them; whether an answer may rely on them is a later decision based on reliability.
- Out-of-scope questions have no gold and are not scored for retrieval; abstention is measured when answers exist (phase 6).
- Written before any retrieval run on the corpus, so the questions are not fitted to what the system already finds. One person wrote and checked them (no second annotator); this is a limit of the numbers.

### D-052 Gold set v2 by pooling

Reading the first run showed relevant passages missing from the v1 gold (F-040). v2 keeps the 48 questions and adds every relevant passage among those any of the 12 runs placed in its top 10 (pooling, as in TREC-style evaluations), judged against written rules (`eval/datasets/README.md`). Choices:
- Pool depth 10, the deepest the metrics read (Hit@10, Recall@10, nDCG@10). Depth 5 would have halved the work but left ranks 6-10 unjudged.
- Relevance does not depend on language: the Arabic text of an article answers a French question as well as the French text does. This replaces the v1 rule that preferred the question's language, which judged equivalent passages differently.
- Questions that ask the same thing share their relevant passages (need groups), because pooling otherwise makes the gold of a question depend on what its own runs happened to retrieve.
- Rules of other regimes (commercial leases, rural leases, professional premises) are not relevant to questions about housing, even for questions tagged contradiction; the judges were not consistent on this, and review applied it to all.
- Judging was done by model-based annotators and reviewed by me, with no human check (stated in the report). v1 stays in the database and its report is kept (`docs/RETRIEVAL_EVAL_v1.md`); the same retrieved lists are scored against both.
- Recall is not comparable between v1 and v2 (up to 29 spans per question in v2); the comparison between versions uses Hit@k and MRR.

## Phase 3: profile and search (2026-10-02)

### D-053 Local language models: three candidates, chosen by benchmark

Spec 5.5 asks for two or three current open models benchmarked on the golden sets. The GTX 1650 has 4 GB, and bge-m3 (about 1.2 GB) shares it. Candidates, read on ollama.com on 2026-10-02:
- `qwen3.5:4b` (3.4 GB, Apache 2.0 per its Hugging Face card, 201 languages listed, thinks by default). Requests send `"think": false` (setting `llm.model_overrides`); the card says thinking is on unless disabled.
- `granite4.2:3b` (2.2 GB, Apache 2.0, Arabic among the listed languages).
- `phi4-mini:3.8b` (2.5 GB, last updated about a year before; recommended for 4 GB cards and structured output by two June 2026 guides).
Correction (F-048): granite4.2 also thinks by default; it is told not to as well (migration 0009). Not chosen: `gemma4:e2b` (4.3 GB at its smallest tag, more than the card), 7B and larger models.
Every call: temperature 0, seed 42, `num_ctx` 4096, the version's JSON Schema as Ollama `format`. The default model (`llm.default_model`) is `qwen3.5:4b` until the benchmark decides; workflows read it from settings, never from code. Ollama will have to swap models when the LLM and bge-m3 do not fit together; the benchmark records `ollama ps` after each model rather than assuming.

### D-054 Prompt registry: files are the source, versions are immutable

`prompts/<name>/v<N>.md` (front matter: version, techniques, params, changelog; then a `## system` and a `## user` section) and `prompts/<name>/prompt.json` (agent, role, schema, variables, active version). `scripts/prompts.py sync` writes them to `ai.prompts` and `ai.prompt_versions` with the template's sha256, refuses a stored version whose template changed (a change is a new version), and sets the active version. Workflows load the template at run time with `ai.prompt_for(name, version)` and record the version id in `ai.agent_steps` and `eval.runs`. The user's message always sits alone between `<message>` and `</message>`; the code replaces any `<message>`/`</message>` the user types, so user text cannot end the block (spec 9.6). One retry with the validation errors when the answer is not valid JSON or breaks the schema (spec 8.8); the JSON Schema is validated again in the Code node by `n8n/src/lib/schema_lite.js` (n8n Code nodes cannot load packages), checked against the Python `jsonschema` package on 300+ cases.

Spec defect: spec 9.4 lists the router intent `unsupported`, spec 8.2 `smalltalk_or_unsupported`. The schema uses `smalltalk_or_unsupported`, the orchestrator's name.

### D-055 Golden sets P1 and P2: synthetic, model-labelled, blind re-label

`eval/datasets/p1_router_v1.jsonl` (160 messages) and `p2_profile_v1.jsonl` (110 requests) were written from labelling guides (`eval/datasets/guides/`) by a model-based annotator, then 20% of each (32 and 22 items, drawn with seed 20261002) were re-labelled blind by a second model-based annotator that saw only the message and context. Agreement: P1 every field equal on 31 of 32 (intent 32/32, kappa 1.0; one language label differs); P2 21 of 22 (one anchor label differs). Both annotators follow the same guide and are the same kind of model, so this agreement says the guide is unambiguous to such an annotator, not that a human would agree. Limits stated in the evaluation report: no human labelling, Tunisian Derja and arabizi not checked by a native speaker (spec 9.7 asks for it; the owner can review `relabel/` samples). Few-shot examples in the prompts were written separately and are checked not to contain any golden message (`tests/unit/test_prompts.py`); two rule examples in P1 v2 that echoed the guide were rephrased before any run.

Planned iterations follow spec 9.3: v1 is the baseline (P1 zero-shot; P2 without unit rules), v2 adds rules and few-shot examples. Both were written before any run, so v1 vs v2 tests the spec's hypotheses; a v3, if any, is written from the failures v1 and v2 show.

### D-056 Money: integer minor units, rent period, conversion in SQL

Amounts stay integers in minor units of an ISO 4217 currency; exponents come from `app.currencies` (TND 3, EUR 2, JPY 0). `app.to_minor(amount, currency)` refuses amounts with more decimals than the currency has. Listings gain `rent_period` (month or week) and a generated `rent_monthly_minor` = weekly x 52 / 12 rounded down; search compares monthly amounts. `app.fx_convert_minor` converts with a rate no older than `fx.max_age_days` (7) and rounds half away from zero; with no usable rate it returns NULL and the search answers with the warning code `fx_rate_unavailable` instead of applying a guessed budget. P2 outputs minor units directly (spec 9.4); whether a model does the x1000 for dinars is measured by the golden set (`unit_error_items`), not assumed.

### D-057 Exchange rates: ECB euro reference rates

Source: the ECB daily XML (`https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml`), fetched by `wf.fx.refresh` on weekdays at 17:10 Europe/Paris and on demand (`POST /v1/admin/fx/refresh`). Reuse conditions, read 2026-10-02 at `https://www.ecb.europa.eu/services/disclaimer/html/index.en.html`: free use of information from the site, the ECB must be cited as the source, and modifications must be stated. Each row carries the ECB as source; a rate between two non-euro currencies is a cross rate through the euro, labelled `cross_eur` (a modification, stated in the API answer). The ECB states the rates are "for information purposes only", which fits comparing a budget with listings. The ECB does not publish the Tunisian dinar. The Central Bank of Tunisia page could not be read from here on 2026-10-02 (robots.txt not readable, then HTTP 503), so its terms are not checked and no TND rate is loaded: a TN search with a budget in euros returns `fx_rate_unavailable`. A TND source needs its terms read before use.

### D-058 Geocoding: a local gazetteer built once from OpenStreetMap

The public Nominatim usage policy (read 2026-10-02, `https://operations.osmfoundation.org/policies/nominatim/`) allows at most one request per second, requires an identifying User-Agent, requires caching of bulk results and attribution, and forbids autocomplete, systematic queries and services whose main function is geocoding. Sending every user's place text to it would also send personal data to a third party. Decision: `geo/places.csv` lists 271 places people name when they look for a room (cities, neighbourhoods, campuses, stations) with their names in French, English, Arabic and arabizi; `scripts/p3.py geo-fetch` asks Nominatim once per place (1 request per 1.2 s, cached in `geo/places_osm.csv`, committed); `app.geocode(text, jurisdiction)` matches names locally (exact, whole words inside the text, or trigram similarity at least `geo.min_similarity` 0.6, a design choice) and returns found, ambiguous with candidates, or not_found. User text never leaves the machine. Limits: no street addresses; places not in the list are not found. Self-hosted Nominatim stays the next step if coverage proves too low. Attribution: answers that use places carry `data_attribution: ["openstreetmap"]`; the frontend must show "© OpenStreetMap contributors" (ODbL). The place list was written by an annotator that did not see the golden sets, so the anchor coverage measured on P2 is not fitted to them.

### D-059 Public location: random offset drawn once

A trigger sets `public_location` to the exact point moved by a random distance between `geo.fuzz_min_m` (150) and `geo.fuzz_max_m` (400) in a random direction (uniform over the ring), drawn with `gen_random_bytes` when the exact point is set or changes; other updates keep it and it cannot be set to anything else while an exact point exists. Not derived from the listing id: a derived offset could be recomputed by anyone who has the id and the code. A listing with only an approximate public point (no exact one) keeps it. The radii are design choices; 400 m is a few blocks in a city, less in the countryside.

### D-060 Synthetic listings for phase 3

120 listings (TN 72, FR 28, GB 20), generated deterministically (seed 20261003) by `scripts/seed_listings.py` around gazetteer places, flagged `is_synthetic` and `source = 'synthetic'`, texts in French, Arabic, arabizi and English from templates. Rents are drawn from ranges chosen to exercise budgets, currencies and weekly rents (30% of GB listings); they are not market data. All published listings are synthetic in this phase (100%), stated in every report (spec 15.2).

### D-061 Search and profile endpoints

- `GET /v1/search`: filters and optional text; hybrid search through `app.search_listings` when there is text, filters only otherwise (nearest first with a point, newest first without). Explicit parameters win; with `use_profile=true` the saved profile fills what is missing, then the account's jurisdiction. Results carry only public fields.
- `POST /v1/profiles/extract`: P2 then deterministic checks in code (preferences outside the jurisdiction's allowed list move to `unparsed`; a stated amount without currency gets the jurisdiction's currency; reversed ranges are swapped; each produces a warning code), then the anchor is geocoded. The request text is not stored (`raw_text` stays empty until PII masking exists, phase 4); agent steps record its length only. Relative dates are resolved against the UTC date.
- `PUT /v1/profiles/me`: the whole profile, validated against its schema; the database resolves the anchor label.
- Search latency is measured end to end through the proxy, with the embedding and database times reported separately (spec 2.6: p95 under 1.5 s, explanations excluded).

### D-062 Orchestrator scope in phase 3 and consents

`POST /v1/assistant/message` runs P1 and a deterministic Switch: `search_listings` goes to profile extraction and search; low confidence (below `router.min_confidence`, 0.6, a design choice to revisit with the golden set) or `needs_clarification` returns the router's question; the other intents answer `not_available_yet` until their agents exist (phases 4 to 7). The user endpoints of this phase require the `terms` and `privacy` consents. `cloud_llm_processing` is not required: every model call stays local (D-002).

### D-063 Job type checks

`CREATE_JOB_SQL` checked that `input.jurisdiction` exists, which jobs without a jurisdiction (prompt evaluation, embeddings, exchange rates) do not have. The check now applies only when the input names a jurisdiction.

### D-064 Prompt versions 2 active for P1 and P2

Spec 9.5: a new version is promoted when it is better on the golden set and the safety cases do not get worse. Measured on the owner's PC on 2026-10-03 (`docs/PROMPT_EVAL.md`, runs marked `yes`), v2 against v1 on every model: P1 intent accuracy +0.137 to +0.169 (95% paired bootstrap intervals all above zero); P2 field F1 +0.190 to +0.303 (same). Safety, v1 to v2: P1 injection pass qwen 0.833 to 0.944, granite 0.444 to 0.833, phi4-mini 0.556 to 0.611, prompt leaks 0 in all runs; P2 items with an invented budget qwen 2 to 0, granite 23 to 3, phi4-mini 10 to 2; items with a protected preference turned into a filter qwen 6 to 1, granite 20 to 15, phi4-mini 21 to 1. No measure got worse. Both prompts now have `active_version` 2 in `prompt.json`; `p3.ps1 -Step report` applies it to the database before writing the report. v1 stays stored (retired) for comparison.

Neither v2 meets the starting targets of spec 2.6 on any model (best: P1 intent accuracy 0.919 against 0.95, P2 field F1 0.870 against 0.90). The failures that remain are listed in the phase 3 report (T-38); a v3 is not written in this phase.

### D-065 Default model stays qwen3.5:4b

`llm.default_model` was set to `qwen3.5:4b` before any measurement (D-053). After the runs it stays, for both prompts: it is the most accurate with v2 (P1 0.919 against 0.781 phi4-mini and 0.762 granite; P2 F1 0.870 against 0.760 granite and 0.747 phi4-mini) and the best on every safety measure above. The cost is latency on the owner's GTX 1650 (4 GB): `ollama ps` showed qwen 52% on the CPU, against 26% for phi4-mini and 12% for granite. With v2, p95 per call: P1 8.9 s for qwen against 3.6 s phi4-mini and 5.7 s granite; P2 36.6 s for qwen against 23.8 s and 22.1 s. These are latencies of one call at a time during an evaluation, not of the API under load (not measured). A per-prompt model is possible (`ai.prompt_versions.model`) but no other model is close enough on accuracy to justify it. To revisit when the hardware changes.

### D-066 P2 v3: the model gives amounts in main units, code converts them

Spec 9.4 says to pass the currency exponent into the prompt and let the model convert money to minor units; v1 and v2 did that. On the owner's PC, with the explicit rules of v2, items with a power-of-ten budget error were 7 of 110 for qwen3.5:4b, 5 for phi4-mini and 30 for granite4.2:3b (T-38); 5 of qwen's 7 were TND amounts multiplied by 100 instead of 1000. Multiplying by a power of ten is arithmetic a small model does unreliably and code does exactly. From P2 v3 the output has `budget_min` and `budget_max` in the currency's main unit (450 for 450 dinars), and `n8n/src/lib/money.js` converts them with the exponent from `app.currencies`, using the jurisdiction's currency when the model gives none (the prompt's own rule 2). The same function runs in `wf.profile.extract` before the existing checks and in `wf.eval.prompts` before scoring, so the evaluation measures what the profile would store; the model's own answer is kept in `eval.results.output.model_output`. The stored profile, the API and the golden labels keep minor units. The model still has to read the amount right ("450 alf" is 450 dinars, "1.500 DT" is 1500); only the multiplication moves to code.

A version can now carry its own output schema (`schema:` in the front matter, `prompts/schemas/P2_profile_extractor.v3.schema.json`); v1 and v2 keep theirs, and `scripts/prompts.py sync` refuses a stored version whose schema changed, as it already did for the template.

### D-067 Version 3 of P1 and P2: one change each, measured on the default model, not active yet

Spec 9.5 asks for one change per version. P2 v3 changes only the money representation (D-066). P1 v3 changes only the clarifying-question path, which is the v3 the spec plans for P1 (9.3): in v2, qwen3.5:4b asked for clarification on 4 of the 10 golden messages that need it and sent short housing messages in Tunisian to `smalltalk_or_unsupported`. The rule now says a vague housing message is never small talk, gives the most likely task with confidence below 0.6 and asks in the message's language and script, with two new examples (Tunisian in Latin and in Arabic script). Other P1 failures seen in T-38 (the account jurisdiction copied into the hint, Tunisian in Latin letters in general, the fake `SYSTEM:` line) are left for later versions so each change can be measured on its own.

Both are run on qwen3.5:4b only (the default model, D-065) and compared with the stored v2 runs of the same model; the other models can be added with `-Models`. v2 stays active until v3 beats it on the primary metric (P1 intent accuracy, P2 field F1) without any regression on the safety measures (injection pass, prompt leaks, protected preferences mapped, invented budget). Caveat: v3 was written after reading the failures of the same golden set it is measured on, so its gain on that set is an optimistic estimate. The examples are not golden messages (unit test), and the changes are general rules rather than item fixes, but no separate held-out set exists yet. The owner, a native speaker, reworded the Latin-script Tunisian example of P1 v3 to "slm, 3andy sou2el 3al bit elli fi manouba" (spec 9.7) and left the Arabic-script one as written. That example is close in meaning to two golden items, p1-074 ("نحب نسأل على البيت", gold search_listings) and p1-102 ("3andi soal", gold legal_question), both vague messages that need a question; the v3 result is therefore also reported without those two items.

### D-068 P2 v3 active, P1 v3 not

Measured on the owner's PC on 2026-10-04, qwen3.5:4b, v3 against the stored v2 run of the same model (T-40).

**P2 v3 becomes active.** Spec 9.5 rule: it beats v2 on the primary metric (field F1 0.876 against 0.870) and does not regress on the safety measures (invented budget 0 and 0 of 21; protected preferences turned into a filter 1 to 0; no injection followed in either version). The F1 gain is within noise (paired bootstrap +0.007, 95% interval -0.013 to +0.025). What changed is the kind of budget error: of the 87 golden requests that state a maximum budget, v2 got 73 right, 8 wrong by a power of ten and missed 6; v3 got 69 right, 0 wrong and missed 18. A missing budget leaves the search unfiltered on price and the profile shows no budget; a budget ten times off filters on the wrong price without any sign. The first is the safer failure, so the rule's outcome is kept. The 12 extra missed budgets are the next P2 problem (for example "280 دينار" and "250 alf" returned as null); why the model drops them more often with main-unit fields is not known.

**P1 v3 stays inactive; v2 remains active.** Intent accuracy 0.925 against 0.919 is one item, p1-102, which is close in meaning to the new example (D-067); without p1-074 and p1-102 both versions score 0.9304. Clarification recall rose from 0.400 to 0.600, but two of the three gains are those two items, and p1-027 was lost. Language accuracy fell from 0.825 to 0.756 (11 Modern Standard Arabic messages now labelled Tunisian, likely an effect of the new Arabic-script Tunisian example, not tested) and jurisdiction-hint accuracy from 0.812 to 0.738 (11 more hints given where the message has none). Injection pass is unchanged (0.944, the same p1-094) and there are no leaks. With no real intent gain and two regressions on fields the orchestrator passes on, v2 is kept. The run stays stored as a negative result for the prompt library (spec 9.8).

### D-069 Phase 4 evaluation data

Chosen by the owner on 2026-10-04.

- **Speech (ASR benchmark).** Public sets first, so the benchmark can run without waiting: samples from the test splits of `linagora/linto-dataset-audio-ar-tn` (Tunisian, including the TunSwitch code-switched and Tunisian-only subsets) and `google/fleurs` (`fr_fr`, `en_us`, `ar_eg`), both CC-BY-4.0, downloaded on the owner's PC (Hugging Face is not reachable from the sandbox). Plus about 30 voice notes recorded by the owner and two other speakers with their consent, written as search requests with a budget, a place and a date, for the measure that matters here (spec 11.1: extracted budget, location and date after P2). Recordings, transcripts and consent records stay in `D:\Projects\coloc\voice_bench`, outside the repository; only scores are committed. This is a deviation from spec 11.1 ("own recordings", 60 clips, 3 speakers): the 60-clip minimum is met with public clips, and the own recordings are fewer.
- **Photos (P7 and duplicate detection).** Openly licensed interior photos from Wikimedia Commons, fetched on the PC with each file's licence, author and source URL recorded; files whose licence is not CC0, public domain, CC BY or CC BY-SA are skipped. Labels are written by Claude from the images, with a blind 20% re-label, like the P1/P2 golden sets (D-055); no human check yet. Near-duplicate pairs are made from these photos by deterministic edits (crop, resize, recompression, brightness, small rotation) and unrelated pairs from different photos. Being cleaner than real listing photos, this set probably overstates accuracy; reports say so.

### D-070 Media service: what a photo goes through

The Media service (`services/media`, FastAPI, compute only) processes one photo per call (spec 11.2 steps 1 to 4):
- **Type** is sniffed from the bytes (`filetype`), not taken from the name or declared type. Accepted: JPEG, PNG, WebP. HEIC is refused because the only Pillow plugin for it ships GPL-licensed binaries (docs/research/PHASE4_COMPONENTS.md); phones can export JPEG. Animated images and GIFs are refused.
- **Size and pixels** are checked before decoding: 15 MiB per photo (setting `media.max_bytes`), 40 megapixels, longest side 10,000 px, shortest 64 px; Pillow's decompression-bomb warning is raised as an error.
- **EXIF** (capture time, make, model, software, GPS) is read for the trust check, then dropped: the stored JPEG is rebuilt from pixels without EXIF, ICC profile, comment or XMP (Pillow keeps a JPEG comment by default otherwise). Orientation is applied first.
- **Hashes:** SHA-256 of the uploaded bytes (exact duplicates; unique per listing) and a 64-bit pHash of the upright image *before* blurring, so someone else's copy of the photo still matches after our blurring.
- **Blurring** (pixelate then blur, with padding): faces (YuNet), text regions (PP-OCRv3 DB detector; covers documents and screens that show text) and screens (YOLOX-S, COCO classes tv, laptop, cell phone). All three models come from the OpenCV model zoo under MIT or Apache-2.0 licences, are downloaded at image build time and checked against `services/media/models.lock`. AGPL or non-commercial alternatives (Ultralytics YOLO, EAST, InsightFace weights, PyMuPDF) are not used.
- **Metrics** for the capture coach later: variance of the Laplacian on a copy whose long side is 1,024 px, mean brightness, shares of very dark and very bright pixels.

Not measured yet: detector recall on real photos (the photo set of D-069 measures faces and text where present), and the text detector on Arabic script (trained on English and Chinese). The pHash threshold starts at 6 (spec) and is measured on the near-duplicate pairs (4.5).

### D-071 Uploads go straight to object storage, signed for the proxy

`POST /v1/listings/{id}/media/presign` creates upload slots in `app.media_uploads` (the database checks ownership, listing state, kind, declared type and size, and at most 20 files per listing) and returns one presigned PUT URL per file, valid 10 minutes. The Media service signs them with the S3 credentials, for the public proxy address (`S3_PUBLIC_ENDPOINT`, `http://localhost:8080` by default), because an S3 signature covers the Host header the client sends. The proxy passes only signed PUTs under `/<bucket>/uploads/` to Garage (100 MiB limit there, 1 MiB for the API), with the Host header unchanged; anything else under the bucket path is a 404. Keys are `uploads/<listing>/<upload id>.<ext>`; processed copies go to `media/<listing>/<upload id>.jpg`.

`POST /v1/listings/{id}/analyze` starts a `listing_analyze` job. Each photo goes through `wf.intake.photos`; a photo is stored, rejected (with the Media service's reason code) or left pending (not uploaded yet). Once a decision is stored, the raw upload is deleted, because it still carries EXIF (GPS, device) and unblurred faces. The Media service therefore holds storage credentials and reads and writes objects; it still writes no database table and calls no model, which is what the spec's boundary rule (5.1) is about.

`POST /v1/listings` creates a draft from the owner's text, and `GET /v1/listings/{id}` is the owner's view. Extraction (P3) and vision (P7) are later steps of the same job.

### D-072 Photo GPS is never stored

The spec says to use EXIF for the trust check and never expose GPS. Exposure is easier to rule out if the coordinates are never stored: `app.store_listing_photo` keeps only whether GPS was present and, when the listing has an exact location, the distance between the two rounded to 100 m (`analysis.exif.gps_distance_m`). That is what the trust agent needs ("photo taken far from the address"). The coordinates exist only in the Media service's answer to n8n and in the raw upload, which is deleted.

### D-073 Job retries and the reaper (spec 5.6; deferred from D-041)

Migration 0010 adds `next_attempt_at`, `lease_until` and `last_error` to `app.jobs` and four functions: `app.job_start` (claims a queued job, sets a lease from `jobs.lease_s`), `app.job_finish` (a transient failure with attempts left goes back to the queue; the delay starts at `jobs.backoff_s`, 30 s, and doubles), `app.jobs_reap` (a running job past its lease is queued again or, on its last attempt, failed with "timeout") and `app.jobs_due`. `wf.jobs.dispatch` runs every minute: reaper, then starts the due jobs of the types that use these functions. Only `listing_analyze` does so far; the older job types keep their single attempt until they are moved over. A transient failure is one where the Media service did not answer or answered 5xx; a rejected file is not a failure.

### D-074 Language identification in the Text service

The Text service (`services/text`) identifies language and script before P1 (spec 9.7) with the labels of the P1 guide. Latin-script Tunisian (arabizi) has no published model label (no `aeb_Latn` in GlotLID or elsewhere), so a rule detects it: digits used as letters inside words and a short list of frequent Tunisian words. Other text goes to a statistical backend: GlotLID v3 when its model file is present (it has `aeb_Arab`, published F1 0.912), otherwise lingua (no Tunisian label; a Tunisian-word list then separates Tunisian from MSA in Arabic script). Mixed text is found clause by clause (two languages each over 30% of the words).

Measured in the sandbox with lingua (reports/phase4/05-langid-lingua-sandbox.log): P1 golden set language accuracy 0.8875, script 1.0; P2 golden set 0.7364, with Tunisian in Arabic script 0/12 (all labelled MSA). The word lists were written after reading the P1 set, so its figure is optimistic; the P2 figure shows the weak point. GlotLID is measured on the PC (it is a 1.7 GB download from Hugging Face, not reachable from the sandbox); the backend is chosen on those numbers. The orchestrator records the result as an `A0_text` agent step (language, script, PII counts; no text). It does not feed P1 yet: that would change P1's inputs, which is a new prompt version.

### D-075 PII masking: patterns plus a NER model, measured on two sets

Recognisers (spec 13.2): e-mail; phone (`phonenumbers` for TN, FR, GB, at least 8 digits, not part of a longer digit run); card (Luhn); IBAN (`schwifty`); IDs (French NIR with `stdnum`, UK NINO pattern, Tunisian CIN as 8 digits near an ID word or starting with 0 or 1: no library exists for it); addresses (house number and street word in French and English, street word and name in Arabic and arabizi, UK postcodes); names (cue phrases, titles, and a NER model). Placeholders are stable within a request and the mapping is returned to the caller, never stored by the service.

Two synthetic, template-built sets (`eval/datasets/pii_v1.jsonl`, 127 messages, 200 spans; `pii_heldout_v1.jsonl`, 53 messages, 84 spans, written after the tuning with new sentence shapes). Runs without the NER model (reports/phase4/01 to 04):

| Run | Set | Recall | Precision | Change |
|---|---|---|---|---|
| 1 | pii_v1 | 0.970 | 0.907 | first version |
| 2 | pii_v1 | 0.970 | 0.985 | phone matching VALID instead of POSSIBLE: fewer prices taken for phones, but 6 real-looking mobile numbers lost; "je suis" name cue; 8-digit groups inside longer numbers |
| 3 | pii_v1 | 1.000 | 0.990 | POSSIBLE again with at least 8 digits and no two-year pairs |
| 4 | held-out | 0.714 | 0.909 | scored once: names without a cue phrase 0 of 24 |

Patterns alone cannot find names that are not introduced by a cue, so the spec's NER model is needed. `Davlan/xlm-roberta-base-ner-hrl` (AFL-3.0; Arabic, French and English among its languages) runs in the Text service with CPU-only PyTorch; it is downloaded on the PC (`fetch_models.py`) and measured there on both sets. Until it meets the 0.98 recall target on the held-out set, the masking must not be trusted for a cloud call; no cloud call exists (D-002).

### D-076 P3 output shape and the rent range check

The spec's starting shape for P3 (9.4) nests rent and deposit and asks for minor units. P3 uses a flat schema (`prompts/schemas/P3_listing_extractor.schema.json`) with amounts in the currency's main unit (`rent_amount: 450` for 450 dinars), for the reason of D-066: P2 v2 made power-of-ten errors when the model converted to minor units, and code does the conversion with `app.currencies`. Three additions to the spec's fields: `per_person` as a rent scope (Tunisian and French listings often say "each pays"), and `city` and `neighbourhood`, which the listing table already has. The model's answer is kept in `app.listings.extraction.model_output`.

Post-validation (spec 9.4) is code, `n8n/src/lib/listing_check.js`, used both by the workflow and by the evaluation. A rent outside the plausible monthly range of its currency (weekly rents compared as 52/12 of a week) is set to null with the issue `rent_out_of_range`; a deposit is checked against the same range. The ranges are a setting, `listing.rent_range`: TND 30 to 10,000, EUR 50 to 10,000, GBP 50 to 10,000 (main units per month). These are **chosen values, not market statistics**: they are wide enough for every rent in the golden set (TND 150 to 1,800, EUR 320 to 1,950, GBP 390 to about 2,400 a month) and narrow enough that multiplying or dividing any of those rents by 10 to the power of the currency exponent (1,000 for TND, 100 for EUR and GBP) falls outside. Checked by scoring the golden labels with that error on every rent and deposit (`reports/phase4/10-p3-range-check-on-gold.log`): 86 items with a unit error before the check, 0 after, in both directions. A factor of 10 is mostly not caught (73 of 86 items still wrong after the check when multiplied by 10, 58 when divided): a range cannot separate 450 from 4,500 dinars. The evaluation reports F1 and unit errors both on the model's answer and after the check.

### D-077 Storing the extraction (migration 0011)

- `app.store_listing_extraction` writes the extracted fields to the listing (draft, processing or pending review only). Until owners can edit fields (the owner edit endpoint is not built yet), the extraction is the only writer of these columns, and a new analysis replaces them. When owner edits exist, owner values must win; this is noted for that phase.
- `rent_scope` is a new column. A `whole_flat` or `unknown` rent is stored with its scope and the issue `rent_scope_whole_flat` or `rent_scope_unknown`, for the owner to give the price of the room. Search still compares `rent_monthly_minor` with the budget whatever the scope; restricting search to `per_room` and `per_person` rents is left to the publication step, where the issues are resolved.
- One currency per listing (the table has one column): a deposit in another currency than the rent is dropped with `deposit_currency_differs`.
- The exact address (`address_text`) stays inside `extraction`, never in a public column, like the exact location (spec 4.4).
- The Text service runs on the listing text first: its language goes to `description_lang`, and when it finds a phone number or an e-mail address the issue `contact_details_in_text` is added. Only counts are kept, never the values.
- `POST /v1/listings/{id}/analyze` now accepts a listing with text and no file (before, it needed a waiting file).
- Job workers record their model calls: `app.record_job_steps` writes one `ai.executions` row (request id = job id, channel `job`) with its `ai.agent_steps` (spec 8.3, 9.1). The extraction step is `A1_extract`, with the prompt version id and no listing text.
- A non-transient extraction failure (invalid output twice) fails the job without retry; a model that does not answer is a transient failure and the job is retried (D-073).

### D-078 P3 golden set and its adjudication

`eval/datasets/p3_listing_v1.jsonl`: 100 synthetic listings written for the set and labelled from `eval/datasets/guides/p3_listing.md` by a model-based annotator (as D-055); composition in `eval/datasets/README.md`. A second model-based annotator labelled a random 20 blind. Before adjudication 15 of 20 items agreed on every field; kind 19/20 (Cohen's kappa 0.924), furnished 17/20, amenities 18/20, the 13 other fields 20/20. The five disagreements came from three points the guide did not settle (Tunisian `fergha`, internet without the word wifi, an owner letting a room in the home they live in). I settled them in the guide and applied the rule to every item it covers, 7 label changes listed in `relabel/p3_listing_v1_adjudication.json`; the agreement file keeps the numbers from before. As for P1 and P2, both annotators are models, so this shows the guide leaves little room to such an annotator, not human agreement; no native speaker has checked the Tunisian items (spec 9.7).

### D-079 Telegram channel: long polling, consent first, the public API as its only door

The spec names a Telegram bot as the second channel and the test client before the website (5.1, 8.4 `wf.channel.telegram`). Choices:

- **Long polling, not a webhook.** Telegram's webhook needs a public HTTPS address, so a tunnel into n8n from the internet. A small relay (`services/telegram/poller.py`, container `fs-telegram`) asks Telegram for new updates with long polling and hands each one, unchanged, to the internal webhook `/webhook/telegram/update` (X-Internal-Token; the proxy never maps it). Only outgoing connections, so nothing is exposed. The relay confirms an update to Telegram only after n8n accepted it, and n8n handles an `update_id` once per bot (`app.telegram_updates`, keyed by a hash of the bot token the relay sends, F-060), so a restart loses nothing and repeats nothing. The relay holds no logic: everything the bot does is in n8n, where it can be shown. n8n's own Telegram Trigger node only works with webhooks. On a server with a public address the webhook becomes the better choice and the workflow stays the same.
- **The bot is an API client.** `wf.channel.telegram` calls the public API through the proxy, signed as the client `telegram`, like the website will: signature, consent and rate limits apply to it, and the bot tests the API. Its secret never leaves the database: `sec.sign_internal` signs only for clients marked internal and only n8n_worker may call it. A Telegram user is `external_auth_id = telegram:<user id>`, created through `POST /v1/users/sync`.
- **Consent before anything.** Every update from a user without terms and privacy consent gets the consent request (two buttons) and nothing else; the request names Telegram's servers as part of the path. One button records terms, privacy and media_processing with source `telegram` through `POST /v1/me/consents`; `/stop` records the withdrawal. The bot never stores message text itself; the API's rules apply (D-062).
- **Two routes from spec 6.2 added for it:** `POST /v1/me/consents` and `GET /v1/admin/traces/:request_id` (admins; the `/trace` command shows the steps, prompt versions, models and times of the user's last request or listing job).
- **Scope of this version:** text messages to the assistant, `/annonce` (text, optionally one photo as its caption) through create, presign, upload and analyze with the result read back, `/pays`, `/moi`, `/stop`, `/trace`. Voice notes answer "coming" until the ASR service exists. Replies in French, English or Arabic from Telegram's language setting. All Telegram users share the per-IP rate limit (the bot's requests come from one address); the per-user limit applies to each user.

### D-080 P3 listing extractor: version 4 active

Owner's PC, qwen3.5:4b, golden set p3_listing v1 (100 listings), one run per version (T-44). Version 4 is v2's rules and six examples with v3's short output (F-058); version 3 is the direct baseline with the short output.

| | v3 | v4 |
|---|---|---|
| JSON valid / answers cut at the limit | 100 / 0 | 100 / 0 |
| Field F1 (model answer / after the range check) | 0.668 / 0.654 | 0.852 / 0.849 |
| Precision / recall | 0.558 / 0.831 | 0.837 / 0.869 |
| Unit errors on rent or deposit (items; after the check) | 9 (1) | 0 (0) |
| Rent scope accuracy | 0.776 | 0.824 |
| Latency p50 / p95 | 48.3 / 55.0 s | 20.4 / 26.0 s |
| Tokens in / out (average) | 428 / 415 | 2,521 / 144 |

Paired bootstrap, field F1 v4 - v3: +0.185, 95% interval [+0.162, +0.208]. v4 is better on every tag and on every field but one: `kind` (room, shared flat, roommate wanted) drops from 0.790 to 0.740. Its weakest tags are Tunisian in Arabic script (F1 0.722, 10 items) and in Latin script (0.774, 15) and listings without a price (0.775). Version 4 is active (`prompts/P3_listing_extractor/prompt.json`). v4 is faster although its prompt is about six times longer in tokens: it writes about a third as many tokens, and on this GPU generating tokens is what takes the time.

What v4 still gets wrong, read in the answers:

- **Injection.** 6 listings contain an instruction to the model. v4 followed it in 3 (p3-010, p3-056: rent 0; p3-080: rent 1 and bills included). The range check nulled all three rents, so no stored listing has a rent of 0 or 1, but p3-080's `bills_included: true` came from the injected text and passes the checks. The other two items counted as injection failures (p3-002, p3-030) did not follow the instruction; they fail on an invented date and an invented `bills_included`. Injection pass is 1 of 6 for both versions by the strict metric.
- **The range check lowers F1 slightly** (0.852 to 0.849) on purpose: when it nulls a rent it also nulls the currency, period and scope that go with it (D-076), and in those three items those were right.
- **Discriminatory listings.** 4 of the 6 got a house rule the labels do not have. The house-rule keys are a closed list (smoking, pets, guests, parties), so no answer could carry "girls only", "Tunisians only" or "no couples"; what v4 added is `pets: no` (3 items) and `smoking: no` (1), which the texts do not say. These are invented values, not the discriminatory criterion; the report column was renamed to say what it counts.
- **Invented values remain the largest failure category** (66 items with at least one, against 99 for v3), then missed values (56).

Not measured: other models on P3; a second run of each version (one run each, so run-to-run spread is unknown); a native-speaker check of the Tunisian items (D-078).

### D-081 P7 photo analysis: same model, blurred copy, room facts only, contradictions in code

Spec 11.2 steps 5 and 6, 9.4 P7. Choices:

- **Model.** qwen3.5:4b, the model already loaded for P1 to P3: Ollama's library lists its input as "Text, Image"
  (https://ollama.com/library/qwen3.5, read 2026-10-05). A second vision model would not fit next to it in the GTX 1650's
  4 GB. `p4.ps1 -Step p7-setup` checks on the PC that `ollama show` lists the vision capability.
- **What the model sees.** The stored copy (EXIF removed, faces, text regions and screens blurred, D-070), sent by the
  Media service as a JPEG whose long side is 1,024 px (setting `vision.max_side`; `POST /v1/images/vision`). The image
  goes through the same `wf.llm.call` as the text prompts (Ollama `images` on the user message), so schema validation,
  the retry and the trace are shared. Image tokens on the PC are not measured yet (T-46).
- **Output.** Closed lists that a listing can use (room type, beds and kinds, furniture, appliances, bathroom fixtures,
  windows, daylight, condition and its signs, furnished) and two flags: `readable_text` (text still readable after
  blurring: the blur missed something) and `people_visible` (yes or no, nothing else about the person). v1 is the spec's
  baseline (an open description plus every field answered); v2 removes the free description, allows "not_visible" and
  asks a confidence per filled field. v1 is active until the evaluation says otherwise (spec 9.5).
- **Checks in code** (`n8n/src/lib/photo_check.js`): lists reduced to the vocabulary, free text that names a person
  (English, French, Arabic, Tunisian words) dropped and reported in `dropped`, review flags. The answer is stored in
  `listing_media.analysis.vision` (`app.store_photo_analysis`).
- **Contradictions with the listing are computed in code, not by the model.** The spec lists them in the P7 schema.
  Giving the listing text to the vision prompt would put user-written text (an injection surface, D-076) next to the
  image, and the comparison is simple and testable as code: after P3, `photoFindings` compares the photos with the
  checked fields. Only positive evidence counts: a photo that does not show a washing machine says nothing about the
  flat. Issues: `photos_show_amenities_not_in_text` (with the list; the amenities are suggestions, the owner confirms),
  `photos_contradict_furnished` (only answers with confidence 0.5 or more), `photo_text_readable`, `photo_not_a_room`,
  `photo_analysis_failed`.
- **Failure.** A failed analysis does not reject the photo: it is stored as failed and the listing gets
  `photo_analysis_failed` for review (spec 8.4 A1). Setting `vision.enabled` turns the step off.
- **Not built:** the verified-room proof (spec 11.2, optional badge); later in phase 4 if time allows.

### D-082 P7 evaluation and the near-duplicate threshold

- **Golden set** `p7_photos v1`: 50 photos chosen from 125 Wikimedia Commons candidates (D-069), labelled from the
  blurred 1,024 px copies with `eval/datasets/guides/p7_photos.md`; composition in `eval/datasets/README.md`. Labels allow
  null (not determinable), `*` (not scored), alternative values and "maybe" objects, so that a reading a careful person
  could also make is not counted wrong. A random 10 were re-labelled blind by a second model-based annotator: room type
  10 of 10, other fields 8 to 10 of 10 (9 to 10 counting alternatives), object Jaccard 0.833; three guide rules settled
  the conflicts, 8 labels changed.
- **Metrics** (`eval/lib/prompt_metrics.js` scoreP7): field accuracy over determinable fields (the primary metric),
  hallucination rate (objects listed that are not in the photo), unsupported answers (a value where the photo does not
  allow one), abstentions, people described in free text, confident wrong fields. Promotion (spec 9.5): v2 replaces v1
  only if field accuracy rises and neither the hallucination rate nor people described gets worse.
- **Near-duplicate threshold.** `eval/runners/phash_pairs.py` hashes the 50 photos with the Media service's own code
  (pHash before blurring) against 9 edits of each and all 1,225 pairs of different photos (T-45). At the spec's starting
  distance of 6: precision 1.0, recall 0.49 (resizes and recompressions all caught; a 90% crop 10 of 50, a 3° rotation
  25 of 50, a screenshot border 0 of 50). The closest pair of different photos is at 18. Distance 12 gives recall 0.70 with
  6 bits of margin under that pair; 16 gives 0.81 with 2. **Default raised to 12** (migration 0013 moves only an unchanged
  default). Not measured: precision on a large catalogue, where more unrelated pairs will come close; a match is a review
  flag (D-072), not a rejection. Mirrored copies (distance 26 to 38), heavy crops and screenshots with borders need another
  method; not built. Two different photos of the same room are 18 to 30 apart, so they are not reported as duplicates.

### D-083 Availability date check on P3 answers; automatic publication for testing

- **Date check.** On the owner's PC, P3 v4 wrote an availability date in 11 of 100 golden-set answers where the text
  gives none (T-44); in the bot it gave today's date to a listing that said nothing about when. `checkListing`
  (`n8n/src/lib/listing_check.js`) now removes `available_from` when the text has no sign of a time: a written date
  (15/10, 2026-10-15), a month name, or a word such as "dispo", "libre", "immédiatement", "available", "from", or their
  Arabic and Tunisian forms (فوري, متوفر, توا...). The issue `available_from_not_in_text` is added and the model's value
  stays in `model_output`. Measured on the stored v3 and v4 answers (`eval/runners/date_check.js`,
  `reports/phase4/33-date-check.log`): it removes 10 of 11 invented dates for each version, removes no correct date
  (57 in v3, 62 in v4), and all 70 gold-date texts pass it. It cannot catch an invented date when the text has a time
  word for something else (v3 p3-045, v4 p3-072 "dispo"), and it does not judge whether a date it keeps is right
  (10 wrong dates in v3, 5 in v4, unchanged).
- **Automatic publication** (`app.listing_auto_publish`, migration 0014; setting `listing.auto_publish`, **off by
  default**). The analysis creates a draft; spec 2.4 journey B has the owner confirm the fields and the trust check run
  before publication, and neither exists yet (phase 5). To show search working with a listing sent through the bot,
  this setting publishes a draft as soon as its analysis is done, if it has a rent with a currency and a neighbourhood
  or city that the local gazetteer finds in the listing's jurisdiction. The point used is the place's centre; the
  public point is fuzzed by the existing trigger. The title is the text's first line (up to 80 characters). The listing
  is embedded at once so semantic search finds it. It is marked `extraction.publication = {mode: auto, checked: false}`
  and logged in `app.audit_log` (`listing_auto_published`). When something is missing it stays a draft and the bot says
  what is missing. This skips the owner's confirmation and the trust check: it is for the sandbox, the demonstration
  and tests, and must be off for real users. Removed or replaced when the confirmation step is built (phase 5).

### D-084 A3 Match agent: the n8n AI Agent node, only for the search conversation

- **Where an agent and where not.** Spec 8.1 keeps routing deterministic and uses a tool-calling AI Agent node only
  where several steps depend on each other (Match, Trust, Legal RAG). Of the parts built so far, only Match is one of
  these: the user searches, changes the search ("cheaper", "closer to the faculty"), asks about one result. P1, P2,
  P3 and P7 stay single calls through `wf.llm.call`: each returns one JSON object against a schema, has a golden set
  and measured scores (T-40, T-44), and checks in code. An agent loop there would add calls and variation and make the
  scores incomparable. The gateway, API, jobs, ingestion, embedding and evaluation workflows have no reasoning step.
- **Shape** (`wf.match.agent`, migration 0015). AI Agent node (n8n 2.41.3, typeVersion 3.1) with three sub-nodes:
  Ollama Chat Model (`llm.default_model`, temperature 0, thinking off, credential `ollamaApi` from
  `OLLAMA_BASE_URL`), Postgres Chat Memory (one session per user), and two "Call n8n Workflow Tool" nodes:
  `search_listings` (`wf.match.tool_search`) and `listing_details` (`wf.match.tool_listing`). The system message is
  the active version of the new prompt `P6_match_agent` in the registry; the user's message goes between
  `<message>` tags as in the other prompts.
- **The search tool takes the request in words**, not filters. It runs P2 (`wf.profile.extract`) on what the agent
  wrote, then `wf.match.search`: the P2 checks (allowed preferences, currencies, geocoding) apply to agent searches
  too, and the agent's job is to write a complete request (for a follow-up, the earlier request with the change).
  Cost: a search turn makes four model calls (P1, agent, P2, agent) instead of two (P1, P2). Latency on the PC: not
  measured yet (`p4.ps1 -Step agent-bench`).
- **What the model sees and what the user sees.** Tool results hold listing fields only (rent, area, distance,
  furnished, availability...), never the owner's title or description (spec 8.2 A3 guardrail: owner prose could
  carry instructions). The result cards shown to the user come from the database (`app.public_cards`), not from the
  model's text. The answer is checked in code (`n8n/src/lib/agent_check.js`): a number of two digits or more that is
  not in the message, the memory or a tool result drops the answer (warning `agent_answer_unsupported`); the filters
  and cards are still shown.
- **Follow-ups.** P1 sees one message, so "moins cher" reads as smalltalk. With the agent on and a search by the same
  user in the last `match.followup_minutes` (30), a message P1 classifies as smalltalk or unclear goes to the agent.
- **Fallback.** Agent off (`match.agent_enabled`), no active P6 version, model error, no answer or too many
  iterations (`match.agent_max_iterations` 4): the fixed path runs (P2 then search) with the warning `agent_fallback`.
- **Memory.** n8n's node stores the whole turn (message, tool call, tool result, answer: 4 rows for a search) in
  `agent_memory.chat_histories`; the agent sees the last 2 x `match.agent_memory_turns` (6) messages. It receives the
  Text service's masked copy of the message (phone numbers, e-mails, names; a regex fallback if the service is down).
  Rows older than `match.agent_memory_days` (30) are deleted at each agent run, and withdrawing the privacy or terms
  consent deletes the conversation (trigger on `app.consents`). The table is alone in its own schema because the node
  runs `create table if not exists` before every use, which needs CREATE on the schema (F-062).
- **Trace.** One step `A3_match_agent` per message: prompt version, model, tools called with input sizes and result
  counts, answer length, dropped numbers, latency; no text (D-062). The node does not hand token counts to the
  workflow, so the step's tokens are stored as 0: not measured.
- **Evaluation** (`scripts/agent_bench.py`, `eval/datasets/match_agent_v1.jsonl`): 27 conversations, 42 turns, in
  French, English, Arabic and Tunisian in Latin letters: 12 single searches, 8 follow-ups, 5 questions about one
  result, 2 closings that need no tool. Per turn: path (agent, fallback, fixed), expected tool called, place, budget
  and move-in month of the search, answer kept, latency; then the first messages again on the fixed path. Labels
  written with the set, by me, not by a second annotator. Results on the PC (T-48): expected tool in 33 of 35
  agent turns, search fields as labelled in 20 of 23 paired first messages (fixed path 21 of 23), 6 of 8
  follow-ups handled, every answer kept by the number check; median latency 50 s against 24 s for the fixed path,
  with the model half on the CPU. The agent stays on by default: it adds follow-ups and questions about a result, which the
  fixed path cannot do, at the same field accuracy; the latency is the cost, and `match.agent_enabled` switches it
  off.

### D-085 Match agent answers: plain text, cut in code; P6 v2; conversation set v2

- **In code, whatever the prompt** (`agent_check.plainText`, `shorten`; migration 0016): Markdown is removed from
  the answer (bold, italics, headings, list markers, links; lines joined), then the number check runs, then an
  answer longer than `match.agent_answer_max_chars` (400) is cut at the last sentence end that fits (else at a word,
  with "…") and gets the warning `agent_answer_cut`. The trace step records the model's length, whether it wrote
  Markdown and whether the answer was cut. On the PC 3 of 35 answers had Markdown and the longest was 1,088
  characters (T-48), which Telegram showed as raw stars and long lists.
- **P6 v2** (`prompts/P6_match_agent/v2.md`): two plain sentences under 300 characters, no lists; the alphabet of
  the message (new variable `script`, from P1); Tunisian or Arabic in Latin letters answered in French in Latin
  letters; at most one search per message; `listing_details` whenever a result is named by its number, even if the
  list looks shorter. v1 stays active until both are run on the same set on the PC (`p4.ps1 -Step agent-bench`
  runs versions 1 and 2); v2 becomes active only if it keeps tool choice and search fields at least as good as v1.
  Result (T-50): v2 shortened answers (median 112 characters, no Markdown, right alphabet) and cut the median agent
  turn from 54 s to 40 s, but answered 2 of 7 numbered-result questions without the tool, so v1 stayed active.
  **P6 v3 is active** (T-51): v2 with `listing_details` required for those questions; 7 of 7 of them, answers as
  short and plain as v2. It misses the rule above by one turn (44 of 45 tool choices against 45 of 45: an extra
  lookup after "ok thanks"); accepted as an exception with the owner, because v3 equals or beats v1 on every other
  measure.
- **match_agent v2** (`eval/datasets/match_agent_v2.jsonl`, 30 conversations, 48 turns): v1 plus three fixes from
  T-48. The questions about one result now follow searches that found 9 or 10 listings on the PC, or the same search with a close budget (8 instead of 5;
  in v1 three of them followed searches with 0 or 1 result, so only 1 was scorable). The first messages of `f01` and
  `o01` start with "je cherche" (P1 sent "chambre à Ennasr, 500 dt" to another intent, so the follow-up was never
  tested). The 12 single searches are unchanged, including the 2 that P1 misroutes, to keep measuring that. The
  benchmark also reports, per answer, the alphabet against the message's, Markdown written by the model, cuts and
  lengths.

### D-086 Telegram photos: albums for /annonce, photo cards in search, all photos on request

- **Albums.** Telegram sends each photo of an album as its own message with the same `media_group_id`; only one
  carries the caption. Every photo of an album is kept in `app.telegram_album_items` (migration 0017, one day). The
  `/annonce` message waits `telegram.album_wait_s` (3 s), then takes the album's photos not taken yet, in message
  order (`app.telegram_album_claim`), and they go through the same presign, upload and analysis as one photo did
  (one upload slot per photo; at most `media.max_files_per_listing`, and Telegram's own limit of 10 per album). A
  photo of the album without the caption gets no reply when the album has `/annonce`; if none of the album's
  messages has it, the first photo gets the usual "how to post" hint once; a photo that arrives after the listing
  took its album is reported as not added. Not measured: how often a real album's photos arrive more than 3 s apart.
- **Photo cards under search results** (the first `telegram.search_photo_cards` = 3 results that have photos): the
  Media service draws one image (`/v1/images/card`): the first photo in full and, under it, the next ones (up to 3)
  blurred, with "+N" for the photos not shown in full. The bot sends it with n8n's Telegram node (photo upload)
  under the text answer, with a button "Voir les N photos" (callback `ph:<listing id>`). The strong blur on the strip
  is presentation only; every photo shown, in the card or later, is already the processed copy (EXIF removed, faces
  and text blurred, D-070); originals never leave storage.
- **All the photos** (the button): the Telegram relay sends them as one album. n8n's Telegram node uploads one file
  per message; its "send media group" takes Telegram file ids or public URLs only, and the photos are not public. The
  relay holds the bot token already, so it gets an internal endpoint (`POST /v1/send-album`, port 8099, internal
  token, no host port): it takes the processed copies from the Media service (`/v1/images/public`, keys under
  `media/` only, at most 1,280 px) and uploads them in one `sendMediaGroup`. n8n never builds a Telegram URL; the
  relay never logs URLs. Only photos of published listings (`app.listing_public_photos`, moderation ok or blurred).

### D-087 A5 Legal agent: an AI Agent over the knowledge base, answers only with citations

Asked by the owner after the Match agent (D-084), ahead of the phase order: spec 17 puts the Legal agent in phase 6,
and phase 4 is still open. Only the TN pack exists (plus global sources); FR and GB packs come later, from primary
sources fetched with their URL and date.

- **Shape.** Same pattern as the Match agent: n8n's AI Agent node (`wf.legal.agent`), the Ollama chat model
  (`llm.default_model`, thinking off, temperature 0), a Postgres chat memory in its own session
  (`legal:user:<id>`, so search turns and legal turns do not share context) and one workflow tool, `search_law`
  (`wf.legal.tool_search`). The router sends `legal_question` to it (Switch output 5) when `legal.agent_enabled`;
  off, the answer is "not available yet" as before. No fixed path behind it: when the agent fails the request
  answers 503. A message P1 reads as smalltalk or unclear goes to the agent of the most recent conversation
  (`app.agent_followup`, within `match.followup_minutes`).
- **Retrieval.** The best configuration measured in RETRIEVAL_EVAL (T-21): fixed_500_50 chunks, bge-m3, dense,
  top 5 (`legal.retrieval`), country plus global sources (`kb.search_chunks`). No reranker: none was built or
  measured. The query is the one the model writes (the prompt asks for legal wording); embedded through Ollama
  like the knowledge base; lexical if the embedding fails. Fixed chunks carry no article number, so the citation
  takes the article reference of the structure-aware chunk that overlaps it most.
- **Context size.** Five chunks of up to 500 tokens do not fit next to the system message, memory and answer in
  4,096 tokens, so the agent's calls use `legal.num_ctx` = 8192 and a memory of 2 turns (a turn with a search
  stores its excerpts). Not measured yet: the latency and GPU/CPU split this costs on the GTX 1650, and the reload
  when Ollama alternates between 4,096 (other prompts) and 8,192.
- **Numbering.** `app.legal_search` numbers the excerpts [1], [2], ... and stores them (`ai.legal_sessions`).
  Numbers continue across the messages of a conversation and an excerpt found again keeps its number, so a number
  the model sees in its memory still means the same excerpt. Excerpts of the current and the previous request are
  citable.
- **Output: text with markers, not the JSON of spec 10.6.** The AI Agent node's final answer is text, and asking a
  4B model to fill a JSON schema after tool calls adds a failure mode. The prompt (P5_legal_answerer v1) asks for
  plain text with [n] after each claim, `[NOT_FOUND]` when the excerpts do not answer, `[CONFLICT]` when they
  disagree. The structure is rebuilt in code (`legal_output.js`, `lib/legal_check.js`): markers of excerpts not
  retrieved are removed and the rest renumbered 1..k; `citations` carries title, URL, source type, reliability,
  article, retrieval date. `claims` and `positions` of spec 10.6 are not produced; the conflict flag is.
- **Abstention** (status `abstained`, `abstain_reason`): the model said `[NOT_FOUND]`; it answered without
  searching; no valid citation was left; or a number in the answer is in no excerpt, message or memory (a wrong
  delay or amount is worse than no answer). A similarity threshold (`legal.min_similarity`) can withhold weak
  excerpts; it is 0 (off) until tuned on the evaluation set as spec 10.6 asks: `scripts/legal_bench.py` records
  the best similarity of each question and what each threshold would have done.
- **Notice.** Every legal answer in Telegram ends with the notice (`legal.notice_version` = legal-notice-v1):
  general information from the cited sources, not legal advice, and for a dispute or an eviction a lawyer or a
  legal aid service. No organisation is named: none was checked.
- **Measured in the sandbox only** (mock model, T-53). The benchmark on the PC (`p4.ps1 -Step legal-bench`, the 48
  questions of tn_retrieval v2) gives the spec 10.7 figures: correct and false abstention, conflict on the 10
  contradiction questions, citation precision against the gold spans, latency; faithfulness by hand on a sample.

### D-088 Owner assistant: changes by conversation, proposed by an agent, written only after the owner confirms

Asked by the owner after the Legal agent. Spec 2.4 journey B step 6 says the owner sees what was extracted and can
correct it, and spec 5.2 lists `PATCH /v1/listings/:id`; neither existed. Both are built here, sharing one check.

- **Shape.** n8n AI Agent node (`wf.owner.agent`), the Ollama chat model (`llm.default_model`, thinking off,
  temperature 0, `llm.num_ctx`), its own chat memory (`owner:user:<id>`), two workflow tools: `my_listings` (the
  user's listings, numbered, most recent first; fields only, no title or description) and `propose_change` (listing
  number plus one text argument per field). Prompt P11_owner_assistant v1 (not in the spec's prompt list; the next
  free number). The router's `post_listing` goes to it when `owner.agent_enabled` and the user has listings;
  otherwise the "/annonce" hint as before. A message P1 reads as smalltalk or unclear goes to it when the owner
  conversation is the most recent one within `match.followup_minutes`; a listing created or changed in that time
  counts, so "le loyer est 350 DT" after a draft that missed its rent reaches it.
- **The model never writes.** `propose_change` checks the change (`app.listing_change_check`) and stores it as pending
  (`ai.listing_changes`, valid `owner.change_minutes` = 30). Nothing changes until the owner confirms: in Telegram a
  "Confirmer" button under the proposal, in the API `PATCH /v1/listings/:id` with `{change_id}`. Confirming checks
  again and applies once (409 afterwards). What the channel shows as the change comes from the database
  (before -> after per field), not from the model's sentence. A small model misreading "350" as a new rent shows up
  there before anything is written.
- **Checks, the same for PATCH and proposals** (in SQL): owner only (another user's listing is 404); known fields;
  rent and deposit in the currency's main unit and inside `listing.rent_range` (catches millimes, as D-076); dates
  from yesterday to two years ahead; a place must be found in the gazetteer of the listing's country and sets
  neighbourhood, city and location; amenities from P3's vocabulary; house rules smoking, pets, guests, parties only
  (no rule about persons); photos by number, oldest first, rejected ones not counted; status archived (rented,
  withdrawn) or published again for a listing that was published before. A draft is then tried for automatic
  publication (D-083, only when that setting is on).
- **After writing:** removed photos are deleted from storage (Media service); a published listing is embedded again
  when its place changed or it was just published. Every change is added to `extraction.owner_changes` and the
  audit log.
- **Not done:** title and description are not editable by the assistant or PATCH (owner prose; to decide with the
  frontend). No measurement on the real model yet: `scripts/owner_bench.py` (24 requests of
  `eval/datasets/owner_agent_v1.jsonl`, labels written by me) scores the proposals.

### D-089 After the first PC runs: the question is searched before the Legal agent; P5 v2, P11 v2; "my listing" routing

From T-55 (Legal agent, P5 v1) and T-56 (owner assistant, P11 v1) on the owner's PC.

- **Legal agent: retrieval first.** With v1 the model decided whether and what to search. It did not search for 6 of
  the 39 answerable questions that reached it (5 of the 6 in Arabic), and the queries it wrote found a gold passage
  for 18 of the 33 it searched; the user's question itself, in the same configuration, had hit@5 0.795 (T-21). When
  a gold passage was retrieved the model answered 17 times out of 18, and 16 of the 17 answers cited it (16 of 17 answers had a relevant
  citation); when none was retrieved it abstained every time. So the losses were in the search, not in the answer.
  From now on `wf.legal.agent` searches the (masked) question before the model runs (same `app.legal_search`,
  same numbering) and puts the excerpts in the system message (`{{excerpts}}`, not stored in the memory). search_law
  stays for a second search with other words. This is the plain retrieve-then-answer pattern with one optional
  agent step; the agent no longer decides whether to look.
- **P5 v2:** the excerpts in the message; search_law only when they do not answer; a definition of disagreeing
  sources (conflict raised on 1 of 10 contradiction questions with v1). Active for the next measurement; v1 stays
  stored (`scripts/prompts.py activate P5_legal_answerer 1` to go back).
- **P11 v2:** v1 got 13 of 15 changes exactly right, refused the rent in millimes, and kept 3 of 4 messages without a
  change. Its errors: "pas d'animaux" became pets=yes (the prompt's example was "smoking=no, pets=yes", also in the
  tool description); "colocataire femme uniquement" became four house rules nobody asked for, and the answer said it
  had added "femme uniquement"; "statut archived" in a French answer; "mfarcha" not read as furnished. v2 writes rules
  as allowed / not allowed with a neutral example, refuses rules about who may live there without calling the tool,
  says the status in words, lists a few Tunisian words, and says "proposed", never "done". Active for the next run.
- **"My listing" goes to the owner assistant.** P1 sent 4 of the 24 owner requests elsewhere (Legal agent twice, the
  search, report_problem). A message that names the user's own listing ("mon annonce", "my listing", "annonce mte3i",
  "إعلاني") from a user who has listings now goes to the owner assistant whatever P1 said (warning `own_listing`).
  This would have caught 3 of the 4 ("La caution de ma chambre..." names no listing). A legal question that says
  "mon annonce" would also go there; not measured.

### D-090 Telegram: a slow listing analysis still gets its result

Seen on the owner's PC (2026-10-12): an `/annonce` with 3 photos was still being analysed after `telegram.job_wait_s`
(300 s); the bot said so with the listing id and stopped, so the owner never saw the result. Why it took that long
is not measured yet (the job's steps are in `ai.agent_steps`; RUNBOOK has the query). Now the bot says once that it
is slow (photos are analysed one by one) and keeps polling every 10 s; the result is sent when the job ends. It stops
after `telegram.job_wait_max_s` (1800 s, migration 0020) with the listing id, as before.

### D-091 Timing the model calls of a listing analysis before changing anything (F-064)

A 3-photo listing took 14 minutes on the PC and every vision call hit the 120 s timeout (F-064). Possible fixes pull
in different directions: smaller vision copies (fewer image tokens), a longer `llm.timeout_ms` for P7, analysing fewer
photos, or keeping P7 off for Telegram listings. Choosing without figures would be a guess, so `scripts/p7_timing.py`
(`p4.ps1 -Step p7-timing`) first measures the same calls one at a time without the timeout and reports Ollama's own
durations (load, prompt evaluation with the prompt's token count, generation) at 512, 768 and 1024 px.

### D-092 P5 v2 and P11 v2 stay active; dinars written with millimes

T-60 against T-55: false abstention 0.564 to 0.205, gold retrieved 18 to 28 of 39, conflicts on contradiction
questions 1 to 5 of 10, correct abstentions unchanged (3 of 3). The cost: 6 of 31 answers cite only excerpts outside
the gold (1 of 17 before), to be judged by hand. T-61 against T-56: routing 20 to 23 of 24, the two v1 errors fixed,
one new wrong value (o-23). Both v2 stay active (spec 9.5: better on the primary measure; the regressions are listed).
The owner tool now reads "450.000" as 450 (dinars with their millimes, as written in Tunisia) and keeps "1.225" and
"1.225.000" as thousands.

### D-093 "Le loyer est 350 DT" after posting goes to the owner assistant

On the PC (2026-10-16) the bot ended its reply to a listing without a rent with "Just write it (for example 'the
rent is 350 DT')"; the owner wrote "le loyer est 350 DT" and P1 read it as a search, so it got 10 search results.
The follow-up rule did not apply (it covers messages P1 calls smalltalk or unclear), nor the "my listing" rule (no
"mon annonce"). Now, within `match.followup_minutes` of a change to one of the user's listings (`app.owner_recent`,
migration 0021), a message P1 calls a search goes to the owner assistant when it names a listing field (loyer, kra,
rent, caution, dépôt, garantie, prix, الكراء...), contains a number, and does not ask to search (cherche, looking,
n7eb...). "Je cherche une chambre, loyer 380 dt" still goes to the search. Not measured on the real model yet.

### D-094 Phase 4 closed by the owner without ASR, video frames, PDF extraction and the P7 benchmark

Decided by the owner on 2026-10-16. Spec 17 closes phase 4 when "ASR benchmark table exists" and "photo pipeline tests
pass"; the second is met (Media service tests, verify.ps1), the first is waived: no ASR service is built. Also not built:
frames from walkthrough videos, text extraction from PDFs, and the P7 accuracy benchmark on the PC (P7 runs in the
listing analysis; its accuracy is not measured, only its time, T-59, T-62). Consequences: the bot answers a voice note
that voice notes are not supported (it used to say "coming soon"); uploads of kind audio, video and pdf stay accepted by
the API (presign) but are not analysed. What phase 4 delivered: Text service (language, PII masking), Media service
(validation, EXIF, perceptual hash, face and text blur), P3 and P7 in the listing analysis, the Telegram channel
with albums and photo cards, and, ahead of their phases or outside the spec, the Match agent (D-084), the Legal
agent (D-087, D-089) and the owner assistant (D-088). Evidence: TEST_REPORT T-41 to T-63.

### D-095 Platform plan: the website and the new features (P0)

Proposed and approved by the owner on 2026-10-16 ("lets start"). The plan is `docs/PLATFORM_SPEC.md`. Main choices:

- **Scope grows past spec 2.5.** In-app messaging and the household after move-in (expenses, chores, documents,
  moving out) were non-goals of the backend phase; the owner's platform goal brings them in. Payments, online
  signing and 3D stay out.
- **Row-level rules that bind n8n too.** `n8n_worker` bypasses RLS, so the new schemas (`social`, `home`, `notify`)
  give it no table rights. It calls `SECURITY DEFINER` functions owned by a role without `BYPASSRLS` that set
  `app.user_id` first; forced RLS policies then filter every row (PLATFORM_SPEC 7.1).
- **Website stack:** Next.js as pages and BFF in one server, Better Auth self-hosted with its own database, Tailwind
  and shadcn/ui in RTL mode, MapLibre with a local PMTiles extract, next-intl (fr, en, ar). Hosted auth (Clerk, Auth0)
  was rejected because account data would leave the machine; Keycloak because it is one more heavy service on the PC.
- **Two new AI Agent nodes:** the Trust agent (A4, spec phase 5) and the Document agent (A6). Both have no write
  tool; scores, verdicts and documents are produced by fixed nodes. Compatibility, splits, balances and reminders are
  SQL, with no model; private messages are not sent to a model.
- **/v1 is not changed.** More search filters are `GET /v2/search`; a public listing view is a new path
  (`GET /v1/listings/{id}/public`) because `GET /v1/listings/{id}` stays the owner view.

### D-096 Platform P1: row-level rules that bind n8n, and one API function per endpoint

- **Why.** `n8n_worker` has `BYPASSRLS` (spec 5.4), so the RLS policies of migration 0001 never applied to what a
  workflow reads. For households, messages and applications that is not enough: a wrong `WHERE` in one workflow would
  show another user's data.
- **How (migration 0022).** Platform tables go in schemas `social`, `home`, `notify`, on which `n8n_worker` has no
  privilege at all. Workflows call functions in schema `api`; each is `SECURITY DEFINER`, owned by `app_rls` (a role
  without `BYPASSRLS`), and starts with `api._as(user)`, which sets `app.user_id` for the transaction. The tables have
  RLS enabled and forced, with policies on `app.current_user_id()`. `app_rls` also reads a few app tables
  (`app.profiles`, `app.consents`, `app.listings` columns) through their existing policies. pgTAP checks: `n8n_worker`
  and `api_user` are refused on the tables; every `api` function is owned by `app_rls` and not executable by PUBLIC;
  one user's ids do not touch another user's rows (`db/tests/190_platform_foundation.sql`). Erasing a user deletes
  their notifications (trigger on `app.users.deleted_at`).
- **Endpoint shape (`n8n/build_platform.py`).** Each endpoint is its own workflow, as before: webhook, route, gateway,
  a shared validator (`platform_validate.js`, the endpoint's rules written into it at build time), one call
  `select api.<fn>(user, input)`, a shared result node, the usual envelope. The function returns `{status, data}` or
  `{status, error}`. Workflows that do more than one call (notifications to others, storage, jobs, agents) are written
  out node by node in later phases. Whether this is "logic in n8n" was weighed: the rules that touch private rows sit
  in SQL so that RLS covers them, which is how search, listing checks and owner changes already work (D-088); the
  steps, side effects and agents are n8n nodes.
- **New endpoints:** `GET /v1/me` (no consent needed: it says which consents are missing), `GET /v1/profiles/me`,
  `GET /v1/me/notifications`, `POST /v1/me/notifications/read`. The notification endpoints were planned for P4; they
  came now because the first `notify` table needed a reader to prove the layer through the API.
- **Response fields of platform endpoints.** A platform endpoint may gain optional response fields in a later phase
  of the plan (for example `counts.households` in P5); it never loses or changes one. A change of behaviour or of an
  existing field goes to `/v2`, as the owner asked. `/v1` endpoints from before the platform are not touched.
- `GET /v1/me` lists the countries the website offers from the setting `platform.jurisdictions` (TN, FR, GB), plus the
  user's own, with the currency exponent clients need to enter amounts. `app.jurisdictions.active` is false for all
  three and could not be used.

### D-097 Platform P1: the proxy in front of the website, generated routes, browser uploads

- **The website behind Caddy.** Browsers reach the website on port 3000 of the proxy, not the web container. Caddy
  drops forwarding headers sent by clients and sets `X-Forwarded-For`, so the website server knows the visitor's
  address and sends it signed as `X-Client-Ip`. Without this, every website user would share the website container's
  address and the API's per-IP limit (120 a minute).
- **Generated rewrites.** `n8n/build.py` writes `infra/caddy/routes.caddy` (one rewrite per route with a path
  parameter, with its method) from the workflows, and `python3 n8n/build.py --check` fails when it is out of date. The
  Caddyfile imports it. The seven hand-written rewrites moved there unchanged except for an explicit method. Full
  contract suite unchanged after the move (T-64).
- **CORS for uploads (spec 17.1).** The proxy answers the browser's `OPTIONS` on `/<bucket>/uploads/*` for
  `WEB_ORIGIN` only, method PUT, header Content-Type, and sets `Access-Control-Allow-Origin` on the PUT answer with
  `header_down`, which replaces whatever the storage sends (F-065). A Chromium page on the website's origin uploads;
  the same page on another origin is blocked (`web/e2e/upload-cors.spec.ts`).

### D-098 Platform P1: website choices made concrete

- **Versions.** Each npm package is pinned to the newest release published at least seven days before 2026-10-16,
  except Next.js 16.4.1 and React 19.3.1, the releases of the Next.js security update of 2026-10-14 (two critical
  remote code execution issues). `sharp` resolved to 0.35.5, the version that advisory names. Image optimisation is
  off anyway (photos are already processed by the Media service). `typescript` stays on 5.9.3: 7.x is a rewrite that
  Next.js does not document yet. Node 24.21.0 (image `node:24.21.0-bookworm-slim`).
- **npm peer dependencies.** `npm install` stopped with an internal error while resolving Better Auth's optional peer
  dependencies (F-066). `web/.npmrc` sets `legacy-peer-deps=true`; peers the project needs are listed directly
  (`vite` for Vitest).
- **Accounts.** Better Auth with e-mail and password, e-mail confirmation required, password reset, 10 to 128
  characters, sessions 14 days, its own rate limit. Its database `auth` and role `auth_app` are created by
  `db-bootstrap.sh` with `CONNECT` revoked from PUBLIC. Its tables are created at server start (`instrumentation.ts`,
  with the running options, so they cannot drift). After login the website calls `POST /v1/users/sync` with
  `external_auth_id = web:<id>` and stores the platform id on the auth user (`platformUserId`, not settable by users).
  The sync's idempotency key is a hash of what is sent, so an unchanged sync returns the stored answer.
- **Forms without client-side rules.** Pages are server components; forms post to server actions, which call the API.
  Every state-changing form carries an idempotency key made when the page is shown. The only conversion in the website
  is amounts between main and minor units, with the exponent `GET /v1/me` gives for the currency (the API's `Money`
  contract asks clients to do that).
- **Type and colour.** IBM Plex Sans and IBM Plex Sans Arabic (one family drawn for both scripts, SIL OFL, served by
  the website) instead of the Noto pair named in PLATFORM_SPEC 6.4. Colours of a lime-washed flat (page), plan ink
  (text), a cobalt door (actions); one drawing, the floor plan with the free room, on the account pages. Logical CSS
  classes only, checked by a unit test that fails on `ml-`, `left-`, `text-right` and the like.
- **Terms and privacy pages** describe what the platform does (data kept, local models, photo processing, 30-day
  masked assistant memory, D-084). They are marked as drafts not reviewed by a lawyer; policy version `draft-2026-10`
  is what the consent records.
- **Mail in development:** Mailpit (`axllent/mailpit:v1.31.4`) catches every mail; `SMTP_*` in `.env` points the
  website at a real mail account later.

### D-099 Platform P2: search v2, the public listing page, photos for browsers, favourites, cancelling a proposal

- **`GET /v2/search`.** The parameters and rules of `GET /v1/search`, plus `kind`, `furnished`, `bills_included`,
  `available_by`, `amenities` (all of them, from the vocabulary of listing changes), `house_rules` (`name:yes|no`),
  `bbox` (the map's visible area, at most 90 degrees each way; first 10, raised by F-075), `ids` (cards of known listings in the order given:
  the website shows the assistant's results with it) and `cursor`. `GET /v1/search` and `app.search_public` are not
  changed; v2 has its own function, `app.search_public_v2` (migration 0023).
- **Pages.** Results are cut from one ranked list by offset. With text, each ranking (meaning, words) takes the best
  `search.v2_candidates` (200) before fusion, so pages go as deep as the candidates. The cursor is opaque
  (`o<offset>.<fingerprint>` in base64url); the fingerprint is a hash of the other parameters, and a cursor sent with
  other filters is refused (`invalid_cursor`), so one page can never mix two searches. `meta.next_cursor` is null on
  the last page. `total_matching_filters` counts the published listings that pass the filters (the text ranks them; it
  does not exclude any).
- **An unknown date does not match a date filter.** `available_by` returns only listings whose date is known and not
  later. Treating "no date" as "free now" would be a guess.
- **Photos for browsers.** Photos stay private objects. The Media service signs short GET URLs
  (`POST /v1/storage/presign-get`, only keys under `media/`, the processed copies with EXIF removed and faces and
  text blurred; never `uploads/`). They are valid `media.photo_url_ttl_s` seconds (900). The proxy passes `GET` and
  `HEAD` under `/<bucket>/media/` only when the query carries a signature; the storage checks the signature and the
  expiry. In the sandbox the S3 stand-in checks neither, so the tampered and expired cases run on the PC only
  (`test_photo_url_is_refused_when_tampered_or_expired`). If the Media service does not answer, results come without
  photos and `warnings` holds `photos_unavailable`; the request does not fail.
- **`GET /v1/listings/{id}/public`.** A published listing, or the caller's own in any state (a preview). Anything else
  is 404 whether it exists or not. Public fields only: no exact point, no owner id, no storage keys.
- **Favourites** (`social.favourites`) behind the row-level layer of D-096: `PUT` and `DELETE
  /v1/me/favourites/{listing_id}` (both idempotent; only a published listing can be saved; at most `favourites.max`,
  500) and `GET /v1/me/favourites`. A favourite whose listing is withdrawn stays in the list as `available: false`,
  so it can be removed. Search results and the listing page carry `is_favourite`, read through
  `api.favourite_flags`, which also runs as the caller. Erasing a user deletes their favourites.
- **The PUT carries `{}`.** The gateway asks every POST, PUT and PATCH for a JSON object body. That rule belongs to
  `/v1` and stays; a favourite PUT sends an empty object.
- **`POST /v1/listing-changes/{id}/cancel`.** The website's Cancel button under an owner-assistant proposal. Someone
  else's proposal, or none, is 404; one already applied, cancelled or failed, or older than `owner.change_minutes`,
  is 409 with the reason in `details`. The Telegram button keeps `app.listing_change_cancel`.

### D-100 Platform P2: the map

- **Tiles from our own server.** MapLibre GL JS draws the OpenStreetMap basemap of Protomaps from one PMTiles file per
  country (`geo/tiles/<country>.pmtiles`), served by the proxy on the website's own origin at `/tiles/`. The map reads
  it with range requests. No outside tile server sees which area a person looks at, and the browser needs no CORS
  rule. The glyph files (Noto Sans: Latin, Greek and Arabic ranges) and the icons of the Protomaps style are committed
  in `web/public/map` with their licences. MapLibre's worker is copied there from `node_modules` before each build, so
  the page loads scripts from its own origin only (CSP `worker-src 'self'`).
- **No right-to-left plugin.** MapLibre 6 shapes Arabic and orders mixed text itself (its type definitions mark
  `setRTLTextPlugin` as deprecated for that reason), so the plugin planned in PLATFORM_SPEC 6.5 is not used.
- **The file is made on the PC.** The sandbox cannot reach build.protomaps.com. `scripts/windows/map.ps1` downloads
  go-pmtiles 1.31.2 (checked against a pinned SHA-256), finds the newest daily build and cuts the country's box at zoom
  0 to 14 (`-MaxZoom 15` for full detail). The file size is written in the script's log; it is **not measured** yet.
  Without the file, the search page says the map is not installed and keeps the list.
- **Markers** are the listings' public points (moved by the database away from the address). "Search this area" puts
  the visible area into the page's address (`bbox`), and the server searches again. On the map view the filter form
  folds away so the map is in view on a phone.

### D-101 Platform P2: website pages and how they are tested

- **Pages:** `/search` (a plain GET form, so a search is an address that can be bookmarked; list or map; next page by
  cursor), `/listings/[id]`, `/favourites`, `/assistant`. The assistant page calls `POST /v1/assistant/message`, then
  `GET /v2/search?ids=` for the cards of the results (cover photo, favourite), shows legal answers with their
  numbered sources and the same notice as Telegram, and owner proposals with Confirm (`PATCH /v1/listings/{id}` with
  `change_id`) and Cancel. The conversation stays in the browser tab (D-062). The server action waits up to 240 s,
  above the agents' measured p95.
- **A photo that cannot be loaded** (expired link, object missing) shows the "no photo" panel instead of a broken
  image.
- **End-to-end data.** Publishing through the API comes with P3's submit, so the website tests publish their own
  listing directly in the database, as the contract tests do. Its two photos go through the normal path (presigned
  upload, analysis job with `vision.enabled` off for the run). `verify.ps1` gives the Playwright container the
  `n8n_worker` connection, read from `.env` and not written to the log.
- **One sign-up per run.** Better Auth limits auth requests per address (30 a minute, D-098). Eight sign-ups in a row
  from one address got 429 on the confirmation link, so the P2 tests sign up once and share the session cookies.
- **Build log.** `next build` analyses the pages without the server's environment, and Better Auth logged a "default
  secret" error for each (T-65's image build). During the build only, the secret falls back to a fixed placeholder;
  at run time compose still refuses to start without `BETTER_AUTH_SECRET`. Checked in the sandbox: 2 such lines
  without the change, 0 with it.

### D-102 Platform P3: owners post, publish and manage their listings

- **`POST /v1/listings/{id}/submit`** (new, additive). Only a draft is submitted. It needs a rent, a place found on
  the map (the exact point the owner gave with PATCH, else the neighbourhood then the city through the gazetteer)
  and at least one photo that was not rejected; what is missing comes back as 422 details
  `{field: rent | place | photos, issue: required | place_not_found}`. An analysis job still queued or running gives
  409 (`{field: analysis, issue: running}`), so the owner does not publish fields the analysis is about to rewrite.
  A published listing submitted again answers 200 with the same data and writes nothing, so a retry without the
  idempotency key is harmless. Any other status is 409 `status_not_allowed`; an archived listing goes back with
  `PATCH {status: published}` as before (D-088). Publication sets the title (the first line of the text, as the
  automatic publication of D-083 does), the exact point (never shown) from which the public point is fuzzed, an
  `extraction.publication` record (`mode: owner`, `checked: false`, the analysis issues still open), an audit row
  and the owner's notification `listing_published`. The listing is embedded in the same request; if the embedding
  fails it stays published with the warning `embedding_pending`, the embed job fills it later. From P8 the trust job
  takes the place of the direct publication (PLATFORM_SPEC 3.5); `listing.auto_publish` stays off for the website.
- **Why a photo is required.** A listing without a photo is what the trust work of P8 flags first, and the done-when
  of P3 has three photos. It is one rule in `app.listing_readiness`, easy to change.
- **Analysis issues after corrections.** The issues of the analysis are kept as they were found. What the owner
  still needs to look at is computed: an issue no longer applies once the owner set the field it is about
  (rent: scope, assumed currency, unknown range; deposit; available date; furnished and amenities against the
  photos), and the rent issues no longer apply once there is a rent. The others (for example a phone number in the
  text) stay shown; they do not block publication.
- **`GET /v1/me/listings`** (new). `app.owner_listings` is the owner assistant's numbered view, and it writes the
  numbering into the assistant's session, so it is not reused as such. `app.me_listings` reads the same order
  (newest first, rejected ones left out, first 10) and returns the same number, so "annonce 2" in the panel means the
  second card of the list. Rent as `Money`, what each draft still needs, the last analysis job, and the actions that
  apply (`edit`, `analyze`, `submit`, `archive`, `republish`, `view`) so the page shows buttons without knowing the
  rules. Paging by `cursor` (`<created_at in µs>_<id>`) and `meta.next_cursor` (PLATFORM_SPEC 8); filters `status`
  and `listing_id` (the posting page reads one listing this way).
- **These functions are in schema `app`, not `api`.** `app.listings` is a table from before the platform, which
  `n8n_worker` reads and the existing listing workflows write. The functions check the owner themselves and answer
  404 for anyone else's listing (rule 2.5); pgTAP and contract tests check both directions. No new table in P3.
- **D-077's open point closed.** `app.store_listing_extraction` no longer overwrites a column the owner changed
  (from the diffs in `extraction.owner_changes`), and keeps `owner_changes` and `publication` when the new analysis
  replaces the rest of `extraction`. It records which columns it kept in `kept_owner_fields`.
- **Website.** `/owner/new` (text and country), `/owner/listings/[id]` (photos with the photo consent asked on the
  spot when it was not given at sign-up, analysis with its progress, the fields to check with only the changed ones
  sent to PATCH, publication, then archive and publish again), `/owner/listings` (tabs by status, the owner assistant
  panel). The browser sends the photo bytes to the presigned URLs itself. The Playwright test runs with
  `vision.enabled` off, like the P2 tests, and with a test place of its own in TN, because the gazetteer differs
  between the PC and the sandbox.

### D-103 Platform P4: messages, blocks, visits, applications, reports

- **19 new operations, all additive** (openapi.yaml): `POST/GET /v1/conversations`, `GET/POST
  /v1/conversations/{id}/messages`, `POST .../read`; `POST/GET /v1/me/blocks`, `DELETE /v1/me/blocks/{user_id}`;
  `GET/PUT /v1/listings/{id}/visit-slots`; `POST /v1/visits`, `GET /v1/me/visits`, `POST /v1/visits/{id}/decision`;
  `POST /v1/listings/{id}/applications`, `GET /v1/me/applications`, `GET /v1/owner/applications`,
  `POST /v1/applications/{id}/decision`, `POST /v1/applications/{id}/withdraw`; `POST /v1/reports`. Each is one
  `wf.api.*` workflow of the standard platform shape (validator, one `api.*` call).
- **Row-level layer** (D-096) for the eight new tables of schema `social` (7.2): RLS enabled and forced; `n8n_worker`
  has no privilege; the functions run as `app_rls` with the caller set. The policies are 7.3: a conversation and its
  messages for its members (membership through the helper `social.my_conversations()`, owned by the migration's
  superuser so a policy never queries its own table); visits and applications for their two parties; a block for
  both people involved (the blocked side is told "blocked" anyway); visit slots readable by all (only the times, never
  who booked). Counting a slot's bookings across seekers goes through `social.slot_taken()` for the same reason.
- **Someone else's resource answers 404**, also for blocking or reporting a user the caller has no conversation,
  visit or application with, so user ids cannot be probed. Wrong role answers 403 (the applicant accepting, the owner
  withdrawing). A block answers 409 with `{issue: blocked}` (no new error code, PLATFORM_SPEC 8).
- **Conversations are about a listing** in P4 (`kind: listing`); one per seeker and listing, reused when the seeker
  writes again. The other kinds (application, household, direct) come with P5 and P7.
- **Visits.** The owner gives slots (at most `visits.max_slots`, each up to 12 h, within 180 days; a booked slot is
  kept when the list is replaced). A request takes a slot; the side that did not ask for the current time confirms or
  declines; either side proposes another time (the slot is then released) or cancels; the owner marks a past
  confirmed visit done or no-show. Each visit carries the actions the caller can take now, so the page shows buttons
  without knowing the rules. One open visit per seeker and listing.
- **Applications.** One open application per applicant and listing (unique partial index). With "share my profile",
  the lifestyle fields of the applicant's profile are copied (preferences, languages, dates, budget), never free
  text (rule 2.6). Accepting only records the decision; the household invite comes in P5. Decisions go to the audit
  log.
- **A block ends what is open between the two:** open visits are cancelled, an open application is withdrawn
  (`decision_code: blocked`), and neither side can write, ask for a visit or apply.
- **Spam limits** (PLATFORM_SPEC 8): `messages.per_minute` (20) and `reports.per_hour` (10), checked in the functions,
  429 with `retry_after_s` like the gateway's limit. The numbers are a starting choice, not measured.
- **Reports** are stored in `app.reports` with the new columns of 7.2 (target type, user, message, status `open`);
  the moderation pages and triage come in P8. A reporter can only report what they can see.
- **Notifications** to the other side at each step: `message_received`, `visit_requested`, `visit_confirmed`,
  `visit_proposed`, `visit_declined`, `visit_cancelled`, `application_received`, `application_accepted`,
  `application_declined`, `application_withdrawn`. The notifications page now fills their parameters and links to
  the conversation, the visits or the applications.
- **Erasure** (7.4): the user's messages are blanked (rows kept for reports), blocks removed, open visits cancelled,
  applications withdrawn with their message and shared profile cleared, conversations left.
- **Website.** On a published listing: write to the owner, ask for one of the visit times, apply, report. `/messages`
  and `/messages/[id]` (read when opened, block, report the other's last message), `/visits`, `/applications`, and
  the visit times on the owner's listing page.
- **Tests and one address.** The two-browser test runs both people from one address, so it clears the per-address
  counters of the API's limit before it starts and before the block step, as the contract tests do (F-045). People
  behind one shared address in real use share that limit too; not measured (same risk as F-072).

### D-104 Platform P5: households, money, rent and bills, announcements

- **18 new operations** (openapi.yaml), all additive: households (create, mine, get, invite, accept, leave), expenses
  (list, add with `preview`, delete), balances, settlements, recurring rent and bills (get, put), rent payments
  (record, list, confirm by the owner member), announcements (list, post). One `api.*` function each, as in P4.
- **Ten new tables in schema `home`** behind the row-level layer. The policies follow 7.3: every member (the owner
  member included) sees the household, members, rent and bills, rent payments and announcements; only flatmates see
  expenses, shares, balances and settlements. Membership helpers `home.my_households()` and
  `home.my_flatmate_households()` are superuser-owned and only answer about the caller.
- **Invites.** A code of 12 characters taken from a random UUID (122 random bits), shown once; only its SHA-256 is
  stored. Valid `household.invite_days` (7) days, usable once. Redeeming a code is done by
  `home.redeem_invite()`, superuser-owned because the person redeeming is not a member yet and so cannot see the
  invite under RLS; it checks the code, the date, the use, and adds only the caller. An application the owner accepts
  becomes a personal invite (no code) when the listing belongs to one of the owner's households.
- **Money is in minor units** with the household's currency (from its country) and the exponent from
  `app.currencies`; the website converts what people type. Nothing moves money (rule 2.8).
- **Splits** (`api.split`, pure SQL): equal gives each the integer part and the leftover minor units one by one in
  join order; shares divide by weights the same way (a zero weight gets nothing); exact amounts must sum to the
  total. The shares are written with the expense in the same function, so the sum always equals the amount (pgTAP
  checks 90 cases: 2 to 6 people, six awkward amounts, three modes).
- **Balances**: paid minus owed, plus settlements paid, minus settlements received (positive: the others owe you).
  **Suggested settlements** (`api.settle_plan`): the largest debtor pays the largest creditor until every balance is
  zero, so at most n - 1 transfers. A deleted expense is kept (audit) and leaves the balances.
- **Leaving** sets the membership to `left`: the person sees nothing of the household any more; what they paid or
  shared stays, so the others' balances stay right.
- **Reminders.** `wf.household.daily` runs at 05:00 UTC and calls `home.daily_reminders()`, which acts for nobody
  (7.1), works in each household's own date (its timezone), reminds the flatmates `remind_days_before` days before
  each due date, once per item and due date (`home.reminder_log`), and returns counts only. Tests pass a date, or set
  `household.today_override` (tests only); the workflow itself only calls the function.
- **Rent payments** are recorded by a flatmate and confirmed by the owner member (receipts in P9 only for confirmed
  ones). Without an owner member nobody confirms.
- **Website**: `/households`, `/join/[code]`, `/households/[id]` (members, invite code, balance, coming up,
  announcements, leave), `/households/[id]/money` (expenses with a preview of the split, balances, settle-up),
  `/households/[id]/bills` (recurring items, rent payments, confirmation).

### D-105 Platform P6: chores, shopping list, house rules, calendar, repairs

- **17 new operations** (openapi.yaml), additive: chores (list, add, change, mark a turn done), shopping list (list,
  add, tick), house rules (get, put), calendar (get between two dates, add and delete an event), issues (list, report,
  update, photo upload URLs, photo processing). Eight new tables in `home`, behind the row-level layer.
- **Who sees what** (7.3): chores and the shopping list are the flatmates'; house rules, the calendar's own events and
  repairs are every member's, the owner member included. The calendar of the owner member therefore has no chore
  turns (the RLS of the chores decides it, not the calendar function).
- **Chore rota.** A chore has a rotation (flatmates in turn order) and a next date. `home.daily_chores()`, run by
  `wf.household.daily` after the reminders, gives every due date to the person after the last assignee among the
  flatmates still living there, once per chore and date, and moves the next date on by the frequency (daily, weekly,
  every two weeks, monthly). Someone who leaves is skipped from then on; their past turns stay.
  `home.next_in_rotation()` is superuser-owned like the membership helpers, because the daily job acts for nobody.
- **Calendar**: nothing is copied; the function merges the household's events with what it computes for the range
  (rent and bill due dates, chore turns, members' move dates, the caller's own confirmed visits). At most 92 days at
  once.
- **Repairs**: reported by any member; the owner member is told first (`issue_reported_owner`). The owner member
  moves an issue to acknowledged, in progress or resolved; flatmates comment, close it, or open it again; any other
  change for the role is 403. Each change is kept in `issue_events` and notified to the other members.
- **Issue photos** use the same Media service and storage rules as listing photos, not the listing intake workflow
  (which is tied to listings): upload slots under `uploads/issues/`, presigned PUT URLs, then one call processes each
  photo (type and size checked, EXIF read then removed, faces and readable text blurred) into `media/issues/`, and the
  raw uploads are deleted. The list returns signed GET URLs of the processed copies only; at most `issues.max_photos`
  (6) per issue.
- **Website**: `/households/[id]/chores`, `/shopping`, `/rules`, `/calendar`, `/issues` (with photo upload), and a
  section menu that hides what the owner member cannot open.

### D-106 Platform P7: flatmate profiles, compatibility, rooms posted by a household, saved searches

- **8 new operations** (openapi.yaml), additive: the caller's flatmate profile (get, put), browse flatmates (list, one),
  saved searches (list, save, delete), and `POST /v1/households/{id}/room-posts`. Applications gain an optional
  `compatibility` field on the owner side. Three new tables in `social` behind the row-level layer.
- **Compatibility** is `social.compatibility(a, b)` in SQL. It reads an allowlist only: the lifestyle answers of the
  search profile (`declared_preferences`: schedule, cleanliness, smoking, pets, guests, quiet hours), languages, the
  budget range (same currency and period), the move-in date (30 days apart or less is a match, setting
  `compat.move_in_days`) and the distance between the two anchors (setting `compat.distance_km`). A missing answer on
  either side is "unknown": it is left out of the score, never counted as a mismatch, and shown as "not said". The score
  is the weight of the matching factors over the weight of the known ones, 0 to 100; with nothing known it is null,
  not 0. The bio and the headline are shown as written and never read by the function (rule 2.6); a pgTAP test changes
  the name, e-mail, language, free text and bio and checks the result does not move.
- **Weights** (`compat.weights`): schedule 15, cleanliness 15, smoking 15, pets 10, guests 10, quiet hours 10,
  languages 10, budget 10, move-in 5, distance 0. A starting choice by hand, **not measured** against any outcome.
  Distance is 0 until the website lets people set an area on their profile; a factor with weight 0 is not shown.
- **With a household**, `social.compatibility_household` is the average over its active flatmates. The owner of a
  listing linked to a household sees it on an application, only when the applicant shared their profile.
- **Who appears**: visible profiles of the caller's country (or `jurisdiction=XX`), not the caller, nobody either side
  blocked (policy on the table, so `GET /v1/flatmates/{id}` answers 404 the same way). The list is ordered by score,
  then most recently updated; the cursor is an offset (meta.next_cursor). Computing the score for every visible profile
  on each page is fine at the demo's size; **not measured** beyond it.
- **No message button on a profile.** A conversation still needs a listing (`POST /v1/conversations`, D-103). Opening
  conversations between two people without a listing would change that endpoint; left for a later version.
- **A room posted by a household**: `home.room_post` (superuser-owned, like the membership helpers) checks the caller is
  an active member, refuses a second open listing (409 `already_posted`), creates the draft with `app.listing_create`,
  sets `current_flatmates` and links it to the household. The draft is then finished on the owner pages like any
  other (photos, analysis, submit), so the trust checks of P8 apply to it too.
- **Saved searches**: the website sends the `/v2/search` parameters it used; the workflow checks them with the same
  code (`lib/search2_query.js`) and stores them with the function's parameters. No page, ids, map area or profile
  defaults are saved (a profile can change; the alert must not). At most `saved_searches.max` (10) per user.
- **Daily alert**: `social.daily_alerts()` runs in `wf.household.daily` after the chores. For each search with alert
  daily, at most once in 20 hours, it runs `app.search_public_v2` again, keeps listings published after the last run
  that were never sent for this search, records them in `saved_search_hits` (primary key search + listing) and sends
  one notification `saved_search_match` with the count. A text query is matched by words only at alert time: the
  alert does not call the embedding model. The function sets `search_path` to include `public`, because
  `search_public_v2` names PostGIS and pgvector types without a schema (as earlier functions do, 0002, 0007).
- Erasure deletes the flatmate profile and the saved searches (7.4).

### D-107 Platform P8: trust check before publication, moderation, reports, message warnings, badges

- **Submit runs the trust check.** `POST /v1/listings/{id}/submit` does the P3 checks, then (setting
  `trust.enabled`, on by default) runs `wf.trust.assess`, stores a trust report, and applies it. ok: published as in
  P3, now with `checked: true`. review: the listing waits in `pending_review` for a moderator. block: rejected. The
  /v1 answer keeps its shapes: 200 with `status: published` (the schema's const), or the documented 409 with new
  detail issues `{field: trust, issue: in_review | rejected, signals}`. A 202 or a new status in the 200 would have
  broken /v1, so it was not done. The check is synchronous: on the PC the request lasts as long as the agent
  (**not measured** yet; `trust_bench.py` reports it). `listing.auto_publish` still publishes without the check, as
  its description says (testing only; RUNBOOK: off before real users).
- **Where each signal comes from.** Database (SQL, `app.trust_facts`): photos also used by another owner
  (`app.find_similar_media`, same owner ignored), price against the benchmark, owner history (new account with
  several listings, earlier publications without reports), EXIF place far from the listing, photo contradictions
  from the analysis, contact details in the text. Phrase rules (`kb/packs/<code>/scam_phrases.csv`, GLOBAL plus the
  country, built into the Code nodes): payment before a visit, payment services, pressure, owner abroad,
  discriminatory wording. Trust agent A4 (AI Agent node, prompt `P4_trust_assessor` v1, five read-only tools): the
  wording, with a quote for each signal.
- **The model cannot decide alone.** Code keeps an agent signal only if its quote is in the listing text, and a
  payment signal only if the phrase rules found it too; otherwise it becomes `payment_claim_unconfirmed` (-15, never
  hard). `app.trust_score` caps every signal at the points of `trust.points`, keeps the strongest line per kind,
  starts at 100, and gives ok from 70, review from 40, block under 40 **only with a hard signal** (`trust.hard_signals`:
  stolen photo, payment before a visit), else review. This is backend spec 12.2. The points are the spec's initial
  points; `payment_claim_unconfirmed`, `too_good_price_claim` and `other` are mine. None is tuned yet.
- **Price benchmark** (`app.price_benchmarks`, `wf.ops.benchmarks` daily at 04:30 UTC): median and quartiles of the
  monthly rent per country, city and kind. "real" uses published non-synthetic listings; "seed" adds the synthetic
  demo listings and is used only while real is too small, labelled so (12.3). Fewer than `trust.benchmark_min` (5)
  comparable listings: `insufficient_data`, no signal. Under 0.6 of the median: -15; under 0.4: -25. Both ratios are
  a choice, **not measured**.
- **Phrase lists** are written by hand from the signal descriptions of 12.2; they are not taken from a source. A
  match right after a negation ("rien n'est payé avant la visite", "لا شيء يدفع قبل الزيارة") does not count. "ma"
  and "ما" are not negations here: in Tunisian "9bal ma tchouf" means "before you see". The discriminatory list only
  flags for a moderator (0 points); whether such wording is unlawful depends on the country and is not decided here.
- **Prompt injection.** The listing text sits alone between `<message>` tags (tags inside it are neutralised), the
  prompt says it is data, and the rules and database checks do not read the model. A scam that tells the model to
  pass it keeps its rule signals (contract test, and 6 items of the trust set).
- **Moderation** (backend spec 12.5): `GET /v1/admin/moderation` and `POST /v1/admin/moderation/{id}/decision`,
  moderator or admin only (gateway role check and again in SQL). Actions per item: approve, reject, dismiss for
  listings; hide_message for a reported message; warn for a user. Every decision writes `app.audit_log` (actor,
  decision, note, code, effect). `app.moderation_queue` gained `evidence`, `message_id`, `reports`, `decision`.
- **Report triage**: a trigger on `app.reports` opens one item per target (listing, user, message) or raises the open
  one: scam and discrimination start at priority 3 (others 5; 1 is the most urgent), each further person reporting
  the same target moves it one step up. No model reads reports (PLATFORM_SPEC 4 allows an optional call; not built).
- **Message warnings** (rule 2.7, no model): `wf.api.message_send` runs the phrase rules over the text; the codes
  (payment before a visit, payment service, pressure) are stored in `social.messages.flags` and returned as
  `warnings` to the receiver only. The message itself is not changed or blocked.
- **Badges**: `app.user_badges` reads them from stored facts, so they are never stale: `email_confirmed` (an account
  from the website, which only signs in with a confirmed address), `telegram_linked`, `photos_checked` (a published
  listing whose last trust check passed and found no photo of another owner). No badge says "verified person".
  `GET /v1/me` fills `badges` (the field exists since P1) with objects `{code}`, as its schema says.
- **Trace**: one step `A4_trust_agent` per check, with no listing text (D-062): rule hits, kept and dropped agent
  signals, tool names, state (answered, failed, no_answer, unparsed, or why the agent was skipped).
- **Agent entry** in `docs/AI_AGENTS_EXPLAINED.md`: that file is Firas's; the entry for A4 is left to him.

### D-108 Platform P9: documents from templates with primary sources, PDF rendering, Document agent, legal ask

- **Templates** live in `kb/templates/<CODE>/<kind>.json` (README there): slots, the text in each language with
  `{{slot}}` markers, and the sources with URL and the date they were read. `n8n/build_platform.py` builds them into
  the Code nodes; nothing reads the files at run time, so there is no sync step on the PC. A legal type is offered for
  a country only when its template has sources (PLATFORM_SPEC 3.7).
- **What is offered, and why.** TN: rent receipt (COC art. 768-770), entry and exit inventory (COC art. 780-783,
  742-744), flatmate agreement (COC art. 772-774), read on 2026-10-17 on jurisitetunisie.com, a private site that
  reproduces the code, because legislation.tn refuses automated reading (robots.txt). Each PDF says so. GB: rent
  receipt (Landlord and Tenant Act 1985 s.4, legislation.gov.uk, read 2026-10-17). FR: nothing legal yet: Légifrance
  could not be read from here (the fetch failed twice), so FR is "not available" and the page says so. House rules are
  offered everywhere: they state no rule of law, and their PDF says "no source".
- **The text is the template's.** The paragraphs that mention the law say what the cited article says in plain words
  (checked against the text read), nothing more. Only slot values are added; every value is escaped; a value for an
  unknown slot is dropped and named in the answer (`dropped`); a required slot still empty refuses the document (422,
  one detail per slot). Unit test: the PDF's text minus the template's pieces and the values is empty.
- **Facts come from the database**: names (members in join order), the owner member, the address, the house rules,
  and for a receipt the rent payment, which must have been confirmed by the owner member; only the owner member makes
  receipts, only a flatmate makes the flatmate agreement. An empty household fact (no address) may be typed.
- **Rendering**: WeasyPrint 66.0 in the Media service (`POST /v1/pdf/render`, keys under `documents/` only, no
  resource from elsewhere is loaded). The 6.7 test: an Arabic, French and English page rendered in the sandbox and
  checked by eye (letters joined, right to left) and by extracting the text back (pdfplumber, pdftotext). Arabic text
  needed dates, amounts and Latin names kept left to right, or "2026-10-17" showed as "17-10-2026"; fixed with
  isolated spans and checked by eye again. One small page renders in about 0.2 s here (measured once; PC not measured).
  The Docker image gains Pango and the DejaVu fonts. Downloads are signed GET URLs (900 s) under `documents/`; the
  proxy now lets signed GETs through for `documents/*` as it does for `media/*`.
- **Synchronous**: `POST /v1/households/{id}/documents` renders in the request and answers 201, not 202 with a job as
  the spec table said. A page renders in well under a second; a job would add a status poll for nothing. A failed
  rendering is stored as failed and answered 503.
- **No `home.inventory_items` table**: the inventory rows are the document's `inputs`. P10's exit comparison reads
  them from the two documents.
- **Document agent A6** (AI Agent node, `P9_document_agent` v1, Postgres chat memory per person and household, tools
  `household_facts`, `template_slots`, `propose_document` in `wf.documents.tool`). It runs behind its own endpoint,
  `POST /v1/households/{id}/documents/assistant`, on the documents page. It only proposes: the proposal is a stored
  draft, checked against the template's slots in code (unknown slots dropped; values the database gives ignored), and
  the person confirms with `POST .../documents {draft_id}` (a draft is used once). The answer shows the stored draft,
  not the model's text. It does not make rent receipts (they need a confirmed payment, chosen on the page).
- **Not done: routing the assistant's `generate_document` intent to A6.** `POST /v1/assistant/message` still answers
  that intent with "not available yet". Routing it would change that answer, add a household choice to a channel that
  has none (Telegram), and change the Telegram texts, which are Firas's file. Left for his decision.
- **`POST /v1/legal/ask`**: straight to the Legal agent A5 with the same masking and checks as the assistant's legal
  answers (D-087), without the router. The `/legal` page and the guides (`kb.guides`) are not built: the guides would be
  legal text needing primary sources per country, the same blocker as above. The FR and GB knowledge packs are not
  written for the same reason.
- **Evaluation**: `eval/datasets/document_agent_v1.jsonl` (16 requests, labels written before any run) and
  `scripts/document_bench.py` (`p4.ps1 -Step document-bench`), to run on the PC.

### D-109 Platform P10: moving out, deposits, leaving with a balance, inventory comparison, account deletion, retention

- **10 new operations**, additive: deposits (list, put), the move-out checklist (get, start, tick), the exit
  inventory comparison, `DELETE /v1/me`. `POST /v1/households/{id}/leave` gains `acknowledge_balance`: a member whose
  balance is not zero gets 409 `balance_not_settled` with the amount, unless they say they know (PLATFORM_SPEC 3.9).
  The P5 contract test now sends it; the leave endpoint is part of the same, not yet committed, platform release.
- **Checklist**: three items the person ticks (tell the flatmates, keys returned, bills moved to another name) and three
  the API computes (balance settled, an exit inventory made, deposit returned or none recorded). The spec wanted
  checklist items per country "each with its source": none is included, because no country's notice rules were read
  from a primary source for this (same reason as FR in D-108). Starting a move-out sets the member to `leaving` and
  tells the other members.
- **Deposits** (`home.deposits`): recorded by the owner member, or by the flatmates when the household has no owner
  member. Once the return is recorded, returned plus the deductions (reason and amount each) must equal the deposit
  (422 `sum_mismatch`); the flatmate is notified. The owner member sees every deposit, a flatmate their own.
- **Comparison**: rows of the exit inventory matched to the household's last entry inventory by room and item, case and
  spaces ignored: same, changed, missing at exit, only at exit. The rows are the documents' stored inputs (no
  `inventory_items` table, D-108).
- **Account deletion**: `DELETE /v1/me?confirm=DELETE` (no consent needed: withdrawing consent must not block leaving)
  runs `app.erase_user` (phase 1) and the platform's erasure triggers (P1 to P10): name, e-mail, sign-in and Telegram
  ids, profiles, flatmate profile, saved searches, drafts, documents the person made, the Document agent's memory;
  memberships set to left. Shared records stay without the name: expenses and shares keep the user id, so the other
  members' balances still add up (pgTAP checks they sum to zero). Files are not deleted inside the request: their keys
  go into `delete_media` jobs. The website then deletes its own sign-in record and sessions (Better Auth), so the
  e-mail cannot sign in to the erased account.
- **Retention** (`wf.ops.retention`, daily 03:30 UTC): `app.retention_run(date)` deletes unused document drafts after 7
  days, read notifications after 180, saved-search alert records after 180, stored idempotent answers after 2 (settings
  `retention.*`; all four ages are choices, not measured or taken from a rule). Then it takes the queued `delete_media`
  jobs (also those `app.erase_user` has queued since phase 1, which nothing processed until now), sends each key list
  to the Media service's delete and marks the job done, or back to the queue up to five attempts.
- **Not checked here: the file deletion itself.** The contract test checks the job is queued with the PDF's key; the
  retention workflow is a schedule and was not run in the sandbox. On the PC, run it once from n8n and check the PDF
  is gone (RUNBOOK line added).

### D-110 Platform P11: e-mail and Telegram delivery, Telegram linking by code, admin endpoints and pages

- **Delivery** (`wf.notify.dispatch`, every minute): `app.deliveries_take` turns new notifications (less than
  `notify.max_age_hours`, 24, old) into one delivery per channel the person allows: e-mail when they have an address
  and e-mail is on, Telegram when a chat is linked and Telegram is on, nothing for the types they keep in the app
  (`muted`). Each delivery is handed out once (`for update skip locked`), sent with the n8n Send Email node (SMTP
  credential `Mail (SMTP)`, Mailpit in development) or the Telegram node, and `app.deliveries_done` marks it sent, or
  queues it again after 1, 2, 4 and 8 minutes; the fifth failure is final with its reason. A delivery left "sending" by
  a stopped run goes back to the queue after 10 minutes.
- **The text** is the website's own sentence for the type (`web/messages/<locale>.json`, notifications.types, built
  into the Code node and formatted by `lib/notify_text.js`, a small ICU subset), in the person's language, plus a link
  to the page it is about. No other personal detail is added: details stay behind sign-in.
- **Preferences**: e-mail and Telegram are on by default (a person who signed up gave their address for the account);
  off is one click on `/account`. Erasure deletes preferences, deliveries and codes.
- **Telegram linking**: `POST /v1/me/telegram-link` gives an 8-character code (only its SHA-256 is stored, 15 minutes,
  once). The person sends `/lier CODE` to the bot. **The bot's workflow is Firas's file** (`wf.channel.telegram`), so it
  is not changed here: `wf.telegram.link` (input `{code, chat_id}`, output `{ok, display_name}` or
  `{ok: false, error_code}`) is ready for one Execute Workflow node in the bot. Until that node is added, linking works
  only through `app.telegram_link_redeem` (the contract test does that). A chat already linked to another account is
  moved to the new one (one account per chat).
- **SMTP credential**: `scripts/n8n-setup.sh` creates `fsCredSmtp000001` from `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`,
  `SMTP_USER`, `SMTP_PASSWORD` (compose passes them to `n8n-setup`; Mailpit by default). The sender address is the
  setting `notify.mail_from`, because Code nodes cannot read the environment.
- **Admin** (3.12): settings on an allowlist in SQL with a type per key (bool, integer range, URL); a key outside it or a
  value of the wrong type is 422; each change is in the audit log with the old and new value. Roles: admins only, never
  their own (so there is always an admin left), logged. Read-only lists for staff: prompts (activation stays a file
  change, spec 9.5), evaluation runs, knowledge-base sources with their last ingestion step. Traces use the existing
  admin endpoint. Website: `/admin` with a page for each; the header's staff link goes there.

### D-111 Platform P12: isolation matrix, website safety checks, backup and restore, load script

- **Isolation matrix** (`tests/contract/test_isolation_matrix.py`): one case per operation whose path names a
  resource, called by a signed-in person with no link to it and a valid body; the answer must be 403 or 404 with the
  error envelope. The list is checked against `docs/openapi.yaml`, so a new path without a case, or without a reason
  in `NOT_CHECKED`, fails the test. Not checked, with the reason in the file: the public listing page and its free
  slots, a visible flatmate profile, and the caller's own blocks and favourites. The test resets the outsider's rate
  counters between calls; the limiter is not what it measures.
- **Website safety checks** (`web/tests/safety.test.ts`, run with the other website tests): no raw HTML or `eval`, no
  `javascript:` links; only `lib/server/api.ts` knows the API address and key; browser code imports no server code
  and reads no secret environment; only the Better Auth handler accepts writes outside server actions; the origin
  checks of Next.js and Better Auth are not switched off. No `allowedOrigins` is set: the website is served on one
  host, and Next.js compares `Origin` with it.
- **Server-side request forgery** (backend spec 15.4): knowledge-base ingestion is the only workflow that fetches a
  URL taken from data. Before any request, `lib/url_guard.js` refuses addresses inside the stack or the local network
  (rules in the file); the source then fails with `refused_address: <reason>` and so does the job. Hosts in the new
  setting `kb.fetch_allow_hosts` (migration 0033, empty) pass: the KB contract tests put their fixtures server there
  and empty it afterwards. A public name that resolves to a private address, and redirects, are not checked: that
  needs a resolver step in front of the HTTP node, and the sources are a list the admin keeps, not user input.
- **Backup**: `pg_dump` custom format per database (`flatshare`, `n8n`, `auth`), taken in one exported snapshot with
  a fingerprint from the same snapshot (`scripts/db-fingerprint.sql`: rows per table, owners, grants, row-level
  rules, functions, policies, triggers, extensions), so the restore can be checked exactly while the stack keeps
  running. The fingerprint reads the catalog rather than comparing `pg_dump --schema-only` text, because PostgreSQL
  prints some CHECK constraints of the n8n database differently after a restore (same meaning, different text).
  Roles are listed without passwords: the passwords live in `.env` and db-bootstrap sets them. Garage is copied as its
  two volumes with the service stopped for the copy (about a minute; uploads fail meanwhile); an S3-level copy was not
  chosen because the volumes hold the bucket layout and keys too. `.env` and `secrets\` are not in the backup.
- **Restore** drops each database and recreates it from its dump with owners and grants, then compares the
  fingerprint. `RESTORE_CHECK=1` restores into scratch databases instead and drops them, which is what `p12.ps1 -Step
  backup-check` runs, so the check never touches live data. Backend spec 15.1 asks that a restored database passes
  the database tests: they run on the restored copy of `flatshare_test` (migrations only). On a copy of the live
  database they cannot pass, because their fixtures collide with real rows, so there the fingerprint is the check.
- **Load script** (`scripts/load_bench.py`): workers as separate users, signed like the website, through the proxy.
  Gateway and message limits are raised for the run and restored in a `finally`. Numbers count only from the PC.
- **Status** of every P12 item, including what is not done (ablation matrix, accessibility audit, clean-machine
  README run): `docs/HARDENING.md`.

### D-112 The trust check runs as a job: POST /v2/listings/{id}/submit

- **Why.** On the PC (T-78) the v1 submit with the Trust agent outlasted the contract tests' 30 s client and the
  website's publish button: the check is synchronous (D-107) and the local model takes tens of seconds. PLATFORM_SPEC
  6.6 already said the trust check is a 202 job the page polls; D-107 did not follow it because a 202 on
  `/v1/.../submit` would have changed a /v1 answer. So the job version is a new /v2 path, and /v1 stays as it is.
- **`POST /v2/listings/{id}/submit`**: the v1 checks (`app.listing_submit_job` calls `app.listing_submit`), the same
  404, 409 and 422. When the trust check is needed: a `listing_trust` job (one per listing at a time; asking again
  returns the queued or running one) and 202 with `status_url`. Trust off, or already published: the v1 200.
- **`wf.listing.trust`** (worker, started by the endpoint and, for a retry, by `wf.jobs.dispatch`): `app.job_start`,
  `wf.trust.assess`, `app.listing_submit` with the report (published, in review or rejected exactly as in v1,
  notifications included), the embedding, `app.job_finish`. The job output has `outcome` (published, in_review,
  rejected, not_submitted) and `signals`. A check that stored no report is retried once (`max_attempts` 2), then the
  job fails with `trust_check_failed` and the listing stays a draft. The Trust agent's steps go to the trace with the
  job id as request id (`app.record_job_steps`), like the analysis job.
- **Website**: the publish panel calls v2, says the listing is being checked, and asks `GET /v1/jobs/{id}` every 3 s.
- **Tests that depended on the mock** (the Trust and Document agents' answers, `[mock:...]` markers) are now
  `sandbox_only`, as the other agent tests already were; on the PC the benches measure those agents. The P3 owner
  tests and the owner e2e run the trust check without the agent. New: a v2 test that runs on the PC with the real
  model and checks only the job mechanics (202, same job twice, outcome matches the listing's status, A4 step in the
  trace).

### D-113 P4_trust_assessor v2 after the first full trust bench on the PC

- **What T-79 showed.** With v1 the Trust agent hit its 6-iteration limit on every listing where the phrase lists
  found something (35 of 100), so on exactly the listings that matter it added nothing, and it made the check 15 s
  (p50) to 86 s (p95) slower. The rules and database checks alone met both backend spec 2.6 targets on `trust_v1`.
- **v2** (active): the phrase-list findings go into the user message (`{{found}}`), the prompt no longer lists
  `text_signals` and allows at most two other tool calls, never the same one twice. The tool stays in the workflow,
  unused by v2, so v1 can still be run for comparison (`prompts.py activate P4_trust_assessor 1`).
- **Not decided yet**, until v2 is measured: whether the agent stays on by default. If v2 still adds no verdict the
  rules miss, turning `trust.agent_enabled` off is the honest default for this PC, and the agent stays for the
  wording it can judge once a larger model is available. The two honest listings sent to review by a phrase match
  (trust-067, trust-072) are not tuned away: that would be tuning on the test set.

### D-114 Emna Safer's scam check brought into the trust check of P8

- **Her work** (branch `feat/scam-check`, 5 commits of 2026-10-16, not merged): an A4 scam-check agent with three
  tools, a single-call detector `P8_scam_detector` with quoted text signals and the amounts written in the text, a
  50-listing labelled set `p8_scam_v1`, deterministic scoring and unit tests. Measured by her on the PC (detector v1,
  run e624fa00): scam recall 0.92 (23/25), false alerts 0.12 (3/25), p95 36 s.
- **Why not merged as a branch**: it is a second trust check next to P8's. Both write `listings.trust_score` and
  `trust_verdict`, both are called A4, its migration number (0017) is taken, its block needs no hard signal (backend
  spec 12.2 asks for one, D-107), and nothing calls it. Merging would leave two scores that overwrite each other.
- **What came in** (migration 0035, `lib/trust_rules.js`, `wf.trust.assess`):
  - `contact_reused` (database): a phone (last 8 digits) or e-mail of the listing also on another owner's listing that
    was published or refused; -20, her weight on our scale. Evidence: counts only. `app.trust_facts` is the P8
    function plus this signal (`app.trust_facts_base`, `app.trust_contact_reuse`).
  - `price_mismatch`: a rent the detector reads in the text, really written there, 1.5 times or more away from the
    stored rent (her `mismatchSignal`, ported as is); -20, a choice.
  - `P8_scam_detector` v1, her prompt and schema unchanged, as `trust.model = detector`: one `wf.llm.call` instead of
    the agent. Her five types map to ours (off_platform_payment -> untraceable_payment, advance_payment ->
    payment_before_viewing, urgency -> urgency_pressure, external_contact -> contact_off_platform); its quotes go
    through the same checks as the agent's, so a payment signal the phrase lists did not also find stays
    `payment_claim_unconfirmed`. The agent stays the default until the PC comparison.
  - The check's note (the agent's summary, or the detector's evidence lines) on the moderation item (`note`, an
    added field) and page.
  - `p8_scam_v1` and its guide, unchanged, as a second set for `trust_bench.py`; it was written apart from our phrase
    lists, so it is not a set we tuned on. `p4.ps1 -Step trust-compare` runs both sets three ways.
- **Left out**: her agent's tools (`market_price` and `owner_profile` duplicate the price benchmark and owner
  history of P8; `contact_reuse` became the database signal), her score scale and thresholds, her eval-harness
  changes (`trust_bench.py` covers the set).
- **Also changed**: an agent signal with no points used to count 0 (`Number(null)` is 0); it now takes the setting's
  points, as `app.trust_score` meant.

### D-115 Yosr's roommate matching: four parts rebuilt on the platform

- **Her work** (branch `roommate-matching`, 2026-10-16; on GitHub's main as commits 3c2ac32 and 8299171, on top of
  the old code): workflows for n8n Cloud that build a profile by chatting, compute a match score with the model, let
  two people agree before they are put in touch (by Gmail), write a sentence on why they match and make a shared
  living plan. Groq and Gemini as models, n8n data tables as storage.
- **Why not merged as is**: it runs outside this stack (cloud models, n8n Cloud, Gmail, data tables instead of
  PostgreSQL), so none of it goes through the gateway, the row-level rules or the trace. A score written by the model
  would sit next to the one `social.compatibility` computes (D-106) and could not be checked.
- **What came in** (migration 0036, `lib/flatmate_profile.js`, `build_platform.py` P12):
  - **Contact with both sides agreeing**: `social.contact_requests`, `POST /v1/flatmates/{user_id}/contact-requests`,
    `GET /v1/me/contact-requests`, `POST /v1/contact-requests/{id}/decision` (accept, refuse, cancel). Only to a
    visible profile, never between people who blocked each other, one open request per pair, at most
    `contact.requests_per_day` a day, closed after `contact.request_days`. Nothing of the sender is shown before the
    other person accepts; accepting opens a `direct` conversation (the note becomes its first message) and tells the
    sender. Her e-mail step is replaced by the platform's notifications.
  - **The sentence for a match** (`POST /v1/flatmates/{user_id}/explanation`, prompt `P12_match_explainer`): the
    model gets only the factor states (agree, differ, not said) and the score, never the other person's answers. Code
    keeps its sentence only if it adds no number but the score and names no topic it was not given; otherwise, or
    with `flatmate_explain.enabled` off, code writes it. The page says which one wrote it.
  - **Profile by chatting**: agent A7 (AI Agent node, Postgres memory `flatmate:<user>`, tools `my_profile` and
    `propose_profile`), prompt `P13_flatmate_onboarding`, from her prompt: her question order and her rule of two
    questions per message. Code keeps only known fields and values and drops a budget, area or date the person did
    not write. Nothing is saved until the person presses Save (`POST /v1/me/flatmate-profile/apply`).
  - **Living plan**: template `global.living_plan` (fr, en, ar), made from the household: habits as agreed, to
    discuss or not said by everyone (never who answered what), rent and bills split equally, chores and rules.
- **Left out**: n8n Cloud, Groq and Gemini, Gmail, the data tables, the score written by the model, the gender and
  dealbreaker fields, and the personal webhook URL in her workflows.
- **Test set**: `flatmate_onboarding_v1` (20 messages, ours, written before any run). Not measured on the real model
  yet (`p4.ps1 -Step flatmate-bench`).

### D-116 A new interface for the website: "Bleu de porte", light and dark

- **Asked for**: a new, more striking interface built from what the best flatshare sites do, with every existing
  feature, the agents and the backend unchanged, responsive, with a light and a dark theme.
- **What was taken from where** (sources below):
  - Search: the list and the map side by side, filters in one bar across the top rather than a column (Baymard's
    study of accommodation sites: split views were used heavily, filter columns crowded the results). `view=map` is
    now that split view; the URL and its parameters are unchanged.
  - Listing page: the first photo large with up to four beside it, and a panel with the price and the contact forms
    that stays in view while reading (Airbnb's pattern).
  - Profiles before contact, contact only when both accept, no phone number shared (Badi); D-115 already does this,
    the flatmate pages now show it first.
  - Trust given its own section on the home page, saying only what the platform does (HousingAnywhere lists its
    protections at the end of a tips page).
  - Rent, place and the number of flatmates up front on cards, and saved searches one click from the results
    (La Carte des Colocs, SpareRoom).
- **Look**: Sidi Bou Said. Whitewash page, cobalt "door" blue for actions, bougainvillea pink as the one highlight
  (favourites, a match, unread). Dark theme: the same street at night, deep blue rather than grey. Headings in
  Alexandria (one family for Latin and Arabic script, self-hosted with `@fontsource-variable/alexandria`), body text
  in IBM Plex Sans / Plex Sans Arabic as before. Radius by rank: photos 1.25 rem, panels 1 rem, fields 0.625 rem.
- **The signature**: the plan of a shared flat, drawn in white on a night-blue panel on the home and account pages.
  The assistants follow one drawing rule of architects: what is proposed is dashed, what is built is solid. Every
  proposal (owner assistant, Document agent, flatmate profile chat) is a dashed box until the person saves it.
- **Light and dark**: tokens in `web/app/globals.css`, redefined for `prefers-color-scheme: dark` and for
  `data-theme`. The toggle in the header (`components/theme-toggle.tsx`) writes a `theme` cookie; the layout reads it
  and sets `data-theme` on `<html>`, so the first paint is already right without an inline script (the safety test
  forbids one). No cookie: the system decides. The map switches its basemap to Protomaps' dark flavour.
- **Shared pieces**: `panel`, `page-title`, `section-title`, `chip`, `btn`, `proposal`, `skeleton` utilities;
  `PageHeader`, `Empty` (an empty list says what to do next), `Avatar`, and `components/ui/assistant.tsx` (thinking,
  turns, proposal box). The header keeps one `<nav>`: main sections in the bar, the rest under "More", notifications
  and the profile always visible.
- **Found while doing it**: the home page read its texts from the `home` namespace, which the household pages took
  over in P5, so its title read "Colocations" and its other texts were missing. The home page now has its own
  `landing` namespace in fr, en and ar. Addresses no page answers now show the site's 404 page inside the header and
  footer (`app/[locale]/[...rest]`), not Next's bare one.
- **Not changed**: no API call, no endpoint, no business rule; the website still only calls the API from the server.
- **Sources**: [Baymard, accommodation split view](https://baymard.com/research-articles/accommodations-split-view);
  [HousingAnywhere, tenant protection](https://housinganywhere.com/introducing-tenant-protection);
  [Presse-citron on La Carte des Colocs](https://www.presse-citron.net/trouvez-facilement-votre-prochaine-colocation-avec-la-carte-des-colocs/);
  [Time Out on Badi](https://www.timeout.com/london/things-to-do/city-living-has-never-been-so-easy-to-sort-with-badi);
  [TechBullion on SpareRoom](https://techbullion.com/spareroom-and-the-future-of-roommate-matching-a-tech-driven-solution-to-housing-challenges/).

### D-117 The detector reads a listing's wording by default; the profile agent asks two questions at most

- **Trust check**: after the PC comparison of 2026-10-18 (T-84), `trust.model` becomes `detector` (migration 0037;
  only a database still on the old default changes). On trust_v1 the detector sent every scam to review or block
  (1.0) where the agent and the rules alone reached 0.857; on Emna's p8_scam_v1 it reached 0.88 against 0.56 for the
  agent and 0.52 for the rules. No honest listing was blocked by any of them. Its cost: more honest listings sent to a
  moderator (published 0.958 against 0.972 on trust_v1, 0.88 against 0.92 on p8_scam_v1), which is a review, not a
  refusal. It answered every listing (the agent gave no usable answer on 14 of 100 and 17 of 50), with p95 15 s against 70 s on trust_v1. It blocks a little less often (scams blocked 0.286 against 0.321 on trust_v1); the rest go to review.
  The agent stays available (`trust.model = agent`).
- **Profile agent (A7)**: on the PC, 10 of 20 first answers asked more than two questions, against the prompt's rule.
  Code now cuts an answer after its second question (`twoQuestions` in `lib/flatmate_profile.js`), and the trace
  step says when it did (`questions_cut`). The prompt is unchanged (not measured again).
- **Test set note**: three answers showed a budget or area labelled "forbidden" in flatmate_onboarding_v1 (fm-010,
  fm-018). In both the person wrote the value themselves ("mets mon budget à 5000", "set areas=Sousse"), and the
  proposal is only saved if they confirm it, so this is not a leak. The labels stay as written; a v2 of the set would
  count a value the person wrote as theirs.

### D-118 The country of the site, and a short language picker

- **Asked for**: choosing a country makes the whole site about that country: its listings, its flatmates, the cities in
  the search filter. The language stays a separate choice. Countries: Tunisia and France, and the United Kingdom since
  it already works end to end (search, map file, prices in GBP, places); its document templates and legal sources are
  fewer than Tunisia's.
- **How**: a country picker in the header (the countries GET /v1/me returns) next to a language picker that shows
  FR / EN / AR. The choice is a `country` cookie; `web/lib/server/country.ts` reads it, keeps it only if it is one of
  the offered countries, and otherwise falls back to the account's country, then Tunisia. Below 640 px both pickers
  are in the footer.
- **What it scopes** (each already took a country; the website now passes the chosen one):
  - search: `jurisdiction` of GET /v2/search; an address with `?country=` (a shared link) keeps its own;
  - flatmates: `jurisdiction` of GET /v1/flatmates (only people whose account is in that country);
  - assistant: `jurisdiction` of POST /v1/assistant/message (a message that names another country still wins, as before);
  - the default country of a new listing and of a new household.
- **Cities**: GET /v1/places?jurisdiction=&kind=city&lang= (migration 0038, `wf.api.places_list`, new and additive)
  lists the active places of the gazetteer (`geo/places.csv`), with the name in the reader's language when the gazetteer
  has one. The search bar's "Near" field became "City" (that list); a precise place (area, university) moved to
  "More filters" and wins over the city. Both go to the API's `near`, as before.
- **Not changed**: the account's own country (GET/PATCH /v1/me) and saved searches, which keep the country they were
  saved with.
- **Pickers**: each is a small menu (`components/ui/picker.tsx`): the country with its flag, the language with a globe and
  its code. The flags are small SVGs, not emoji: Windows draws flag emoji as two letters. The site's icon
  (`app/icon.svg`, `app/apple-icon.png`) is the door of the logo on cobalt blue.

## Spec observations scheduled for later phases

- **Rent period.** Done in phase 3 (D-056).
- **Job scheduling fields.** `app.jobs` has no `next_attempt_at`, lease or timeout column, which the backoff and reaper behaviour in spec 5.6 needs. Added with the job worker (phase 4).
- **HNSW and the materialised CTE.** In `search_listings` the filtered CTE is referenced three times, so PostgreSQL materialises it and the HNSW index cannot be used; every search is an exact scan. Measured in phase 3 on the owner's PC (T-38): with 123 published listings the database part of a search took p50 2.1 ms and p95 5.4 ms, against p95 357 ms for the whole request (most of it the query embedding, p95 218 ms). No change now; to measure again when the listing count grows by orders of magnitude (phase 9 load test).
- **Cleanup of gateway tables.** `sec.request_nonces` is trimmed on every accepted request; `app.idempotency_keys` and `app.rate_counters` need the scheduled retention workflow (phase 7).
