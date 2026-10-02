# Test report

One entry per run: date, where, versions, exact command, real output (trimmed; the full
output is in the file named under "Evidence"), result. Failed runs stay in the report.

**Where the runs happened.** T-1 to T-9 ran in the cloud sandbox (Ubuntu 24.04.4, 2 vCPU,
7.8 GB RAM, no GPU) on a native stack: PostgreSQL 16.13, pgvector 0.6.0, PostGIS 3.4.2,
pgTAP 1.3.2, dbmate 2.36.0, n8n 2.41.3 on Node 24.21.0 (internal task runner), Caddy 2.6.2.
The compose stack (PostgreSQL 18, PostGIS 3.6, pgvector 0.8, Garage 2.4.1, Ollama 0.34.4,
n8n image with external runners, Caddy 2.11.4) ran on the owner's PC: T-10 to T-12 failed,
T-13 passed every test step. Ollama and object storage are **mocks** in the sandbox runs
(`tests/mocks/deps_mock.py`) and real services in T-13.

---

## T-1 Baseline schema reproduces the spec's results (2026-09-29)

Purpose: confirm the "tested" claim before building on it.

```
$ createdb baseline_check; psql -d baseline_check -v ON_ERROR_STOP=1 -f schema.sql; psql -d baseline_check -f schema_tests.sql
== T1 hybrid search TN, budget 260000 TND, near Ariana center 5km: expect 001 (and maybe 003), not 002/004/005/006
 10000000-0000-0000-0000-000000000001 | 0.03279 |          1 |            1 |    43
== T3 jurisdiction isolation: FR search must return only 006
 10000000-0000-0000-0000-000000000006
== T4 currency safety: budget in EUR against TND listings must return nothing
     0
== T19 api_user must NOT read exact location (must FAIL)
psql:.../schema_tests.sql:156: ERROR:  permission denied for table listings
== T22 api_user must NOT execute erase_user (must FAIL)
psql:.../schema_tests.sql:162: ERROR:  permission denied for function erase_user
```

Result: PASS. All 24 blocks print the expected values, the 10 expected rejections are rejected.
These checks need a person to read the output; they were ported to assertions (T-3).
Evidence: `reports/phase1/baseline_schema_tests_pg16.log`.

## T-2 Defect proof: security tests on the baseline without the fixes (2026-09-29)

Purpose: show that D-010 to D-014 are real defects, not style preferences.

```
$ dbmate --migrations-dir /tmp/mig_pre up        # 0001 baseline + 0002 gateway only
$ pg_prove -d flatshare_pre --verbose db/tests/020_security_fixes.sql
not ok 1 - D-010 Bob sees only his 2 consent rows
not ok 3 - D-010 Alice cannot record consent for Bob
not ok 7 - D-011 api_user cannot insert a published listing
not ok 8 - D-011 api_user cannot set trust_score
not ok 12 - D-011 api_user cannot publish by update
not ok 16 - D-011 api_user cannot hard-delete a listing
not ok 17 - D-012 api_user cannot write assistant messages
not ok 21 - D-013 no function in app/kb/ai/eval/sec is executable by PUBLIC
  Failed tests:  1-3, 5-9, 12-13, 16-18, 20-24
  Parse errors: Bad plan.  You planned 33 tests but ran 25.
Result: FAIL
```

The file stops at assertion 25 because the forbidden hard delete (16) succeeded and removed the
listing the next fixture needs. Erasure on the baseline:

```
delete job input: {"listing_id": "10000000-0000-0000-0000-00000000000a"}     <- no storage keys
generated_documents left: 1, inputs: {"names": ["Alice"]}                    <- personal data kept
```

Result: FAIL on the baseline, as expected. Evidence: `reports/phase1/defect_proof_020_without_0003.log`,
`reports/phase1/defect_proof_d014_erase_on_baseline.log`.

## T-3 Database suite, all migrations (2026-09-29T20:16Z)

```
$ su postgres -c 'cd /home/claude/flatshare && DBMATE=/opt/dbm/node_modules/.bin/dbmate scripts/db-test.sh'
Applied: 0001_baseline_schema.sql ... Applied: 0006_api_finish.sql
postgis 3.4.2 / vector 0.6.0 / PostgreSQL 16.13
db/tests/010_baseline_behaviour.sql .. 1..51 ok
db/tests/020_security_fixes.sql ...... 1..33 ok
db/tests/030_gateway.sql ............. 1..41 ok
db/tests/040_settings_context.sql .... 1..11 ok
db/tests/050_gateway_check.sql ....... 1..12 ok
db/tests/060_api_finish.sql .......... 1..8 ok
Files=6, Tests=156
Result: PASS
```

Covers: the 24 baseline behaviours as assertions; the five security fixes; signature
verification (valid, replay, each signed field altered, other secret, format, ±301 s,
unknown and deactivated key, newline injection, bad uuid, bad base64, missing header, privileges);
the four shared signing vectors; idempotency (new, in progress, conflict, replay, other route,
scoping, stale takeover, release); settings and user context; rate counters including the
spoofed-IP case; request logging. Evidence: `reports/phase1/01-db-tests.log`.

## T-4 Unit tests (2026-09-29T20:16Z)

```
$ node --test n8n/tests/canonical.test.js
✔ vector get_no_body: canonical query and signature match the Python client
✔ vector query_repeated_reserved: canonical query and signature match the Python client
✔ canonicalQuery rejects nested values (qs-style a[b]=1)
✔ redactPg removes values from Postgres key details
ℹ tests 12  ℹ pass 12  ℹ fail 0

$ python3 -m pytest -v tests/unit
tests/unit/test_openapi.py::test_openapi_is_valid PASSED
tests/unit/test_openapi.py::test_every_error_code_has_a_status PASSED
tests/unit/test_signing_vectors.py::test_vectors PASSED
tests/unit/test_signing_vectors.py::test_query_encoding_matches_encodeURIComponent PASSED
4 passed in 0.41s

$ python3 n8n/build.py --check
workflow JSON is up to date
```

Result: PASS. The same four signing vectors pass in Python, JavaScript and PostgreSQL.
Evidence: `reports/phase1/02-unit-js.log`, `03-unit-py.log`, `04-build-check.log`.

