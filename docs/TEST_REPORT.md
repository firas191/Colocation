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

**Secret scan.** detect-secrets: `no new findings`. The exact-match step failed on five files;
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

## Not run (phase 0 and 1)

| Item | Why | How it will be run |
|---|---|---|
| verify.ps1 step "export workflows from n8n and scan for secrets" with the fixed script | fix made after T-13; its parts ran separately in T-14 | next verify.ps1 run |
| Steady-state embedding latency; whether Ollama uses the GPU | not measured in T-13 | phase 2, on the knowledge-base load (`ollama ps` shows the processor) |
| Reproduction from a clean machine using README only | T-13 ran in the owner's working folder, not a fresh clone | before submission (phase 9) |
| Request latency on the compose stack | T-8 is sandbox only | phase 9 load test |
| Load test, backup/restore | phase 9 | — |
