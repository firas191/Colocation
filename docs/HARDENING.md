# Hardening status (platform P12)

Where each item of PLATFORM_SPEC 9 P12 stands. "Sandbox" means the cloud test environment, with the model and the
storage mocked; numbers from there are not the PC's. Anything not measured says so. Decision: D-111. Tests: T-77.

Section 15 of the backend spec (test strategy) is the list it is checked against: the security checks of 15.4 and
the load and restore layers of 15.1 are below with their evidence.

## Security

| Item | Status | Evidence |
|---|---|---|
| Isolation matrix over every endpoint | Done, sandbox | `tests/contract/test_isolation_matrix.py`: every operation whose path names a resource (66 of them since D-115) is called by a signed-in outsider with a valid body and answers 403 or 404, and nothing changed afterwards. Eight paths are public on purpose or only touch the caller's own rows (two added with D-115: asking a visible profile to get in touch, and the sentence for its score); they are listed in the file with the reason. A new path in `docs/openapi.yaml` that is in neither list fails the test. Lists without a path id (`/v1/conversations`, `/v1/me/...`) are covered by `test_isolation.py` and each phase's tests |
| Row-level rules | Done (each phase) | pgTAP `190` checks every `api.*` function is owned by `app_rls`, `020` that no function of the internal schemas is executable by PUBLIC; each phase's pgTAP file checks its own tables |
| CSRF and origin checks on the website server | Done, checked on the source | Changes go through Next.js server actions (Next.js refuses them when `Origin` does not match the host) or the Better Auth handler (checks `Origin` against its URL). `web/tests/safety.test.ts` fails if any other route handler accepts POST, PUT, PATCH or DELETE, or if `allowedOrigins`, `disableCSRFCheck` or `disableOriginCheck` appears. Not exercised against a running server in the sandbox |
| Stored text shown without HTML injection | Done | React escapes text; `web/tests/safety.test.ts` fails on `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `javascript:` links anywhere in the website. PDFs: `doc_fill.js` escapes every value (`test_platform_documents.py` puts `<b>tache</b>` in and reads it back as text). Telegram and e-mail texts are escaped in `notify_compose.js` |
| Browser never calls n8n | Done | `web/tests/safety.test.ts`: only `lib/server/api.ts` reads the API address and signing key; no file names port 5678 or `/webhook/`; browser code imports no server code; server modules with secrets import `server-only` |
| Server-side request forgery (15.4) | Done, sandbox | The only workflow that fetches a URL from data is knowledge-base ingestion. `n8n/src/lib/url_guard.js` refuses other schemes, user:password in the URL, Docker service names and other names without a dot, `localhost`, `.local`, `.internal`, and loopback, private, link-local and metadata addresses in every IPv4 and IPv6 spelling, before any request (`n8n/tests/url_guard.test.js`; `test_kb.py` checks a job with `http://postgres:5432/` and `169.254.169.254` fails with both reasons). Not covered: a public name whose DNS answer is private, and redirects |
| Other 15.4 checks | Done in earlier phases | Unsigned, wrongly signed and replayed requests: `test_gateway_auth.py`. SQL injection strings stored literally: `test_users_sync.py` (every SQL call is parameterised). Rate limits: `RATE_LIMITED` cases in `test_gateway_auth.py`, `test_platform_contact.py`. Secrets: `scripts/secret-scan.sh` (no new findings, T-77). Prompt injection items are in each agent's golden set and reported by its bench (`docs/PROMPT_EVAL.md`, `reports/eval/`); whether every active prompt passes them is in those reports, not re-run here. Asking an assistant for another person's data: no dedicated test. The agents' tools take the person from the session, not from what the model writes (for example `doc_tool_plan.js`, `owner_tool_changes.js`), and household data goes through `api.*` with row-level rules; not measured |
| Upload limits | Done (earlier phases) | Declared size per kind refused at presign (`media.max_bytes`, `test_intake_media.py` `too_large`); the proxy cuts uploads over 100 MiB and API bodies over 1 MiB; the Media service refuses an object larger than its limit before reading it (`services/media/tests`) |

## Load

| Item | Status | Evidence |
|---|---|---|
| Load test on search and messages (15.1) | Measured on the PC (T-78) | `scripts/load_bench.py` via `scripts\windows\p12.ps1 -Step load`: 1, 5, 10 and 20 workers for 30 s each, `GET /v2/search` and send-then-read in `/v1/conversations/{id}/messages`, each worker its own user, rate limits raised for the run. Search p95: 352, 686, 1309 and 2252 ms; about 9 searches per second at most. Message pairs: send p95 183, 465, 880 and 1725 ms; about 7 pairs per second at most. No errors. Backend spec target, search p95 under 1.5 s: met up to 10 workers, missed at 20. Limit found: one queue (latency grows with workers once throughput stops), not yet traced to a component. Data volume: 75 published TN listings, not a realistic volume |

## Backup and restore

| Item | Status | Evidence |
|---|---|---|
| Databases | Done, tested in the sandbox | `scripts/db-backup.sh` dumps `flatshare`, `n8n` and `auth` with a fingerprint from the same snapshot (`scripts/db-fingerprint.sql`: rows per table, owners, grants, row-level rules, functions, policies, triggers, extensions), so it matches the dump even while n8n writes. `scripts/db-restore.sh` restores and compares. Sandbox, n8n running: the three databases and `flatshare_test` restored into scratch databases, every fingerprint equal. A drop and restore of a copy undid a row added and a grant revoked after the backup. A copy with a revoked grant and row-level security switched off was caught by the comparison |
| A restored database passes the database tests (15.1) | Done, sandbox | The restored copy of `flatshare_test` (built from the migrations) passes the 712 pgTAP tests. The suite is not run on a restored copy of the live database: its fixtures expect only what the migrations put there and collide with real rows (tried in the sandbox: 8 of 29 files fail, on duplicate fixtures and row counts) |
| Photos and documents (Garage) | Script ready, not run (no Docker in the sandbox) | `scripts/windows/backup.ps1` stops Garage for the copy and tars its two volumes; `restore.ps1` puts them back |
| On the PC | PASS (T-78) | `scripts\windows\p12.ps1 -Step backup-check`: flatshare (54,218 rows), n8n, auth and flatshare_test restored into scratch databases, every fingerprint equal, 712 database tests PASS on the restored flatshare_test |

Not in any backup: `.env` and `secrets\`. They hold the passwords and the n8n encryption key; without the same key
the n8n credentials in the dump cannot be read. Keep a copy of both apart from the backups.

## Not done

| Item | Why |
|---|---|
| Full ablation matrix, single-agent comparison | Needs the real model on the PC; the benches of each agent exist (`p4.ps1` steps), the matrix run and its report do not |
| Prompt library and evaluation documents generated from data | `docs/PROMPT_EVAL.md` is generated for P1 to P3 (`p4.ps1 -Step report`); not extended to the agents of P8 and P9 |
| Accessibility pass | Partly | axe-core runs in the e2e tests on the account, search and owner pages (no serious or critical violation, `web/e2e/helpers.ts` `expectAccessible`), with the right-to-left test (`web/tests/rtl.test.ts`). The pages added in P5 to P11 (household, documents, move-out, admin) are not audited yet |
| README run from a clean machine | Not done; needs a second machine |