## T-5 Contract tests directly against n8n (2026-09-29T20:16Z)

```
$ . /opt/lab/test-env.sh && export FS_API_BASE=http://127.0.0.1:5678/webhook FS_VIA_PROXY=0 && cd tests/contract && python3 -m pytest -v -rs
SKIPPED [1] test_health_and_failures.py:175: needs the reverse proxy      (x4)
======================== 45 passed, 4 skipped in 22.99s ========================
```

Result: PASS (the 4 skips need the proxy and run in T-6). Evidence: `reports/phase1/05-contract-direct.log`.

## T-6 Contract tests through the proxy (2026-09-29T20:16Z)

```
$ . /opt/lab/test-env.sh && export FS_API_BASE=http://127.0.0.1:8080 FS_VIA_PROXY=1 && cd tests/contract && python3 -m pytest -v -rs
test_gateway_auth.py::test_signed_request_accepted PASSED
test_gateway_auth.py::test_unsigned_request_rejected PASSED
test_gateway_auth.py::test_missing_single_header_rejected PASSED
test_gateway_auth.py::test_wrong_signature_rejected PASSED
test_gateway_auth.py::test_old_timestamp_rejected_with_server_time PASSED
test_gateway_auth.py::test_replayed_request_rejected PASSED
test_gateway_auth.py::test_tampered_query_rejected PASSED
test_gateway_auth.py::test_tampered_body_rejected PASSED
test_gateway_auth.py::test_swapped_user_id_rejected PASSED
test_gateway_auth.py::test_signature_for_other_route_rejected PASSED
test_gateway_auth.py::test_rate_limit_per_ip PASSED
test_gateway_auth.py::test_rate_limit_counts_bad_signatures PASSED
test_health_and_failures.py::test_health_all_up PASSED                                  (mock Ollama/storage)
test_health_and_failures.py::test_health_reports_missing_embedding_model PASSED
test_health_and_failures.py::test_malformed_json_body PASSED
test_health_and_failures.py::test_unexpected_error_enveloped_by_proxy PASSED
test_health_and_failures.py::test_unknown_route_enveloped_by_proxy PASSED
test_health_and_failures.py::test_n8n_internals_not_reachable_through_proxy PASSED
test_health_and_failures.py::test_oversized_body_rejected_by_proxy PASSED
test_users_sync.py::test_create_then_update PASSED
test_users_sync.py::test_idempotent_replay_returns_stored_response PASSED
test_users_sync.py::test_concurrent_duplicates_create_one_user PASSED
test_users_sync.py::test_sql_injection_strings_stored_literally PASSED
test_users_sync.py::test_erased_user_is_refused PASSED
test_health_and_failures.py::test_health_when_dependency_down[OLLAMA-ollama] PASSED      (mock stopped)
test_health_and_failures.py::test_health_when_dependency_down[STORAGE-object_storage] PASSED (mock stopped)
test_health_and_failures.py::test_database_server_down PASSED                           (pg_ctlcluster stop)
test_health_and_failures.py::test_app_database_unreachable_gives_503_envelope PASSED    (role locked)
SKIPPED [1] test_health_and_failures.py:161: checks raw n8n behaviour without the proxy
======================== 48 passed, 1 skipped in 38.41s ========================
```

(Selection; all 48 names and results are in the evidence file.) Every error response is
validated against `ErrorEnvelope` in docs/openapi.yaml; success responses against their schemas.
Outage tests assert the answer arrives in under 10 s (dependencies) or 15 s (database).
Result: PASS. Evidence: `reports/phase1/06-contract-proxy.log`.

## T-7 Secret scan (2026-09-29T20:17Z)

```
$ n8n export:workflow --all --separate --output=/tmp/n8n-export/
Successfully exported 5 workflows.
$ scripts/secret-scan.sh /tmp/n8n-export /opt/lab/lab.env /opt/lab/secrets/api-clients.env
== detect-secrets (baseline: .secrets.baseline)
no new findings
== exact-match scan of deployment secrets
checked 8 secret values against 61 files: none found
```

Negative control (same day): a real API secret written into a file in the export directory was
reported (`FAIL: a deployment secret appears in the files above`), so the scan can fail.
The baseline's only entries are the published test vectors (`tests/vectors/signing.json`,
`db/tests/030_gateway.sql`), marked as not secret. Result: PASS. Evidence: `reports/phase1/07-secret-scan.log`.

## T-8 Request latency in the sandbox (2026-09-29T20:17Z)

From `ai.executions` after T-5 and T-6 (all requests of both runs, including rejected ones).
Sandbox with 2 vCPU, mocks for Ollama and storage, n8n internal runner: **not representative
of the owner's machine**, recorded only as a first reference.

```
     workflow      | requests | p50_ms | p95_ms | max_ms
 wf.api.health     |       76 |    115 |    155 |    318
 wf.api.users_sync |       68 |    119 |    257 |    326
```

Error-handler rows from the same run:

```
 wf.test.fail | failed | WrappedExecutionError: deliberate failure for the error-handler test [line 1] (node: Throw
```

No logged error text contains an email address (`count(*) filter (where error like '%@%') = 0` over 146 rows).
Evidence: `reports/phase1/08-latency.log`.

## T-9 Spikes (2026-09-29), n8n 2.41.3

| Question | Observed | Evidence |
|---|---|---|
| Does the Webhook node's raw-body option give the exact bytes? | Yes: `{"z": 1,  "é":"ü"}` (double space, UTF-8) came back as base64 `eyJ6IjogMSwgICLDqSI6IsO8In0=` | `reports/phase1/spike_webhook_code_node.log` |
| Can a Code node read env vars or load `crypto`? | No: "access to env vars denied"; "Module 'crypto' is disallowed" | `reports/phase1/spike_webhook_code_node.log` |
| Path parameters with a shared webhookId | 1 of 3 routes registered | FAILURES F-003 |
| Redis node with Redis stopped | no answer within 60 s | `reports/phase1/redis_node_outage_spike.log` |
| Unregistered route, default NODE_ENV | 404 with a full stack trace in the body | `reports/phase1/spike_webhook_code_node.log`; `NODE_ENV=production` removes it |
| Start-up warnings | PostgreSQL 16 "outside the supported range"; internal runners deprecated | `reports/phase1/n8n_startup_warnings.log` |

## T-10 First compose run on the owner's PC (2026-09-29T21:35+01:00) - FAILED at build

```
PS D:\Projects\coloc\flatshare> powershell -ExecutionPolicy Bypass -File scripts\windows\verify.ps1
== restore git history from flatshare.bundle             PASS (exit 0, 0.6 s)
== GPU visible to Docker (docker run --gpus all ... nvidia-smi)
GPU 0: NVIDIA GeForce GTX 1650 with Max-Q Design (UUID: GPU-ee1b4c30-...)
                                                          PASS (exit 0, 1.6 s)
== docker and compose versions   client 29.7.2 server 29.7.2, Docker Compose version v5.4.0   PASS
== compose config is valid                                PASS
== build images
#10 [postgres internal] load metadata for docker.io/postgis/postgis:17-3.6
#10 ERROR: docker.io/postgis/postgis:17-3.6: not found
                                                          FAIL (exit 1, 2.2 s)
```

Cause and fix: FAILURES F-016. Base image is now `postgis/postgis:17-3.5`; verify.ps1 checks every
pinned tag before building and stops at the first failed build, start or wait step.
Evidence: `reports/verify-20260929-213513/verify.log` (owner's PC). Environment of that PC: `reports/env-check.txt`.

## T-11 Second compose run on the owner's PC (2026-09-29T21:42+01:00) - FAILED at build

```
== sync git history with flatshare.bundle                 PASS (0.3 s)
== GPU visible to Docker                                  PASS (1.6 s)
== free disk space                                        PASS
== compose config is valid                                PASS
== every pinned image tag exists in its registry          PASS (79.1 s)
== build images                                           FAIL (exit 1, 2625.6 s)
#20 DONE 667.7s        (tests image: apt-get install git)
#21 2324.7 E: Failed to fetch http://deb.debian.org/debian-security/pool/updates/main/g/glibc/libc6_2.31-13%2bdeb11u14_amd64.deb  404  Not Found
#21 2324.7 E: Failed to fetch http://deb.debian.org/debian/pool/main/b/binutils/binutils-common_2.35.2-2_amd64.deb  Connection timed out
#21 ERROR: process "/bin/sh -c set -eux; apt-get update; apt-get install ... postgresql-server-dev-17 ..." did not complete successfully: exit code: 100
```

Cause and fix: FAILURES F-017, DECISIONS D-006 (now PostgreSQL 18 / PostGIS 3.6 on Debian 13).
Evidence: `reports/verify-20260929-214259/verify.log` (owner's PC).

## T-12 Third compose run on the owner's PC (2026-09-29T22:51+01:00) - FAILED at image pull

```
== every pinned image tag exists in its registry          PASS (95.2 s; all 9 found)
== pull service images                                     FAIL (exit 1, 1.1 s)
 Image flatshare/postgres:18-3.6-pgvector0.8 Error pull access denied for flatshare/postgres, repository does not exist or may require 'docker login'
```

Cause and fix: FAILURES F-018. Sandbox check after the fix:

```
$ docker compose --dry-run pull --ignore-buildable 2>&1 | grep flatshare/postgres
 Image flatshare/postgres:18-3.6-pgvector0.8 Skipped
 Image flatshare/postgres:18-3.6-pgvector0.8 Skipped Image can be built
```

(Before the fix the same command printed "Pulling" and an error for that image. The other images
answer "Forbidden" in the sandbox because Docker Hub is blocked there, F-002.)

---

## T-13 Fourth compose run on the owner's PC (2026-09-29T22:55+01:00 to 2026-09-30T00:07+01:00) - all tests PASS, secret scan FAILED (false positive)

Where: owner's PC (Windows 11 Pro, Docker 29.7.2, Compose v5.4.0, GTX 1650 Max-Q visible to
Docker, so `docker-compose.gpu.yml` was added). Versions as recorded in docs/VERSIONS.md
"Recorded at run time". Command: `powershell -ExecutionPolicy Bypass -File scripts\windows\verify.ps1`.
Evidence: `reports/verify-20260929-225540/summary.txt` and `verify.log` (3.2 MB) on the owner's PC.

```
PASS  sync git history with flatshare.bundle  (exit 0, 0.3 s)
PASS  GPU visible to Docker (docker run --gpus all ... nvidia-smi)  (exit 0, 1.5 s)
PASS  docker and compose versions  (exit 0, 0.2 s)
PASS  free disk space (...)  (exit 0, 0.2 s)
PASS  compose config is valid  (exit 0, 0.1 s)
PASS  every pinned image tag exists in its registry  (exit 0, 94.4 s)
PASS  pull service images (largest download: Ollama, n8n)  (exit 0, 3023.4 s)
PASS  build images  (exit 0, 177.9 s)
PASS  start stack  (exit 0, 62.8 s)
PASS  wait for n8n, proxy and model pull (max 20 min)  (exit 0, 806.3 s)
PASS  one-shot service logs (db-bootstrap, n8n-setup, ollama-pull)  (exit 0, 2.4 s)
PASS  component versions  (exit 0, 1.5 s)
PASS  PHASE 0: embedding call returns 1024 numbers (bge-m3 via Ollama)  (exit 0, 31.5 s)
PASS  PHASE 1: database tests (pgTAP on the compose PostgreSQL)  (exit 0, 1.4 s)
PASS  unit tests, JavaScript (Code-node helpers)  (exit 0, 0.8 s)
PASS  workflow JSON matches n8n/build.py  (exit 0, 0.8 s)
PASS  PHASE 1: unit and contract tests through the proxy (includes outage tests unless -SkipOutages)  (exit 0, 99.9 s)
FAIL  export workflows from n8n and scan for secrets  (exit 1, 7.3 s)
PASS  final state  (exit 0, 0.2 s)
```

**Phase 0 acceptance (embedding).** Four texts: French, Arabic, English, transliterated Tunisian.

```
status 200 model bge-m3 dims [1024, 1024, 1024, 1024] l2_norms [1.0, 1.0, 1.0, 1.0] seconds_for_4_texts 30.52
```

The 30.5 s is the first call after the model pull and includes loading the model; steady-state
embedding latency and whether Ollama ran it on the GPU were **not measured** (phase 2 measures
latency on the knowledge-base load).

**Database suite on PostgreSQL 18.6 / PostGIS 3.6.4 / pgvector 0.8.6** (`scripts/db-test.sh`, fresh
`flatshare_test` database, all six migrations):

```
All tests successful.
Files=6, Tests=156,  1 wallclock secs ( 0.01 usr  0.02 sys +  0.08 cusr  0.05 csys =  0.16 CPU)
Result: PASS
```

**JavaScript unit tests** (node --test inside the n8n 2.41.3 image): 12 pass, 0 fail.
**Workflow JSON** matches `n8n/build.py`: `workflow JSON is up to date`.

**Python unit and contract tests through Caddy 2.11.4 → n8n 2.41.3** (real Garage, real Ollama,
external task runners), outage tests included (`docker stop`/`start` of Ollama, Garage and
PostgreSQL; `nologin` on the application role):

```
collected 53 items
...
tests/contract/test_health_and_failures.py::test_health_when_dependency_down[OLLAMA-ollama] PASSED [ 94%]
tests/contract/test_health_and_failures.py::test_health_when_dependency_down[STORAGE-object_storage] PASSED [ 96%]
tests/contract/test_health_and_failures.py::test_database_server_down PASSED [ 98%]
tests/contract/test_health_and_failures.py::test_app_database_unreachable_gives_503_envelope PASSED [100%]
SKIPPED [1] tests/contract/test_health_and_failures.py:161: checks raw n8n behaviour without the proxy
=================== 52 passed, 1 skipped in 98.19s (0:01:38) ===================
```

This includes the oversize-body test through Caddy 2.11.4 (413 `PAYLOAD_TOO_LARGE`), which the
sandbox could only run on Caddy 2.6.2 (F-009).

Note on the test file used: the owner's copy of `tests/contract/test_health_and_failures.py`
was the version before commit e72b61d (after an outage it slept 2 s and asserted 200 instead of
polling until healthy); the git history was restored with `reset --mixed`, which keeps working-tree
files. It passed with that version. The current version is delivered again.

**Secret scan.** The detect-secrets step found nothing new. The exact-match step failed on five files;
the cause is a false positive, FAILURES F-019, fixed in T-14.

```
== exact-match scan of deployment secrets
.env.example
db/migrations/0004_settings.sql
docker-compose.yml
scripts/db-bootstrap.sh
scripts/windows/verify.ps1
FAIL: a deployment secret appears in the files above
```

---

## T-14 Secret-scan fix (2026-09-30)

**Sandbox**, unit tests for the scan (`tests/unit/test_secret_scan.py`), first against the old
script to show they catch F-019, then against the new one:

```
$ git show HEAD~1:scripts/secret-scan.sh > scripts/secret-scan.sh; python3 -m pytest -q tests/unit/test_secret_scan.py
FAILED tests/unit/test_secret_scan.py::test_script_regex_matches_this_test - ...
FAILED tests/unit/test_secret_scan.py::test_config_values_in_repo_are_not_secrets
2 failed, 3 passed in 7.77s
$ (new script) python3 -m pytest -q tests/unit/test_secret_scan.py
5 passed in 0.09s
$ python3 -m pytest -q tests/unit
9 passed
```

**Owner's PC** (Linux shell of the desktop app, bash on the project folder), exact-match step
with the real `.env`, the real API keys and the workflows exported in T-13; detect-secrets is
not installed in that shell and was skipped here (it passed in T-13):

```
$ FS_SCAN_EXACT_ONLY=1 bash scripts/secret-scan.sh reports/verify-20260929-225540/n8n-export .env secrets/api-clients.env
== exact-match scan of deployment secrets
secret variables checked: POSTGRES_PASSWORD N8N_DB_PASSWORD N8N_WORKER_DB_PASSWORD API_USER_DB_PASSWORD N8N_ENCRYPTION_KEY N8N_RUNNERS_AUTH_TOKEN S3_SECRET_ACCESS_KEY GARAGE_RPC_SECRET GARAGE_ADMIN_TOKEN GARAGE_METRICS_TOKEN REDIS_PASSWORD FLATSHARE_WEBSITE_SECRET FLATSHARE_TESTS_SECRET
checked 13 secret values against 94 files: none found
exit=0
```

`CLOUD_LLM_API_KEY` and `TELEGRAM_BOT_TOKEN` are empty in `.env`, so they are not in the list.
Negative control on the same machine: a copy of the export directory (outside the project
folder) with one file holding the real `FLATSHARE_TESTS_SECRET`:

```
~/negctl/planted.json
FAIL: a deployment secret appears in the files above
exit=1
```

Not yet run: the verify.ps1 step itself (tests container, detect-secrets and export together)
with the new script. The next `verify.ps1` run covers it.

---

## T-15 Fifth compose run on the owner's PC (2026-10-01T00:40+01:00) - stopped, Docker engine not running

```
== GPU visible to Docker (docker run --gpus all ... nvidia-smi)   FAIL (exit 1, 0.2 s)
failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; ... The system cannot find the file specified.
== docker and compose versions                                    PASS (exit 0, 0.3 s)
client 29.7.2 server
== pull service images (largest download: Ollama, n8n)            FAIL (exit 1, 0.3 s)
failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; ...
```

No project code ran. Cause and script change: FAILURES F-021. Sandbox check of the new first step:

```
$ DOCKER_HOST=unix:///nonexistent.sock docker info --format "server {{.ServerVersion}} os {{.OperatingSystem}}"
server  os
failed to connect to the docker API at unix:///nonexistent.sock; ... no such file or directory
exit=1
```

The PowerShell file itself was not run here (no PowerShell in the sandbox); the next run on the
owner's PC runs it.

---

## T-16 Sixth compose run on the owner's PC (2026-10-01T00:45+01:00) - all tests PASS, secret scan FAILED (my doc text)

First run with the Docker engine check (F-021): it passed, GPU override on. Images, build and
model were cached (pull 4.1 s, build 3.5 s, start 35.2 s). Evidence:
`reports/verify-20261001-004515/verify.log` on the owner's PC.

```
status 200 model bge-m3 dims [1024, 1024, 1024, 1024] l2_norms [1.0, 1.0, 1.0, 1.0] seconds_for_4_texts 4.58
Files=6, Tests=156 ... Result: PASS
======================== 57 passed, 1 skipped in 56.59s ========================
```

57 = the 52 contract and unit tests of T-13 plus the 5 new tests in `tests/unit/test_secret_scan.py`.
4.58 s is one call with the model already downloaded; it is not a latency measurement.

Secret-scan step: exit 123, detect-secrets reported a "Secret Keyword" in this file (FAILURES
F-022); the exact-match part did not run in this step. Sandbox after the fix:

```
$ git ls-files -z | xargs -0 detect-secrets-hook --baseline .secrets.baseline; echo exit=$?
exit=0
```

---

## T-17 Seventh compose run on the owner's PC (2026-10-01T00:51+01:00) - every step PASS

Git history at 3485d3e, GPU override on. Phase 0 and phase 1 acceptance runs on the compose stack.
Evidence: `reports/verify-20261001-005156/summary.txt` and `verify.log` on the owner's PC.

```
PASS  sync git history with flatshare.bundle  (exit 0, 0.3 s)
PASS  Docker engine is running  (exit 0, 0.2 s)
PASS  GPU visible to Docker (docker run --gpus all ... nvidia-smi)  (exit 0, 1.4 s)
PASS  docker and compose versions  (exit 0, 0.2 s)
PASS  free disk space (...)  (exit 0, 0.2 s)
PASS  compose config is valid  (exit 0, 0.1 s)
PASS  every pinned image tag exists in its registry  (exit 0, 80.4 s)
PASS  pull service images (largest download: Ollama, n8n)  (exit 0, 2.4 s)
PASS  build images  (exit 0, 1.8 s)
PASS  start stack  (exit 0, 33.5 s)
PASS  wait for n8n, proxy and model pull (max 20 min)  (exit 0, 0.4 s)
PASS  one-shot service logs (db-bootstrap, n8n-setup, ollama-pull)  (exit 0, 2 s)
PASS  component versions  (exit 0, 1.1 s)
PASS  PHASE 0: embedding call returns 1024 numbers (bge-m3 via Ollama)  (exit 0, 4.2 s)
PASS  PHASE 1: database tests (pgTAP on the compose PostgreSQL)  (exit 0, 1.3 s)
PASS  unit tests, JavaScript (Code-node helpers)  (exit 0, 0.8 s)
PASS  workflow JSON matches n8n/build.py  (exit 0, 0.7 s)
PASS  PHASE 1: unit and contract tests through the proxy (includes outage tests unless -SkipOutages)  (exit 0, 75.5 s)
PASS  export workflows from n8n and scan for secrets  (exit 0, 6.6 s)
PASS  final state  (exit 0, 0.2 s)
```

```
status 200 model bge-m3 dims [1024, 1024, 1024, 1024] l2_norms [1.0, 1.0, 1.0, 1.0] seconds_for_4_texts 3.49
Files=6, Tests=156 ... Result: PASS
=================== 57 passed, 1 skipped in 74.12s (0:01:14) ===================
Successfully exported 5 workflows.
== detect-secrets (baseline: .secrets.baseline)
no new findings
== exact-match scan of deployment secrets
secret variables checked: POSTGRES_PASSWORD N8N_DB_PASSWORD N8N_WORKER_DB_PASSWORD API_USER_DB_PASSWORD N8N_ENCRYPTION_KEY N8N_RUNNERS_AUTH_TOKEN S3_SECRET_ACCESS_KEY GARAGE_RPC_SECRET GARAGE_ADMIN_TOKEN GARAGE_METRICS_TOKEN REDIS_PASSWORD FLATSHARE_WEBSITE_SECRET FLATSHARE_TESTS_SECRET
checked 13 secret values against 95 files: none found
```

---

## T-18 Phase 2 in the cloud sandbox (2026-10-01) - PASS, with mocks for TEI and Ollama

Where: cloud sandbox, native stack as in T-1 to T-9 (PostgreSQL 16.13, pgvector 0.6.0, PostGIS 3.4.2,
n8n 2.41.3 with its internal task runner, Caddy 2.6.2 as the proxy). **TEI and Ollama are mocks**
(`tests/mocks/deps_mock.py`: whitespace tokenizer with UTF-8 byte offsets, hashed bag-of-words vectors of
1024 numbers). These runs check the plumbing (requests, batching, offsets, storage, jobs, metrics); they say
nothing about retrieval quality, model behaviour or speed. Fixture files were served by `python -m http.server`.

JavaScript unit tests (cleaning, robots.txt, token offsets, structure parser, chunkers A and B, metrics,
static checks on every generated workflow), evidence `reports/phase2/01-unit-js.log`:

```
$ node --test n8n/tests/*.test.js kb/tests/*.test.js eval/tests/*.test.js
# tests 46
# pass 46
# fail 0
```

Database tests, all migrations 0001 to 0007, evidence `reports/phase2/02-pgtap-sandbox.log`:

```
$ scripts/db-test.sh
db/tests/070_kb_pipeline.sql ......... 1..37 ok
All tests successful.
Files=7, Tests=193,  0 wallclock secs
Result: PASS
```

070 covers normalisation (Latin, Arabic, NFKC), the lexical query, document versioning (created, unchanged,
updated, superseded), raw bytes and hashes, chunk spans cut from the text and rejected outside it, embedding
model and dimension checks, search by mode, jurisdiction, reliability and current version, gold resolution
(found, ambiguous, missing), timed search, and grants.

Python unit and contract tests through Caddy, phase 1 and phase 2 together, evidence
`reports/phase2/03-pytest-unit-contract-sandbox.log`:

```
$ pytest -v -rs tests/unit tests/contract      (FS_API_BASE = sandbox Caddy, FS_FIXTURES_BASE = fixture server)
tests/contract/test_kb.py::test_ingest_requires_admin_role PASSED
tests/contract/test_kb.py::test_ingest_validation PASSED
tests/contract/test_kb.py::test_ingest_outcomes_per_source PASSED
tests/contract/test_kb.py::test_robots_rules_respected PASSED
tests/contract/test_kb.py::test_documents_chunks_and_embeddings_stored PASSED
tests/contract/test_kb.py::test_reingest_unchanged_is_skipped PASSED
tests/contract/test_kb.py::test_force_creates_new_version_and_search_sees_only_current PASSED
tests/contract/test_kb.py::test_retried_request_returns_the_same_job PASSED
tests/contract/test_kb.py::test_job_status_visibility PASSED
tests/contract/test_kb.py::test_eval_run_end_to_end PASSED
tests/contract/test_kb.py::test_eval_with_unresolvable_gold_fails_the_job PASSED
tests/contract/test_kb.py::test_eval_validation PASSED
SKIPPED [1] tests/contract/test_health_and_failures.py:160: checks raw n8n behaviour without the proxy
=================== 72 passed, 1 skipped in 92.86s (0:01:32) ===================
```

Failure paths exercised: non-admin and anonymous callers, invalid bodies, unknown jurisdiction, a page
disallowed by robots.txt for every agent, a page disallowed only for our user agent, a page with no
content, a 404, an unchanged re-fetch, a forced re-fetch, a retried request with the same idempotency
key, job status seen by another user, malformed and unknown job ids, an evaluation whose gold cannot be
located. Other checks: `python3 n8n/build.py --check` (up to date), `caddy validate` (valid), secret scan
(detect-secrets no new findings; one Hugging Face commit id marked with an allowlist comment).

Failures found while building this phase: F-023, F-024, F-025.

---

## T-19 First phase-2 run on the owner's PC (2026-10-01T02:10+01:00) - FAILED in contract tests (F-026)

Evidence: `reports/verify-20261001-021026/summary.txt` and `verify.log` on the owner's PC.

```
PASS  every pinned image tag exists in its registry  (exit 0, 82.6 s)          (includes the TEI image)
PASS  pull service images (largest download: Ollama, n8n)  (exit 0, 193.2 s)
PASS  wait for TEI (multilingual-e5-large; first start downloads the model, max 45 min)  (exit 0, 1662.7 s)
PASS  PHASE 2: TEI embeds 1024 numbers with multilingual-e5-large and tokenizes with offsets  (exit 0, 1.4 s)
PASS  PHASE 1 and 2: database tests (pgTAP on the compose PostgreSQL)  (exit 0, 1.6 s)
PASS  unit tests, JavaScript (Code-node helpers, chunkers, metrics, workflow checks)  (exit 0, 0.9 s)
FAIL  PHASE 1 and 2: unit and contract tests through the proxy (includes outage tests unless -SkipOutages)  (exit 1, 98.5 s)
PASS  export workflows from n8n and scan for secrets  (exit 0, 10.4 s)
```

```
TEI info {"model_id":"intfloat/multilingual-e5-large","model_sha":"3d7cfbdacd47fdda877c5cd8a79fbcc4f2a574f3","model_dtype":"float32",
  ... "max_input_length":512,"max_batch_tokens":16384,"max_batch_requests":8,"max_client_batch_size":64,"auto_truncate":true, ... "version":"1.9.4"}
embed status 200 dims [1024, 1024, 1024, 1024] l2_norms [1.0, 1.0, 1.0, 1.0] seconds_for_4_texts 0.6
tokenize tokens 32 max stop 71 chars 45 utf8 bytes 71 offset unit byte
Files=7, Tests=193 ... Result: PASS                      (PostgreSQL 18.6, all migrations 0001 to 0007)
========= 1 failed, 63 passed, 1 skipped, 8 errors in 96.56s (0:01:36) =========
E       AssertionError: (404, '{"request_id":"...","error":{"code":"NOT_FOUND","message":"Route not found","details":[]}}')
```

All 9 failures and errors are `GET /v1/jobs/{id}` answered by the proxy's 404 (F-026). The TEI sample text
reached TEI garbled (F-027): the embedding dimensions and the byte-offset result are valid, the token texts
and the 0.6 s timing are not about the intended sentence. The first `kb.ps1 -Step ingest` was stopped by the
owner with no output (F-028); whether its job finished in n8n is not known.

## T-20 Fixes for F-026 to F-028, sandbox (2026-10-01) - PASS, with mocks for TEI and Ollama

Caddyfile rewritten as one ordered `route`; checked with Caddy 2.6.2 only (2.11.4 is checked by the next
`verify.ps1` run on the owner's PC). Same sandbox setup as T-18.

```
$ caddy validate --config infra/caddy/Caddyfile --adapter caddyfile
Valid configuration
$ pytest -v -rs tests/unit tests/contract
tests/contract/test_kb.py::test_parameterised_routes_reach_their_workflows PASSED
tests/contract/test_health_and_failures.py::test_oversized_body_rejected_by_proxy PASSED
================== 74 passed, 1 skipped in 107.31s (0:01:47) ===================
$ psql ... insert a kb_ingest job for QZ marked running since 4 hours; python3 scripts/kb.py ingest --jurisdiction QZ ...
job 0e88f46f-... (kb_ingest) was still marked running after 4.0 h: marked failed (abandoned)
/v1/admin/kb/ingest: job 30e8ce47-... accepted
      0.3s  job running
      2.5s  job succeeded
ingest succeeded in 3 s: {"ok": 0, "failed": 0, "skipped": 1}
```

---

## T-21 First TN ingestion on the owner's PC (2026-10-01T23:58+01:00) - 11 ok, 4 skipped, 5 failed

Command: `scripts\windows\kb.ps1 -Step ingest` after `verify.ps1` (T-21a below). Evidence:
`reports/kb-20261001-235825/kb.log` on the owner's PC. Real services: TEI (multilingual-e5-large, CPU), Ollama
(bge-m3, GPU), sources fetched from their sites.

```
job 96476bcc-... (kb_ingest) was still marked running after 21.1 h: marked failed (abandoned)
/v1/admin/kb/ingest: job c1289795-... accepted
      1284.0s  job failed
ingest failed in 1285 s: {"ok": 11, "failed": 5, "skipped": 4}
  failed   gl-123loger-arnaques               chunk span outside the document text
  failed   gl-gestetud-arnaques               chunk span outside the document text
  failed   gl-twenty-campus-arnaques          chunk span outside the document text
  ok       tn-cdet-2017                       unchanged fixed_500_50: 87 chunks, structure_aware_v1: 151 chunks
  skipped  tn-coc-ar                          robots
  skipped  tn-coc-fr                          robots
  ok       tn-cyriljarnias-location           created fixed_500_50: 20 chunks, structure_aware_v1: 29 chunks
  ok       tn-diwan-location                  created fixed_500_50: 3 chunks, structure_aware_v1: 4 chunks
  ok       tn-dpo-consulting-loi              created fixed_500_50: 18 chunks, structure_aware_v1: 57 chunks
  ok       tn-houni-colocation-tunis          created fixed_500_50: 3 chunks, structure_aware_v1: 9 chunks
  skipped  tn-inpdp-procedures                robots
  ok       tn-lapresse-arnaque-sousse         created fixed_500_50: 2 chunks, structure_aware_v1: 7 chunks
  skipped  tn-lo-2004-63-ar                   robots
  ok       tn-lo-2004-63-fr                   created fixed_500_50: 29 chunks, structure_aware_v1: 47 chunks
  ok       tn-loi-76-35-recueil               created fixed_500_50: 62 chunks, structure_aware_v1: 94 chunks
  ok       tn-mehat-logement-locatif-2014     created fixed_500_50: 72 chunks, structure_aware_v1: 90 chunks
  ok       tn-notaire-tunisienumerique        created fixed_500_50: 5 chunks, structure_aware_v1: 21 chunks
  ok       tn-profiscal-det-ch7-2006          created fixed_500_50: 17 chunks, structure_aware_v1: 51 chunks
  failed   tn-web6-droits-locataire           fetch_http_404 https://web6.tn/blog/droits-devoirs-locataire-proprietaire-tunisie-2026/
  failed   tn-web6-inpdp                      chunk span outside the document text
```

`tn-cdet-2017` was "unchanged": the job started the day before (and abandoned by the script) had processed it,
which shows the n8n job kept running after the script was stopped (F-028). The 1284 s include all fetches,
tokenization, and both embedding models for the 11 documents processed in this job; per-source times are in
`kb.ingest_log` and are not broken down here. Structure found by the parser in the exported texts (a script run on
the owner's PC): `tn-lo-2004-63-fr` 104 of 105 articles (missed "Article. 5 :", fixed), `tn-loi-76-35-recueil`
109 articles, `tn-cdet-2017` 152 articles and 68 headings. Failures: F-030, F-031; sources: D-047.

T-21a, the `verify.ps1` run before it (`reports/verify-20261001-234933`): every step passed except the contract
tests, 73 passed and 1 failed (`test_documents_chunks_and_embeddings_stored`, F-029). The parameterised routes
now answer through Caddy 2.11.4 (F-026 fixed on the real proxy).

## T-22 Fixes for F-029 to F-031, sandbox (2026-10-02) - PASS, with mocks for TEI and Ollama

```
$ node --test n8n/tests/*.test.js kb/tests/*.test.js eval/tests/*.test.js
# pass 50
# fail 0
$ pytest -v -rs tests/unit tests/contract
=================== 74 passed, 1 skipped in 92.89s (0:01:32) ===================
```

One earlier sandbox run in this round failed 5 tests because two pytest processes ran at the same time and one
left the setting `ollama.embed_model` at a test value; the setting was reset and the suite re-run alone (the
result above, `reports/phase2/05-pytest-after-f029-f030-sandbox.log`). The extraction options were checked on the
owner's PC against the saved raw pages; the decoding fix is checked by the next `verify.ps1`.

## T-23 Second TN ingestion on the owner's PC (2026-10-02T00:54+01:00) - 14 ok, 9 skipped, 8 failed

`verify.ps1` before it (`reports/verify-20261002-003947`): every step passed except the contract tests, 72 passed
and 2 failed (`test_ingest_outcomes_per_source`: "3 of 7 sources failed"; `test_documents_chunks_and_embeddings_stored`:
`test-law-ar` missing). Cause: F-032. Then `scripts\windows\kb.ps1 -Step ingest`
(`reports/kb-20261002-005429/kb.log`), real TEI (CPU) and Ollama (GPU):

```
/v1/admin/kb/ingest: job 8a9b38e3-5d45-49c8-853f-9b68c2cc770d accepted
   1292.6s  job failed
ingest failed in 1294 s: {"ok": 14, "failed": 8, "skipped": 9}
  skipped  tn-coc-ar                          robots  robots_unreachable_503 [robots.txt HTTP 503]
  failed   tn-coc-ar-cawtar                   source_workflow  The connection was aborted, perhaps the server is offline
  skipped  tn-coc-fr                          robots  robots_unreachable_503 [robots.txt HTTP 503]
  failed   tn-coc-jurisite-727-738            source_workflow  decoding_failed utf-8: 24 replacement characters [line 292]
  (same error for 739, 740-746, 747, 748-757, 758-766, 791-804)
  ok       tn-coc-jurisite-767-790            created fixed_500_50: 6 chunks, structure_aware_v1: 13 chunks
  ok       tn-coc-jurisite-805-827            created fixed_500_50: 6 chunks, structure_aware_v1: 13 chunks
  skipped  tn-inpdp-procedures                robots  robots_unreachable [robots.txt HTTP 0]
  ok       tn-justice-questions-civiles       created fixed_500_50: 9 chunks, structure_aware_v1: 26 chunks
  skipped  tn-lo-2004-63-ar                   robots  robots_unreachable [robots.txt HTTP 0]
  ok       tn-lo-2004-63-ar-igppp             created fixed_500_50: 49 chunks, structure_aware_v1: 76 chunks
  ok       gl-123loger-arnaques, gl-gestetud-arnaques, gl-twenty-campus-arnaques, tn-cyriljarnias-location,
           tn-diwan-location, tn-dpo-consulting-loi, tn-houni-colocation-tunis, tn-lapresse-arnaque-sousse,
           tn-notaire-tunisienumerique, tn-web6-inpdp: "updated" (new extraction options, F-031; emoji fix, F-030)
  skipped  tn-cdet-2017, tn-lo-2004-63-fr, tn-loi-76-35-recueil, tn-mehat-logement-locatif-2014,
           tn-profiscal-det-ch7-2006: unchanged
```

The four pages that failed with "chunk span outside the document text" in T-21 (F-030) now pass. Failures: F-032
(jurisite pages), F-033 (CAWTAR). Robots reasons: D-047. The export lists 22 current documents (3 of them test
fixtures); `tn-coc-ar-cawtar` is among them with its chunks but incomplete embeddings. Per-source times were not
broken down (they are in `kb.ingest_log`).

## T-24 Fixes for F-032 and F-033, sandbox (2026-10-02) - PASS, with mocks for TEI and Ollama

The sandbox fixture server was changed from Python's `http.server` to `caddy file-server` (same header as the
PC). Before the fix, with that server, the PC failure reproduced exactly
(`reports/phase2/06-f032-reproduced-caddy-fixtures.log`):

```
E       AssertionError: assert '3 of 7 sources failed' == '2 of 7 sources failed'
======================== 2 failed, 11 passed in 18.56s =========================
```

Concurrency of embedding requests, counted by the mocks (`GET /_mock/stats`, each request held 300 ms), for a
forced re-ingestion of `test-law-fr` with batch sizes set to 1 (10 requests per model):

```
old workflow (HEAD 8309941): tei {"max_in_flight": 3, "embed_requests": 10}  ollama {"max_in_flight": 3, "embed_requests": 10}
new workflow (Embed loop):   tei {"max_in_flight": 1, "embed_requests": 10}  ollama {"max_in_flight": 1, "embed_requests": 10}
```

The two jurisite pages saved on the PC, decoded with the new code: `utf-8+windows-1252`, 24 invalid bytes,
0 replacement characters in the extracted text, extracted length unchanged (8,697 and 9,643 characters). The seven
failed pages were not saved (they failed before storage); the next ingestion checks them.

```
$ node --test n8n/tests/*.test.js kb/tests/*.test.js eval/tests/*.test.js
# tests 54
# pass 54
# fail 0
$ pytest -v -rs tests/unit tests/contract
=================== 74 passed, 1 skipped in 97.93s (0:01:37) ===================
```

Logs: `reports/phase2/07-js-unit-after-f032-f033.log`, `reports/phase2/08-pytest-after-f032-f033-sandbox.log`.
The database was not changed in this round, so pgTAP was not re-run (193 tests passed in T-22 and on the PC).

## T-25 Tenth compose run and third TN ingestion on the owner's PC (2026-10-02) - contract tests FAILED (F-034), ingestion reached no site (F-035)

`verify.ps1` at 06:01 (`reports/verify-20261002-060113`): every step passed except the contract tests,
72 passed, 2 failed. `test-law-ar` now passes on the PC (F-032 fixed under Caddy). The two failures:

```
E       AssertionError: assert ['TST art. 1-...'TST art. 13'] == ['TST art. 1-...'TST art. 13']
E         At index 0 diff: 'TST art. 1-10' != 'TST art. 1-12'
E         Left contains one more item: 'TST art. 13'
E       AssertionError: assert [(2,), (3,)] == [(2,)]
============= 2 failed, 72 passed, 1 skipped in 118.27s (0:01:58) ==============
```

Both are test defects (F-034). `kb.ps1 -Step ingest` at 10:55 (`reports/kb-20261002-105540/kb.log`):

```
/v1/admin/kb/ingest: job 4e6bf5d7-52b4-4589-a181-2789cc23ebf5 accepted
ingest succeeded in 24 s: {"ok": 0, "failed": 0, "skipped": 31}
skipped gl-123loger-arnaques robots robots_unreachable [robots.txt HTTP 0]
(the same for all 31 sources)
```

No site answered; the cause on the PC is not known (F-035). The stored documents were not changed, so the
export is the same 22 documents as in T-23 plus `test-law-ar` from the verify run. F-033 (CAWTAR) and the seven
jurisite pages are still not checked on the PC.

## T-26 Fixes for F-034 and F-035, sandbox (2026-10-02) - PASS, with mocks for TEI and Ollama

```
$ node --test n8n/tests/*.test.js kb/tests/*.test.js eval/tests/*.test.js
# tests 54
# pass 54
# fail 0
$ pytest -v -rs tests/contract/test_kb.py
tests/contract/test_kb.py::test_no_network_fails_the_job PASSED          [ 57%]
============================= 14 passed in 23.47s ==============================
$ pytest -v -rs tests/unit tests/contract
=================== 75 passed, 1 skipped in 99.31s (0:01:39) ===================
```

Job error and source reason from the new test, read from `app.jobs`:

```
no_network: robots.txt unreachable for all 2 sources (getaddrinfo ENOTFOUND offline-1.invalid)
robots_unreachable [robots.txt HTTP 0] getaddrinfo ENOTFOUND offline-1.invalid
```

The `kb.ps1` internet check (the same `node -e` script, run with the sandbox's Node 22 against one real host and
one `.invalid` host) printed `https://www.justice.gov.tn/robots.txt HTTP 403` (the sandbox's egress proxy answers
403) and `network error: ENOTFOUND`, exit 0; it exits 1 only when no host answers. It was not run in Windows
PowerShell here. Log: `reports/phase2/09-pytest-after-f034-f035-sandbox.log`.

---

## Not run

| Item | Why | How it will be run |
|---|---|---|
| Phase 2 on the compose stack: real TEI and Ollama, real sources, gold set, evaluation numbers | sandbox cannot reach the models or the sites (F-002) | `verify.ps1`, then `kb.ps1 -Step ingest`, gold set, `kb.ps1 -Step eval` |
| Steady-state embedding latency; whether Ollama uses the GPU | not measured in T-13 | ingestion timings in the phase 2 run; `ollama ps` |
| Reproduction from a clean machine using README only | T-13 ran in the owner's working folder, not a fresh clone | before submission (phase 9) |
| Request latency on the compose stack | T-8 is sandbox only | phase 9 load test |
| Load test, backup/restore | phase 9 | — |
