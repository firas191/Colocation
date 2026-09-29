# Runbook

Commands assume the repository root. On Windows use PowerShell; `docker compose` is the same everywhere.

## Start, stop, reset

| Task | Command |
|---|---|
| First start (creates `.env` if missing, builds, starts, runs every check) | `powershell -ExecutionPolicy Bypass -File scripts\windows\verify.ps1` |
| Start (CPU) | `docker compose up -d` |
| Start with the NVIDIA GPU | `docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d` |
| Status | `docker compose ps -a` |
| Stop, keep data | `docker compose down` |
| Delete all data (database, storage, models, n8n) | `docker compose down -v` then delete `secrets\api-clients.env` |

One-shot services run on every `up`: `db-bootstrap` (migrations are idempotent, existing API keys are kept),
`n8n-setup` (re-imports credentials and workflows with the same ids, then publishes them), `ollama-pull`.

## Logs

- Service logs: `docker compose logs -f n8n` (or `postgres`, `proxy`, `garage`, `ollama`).
- API requests: table `ai.executions` (one row per request: workflow, status, latency, error code and reason).
  `docker exec -u postgres fs-postgres psql -d flatshare -c "select started_at, workflow, status, latency_ms, error from ai.executions order by started_at desc limit 20"`
- Failed n8n executions (with input data, kept 7 days): n8n editor, http://localhost:5678, Executions.

## Changing a workflow

1. Edit `n8n/build.py` (graph, SQL) or `n8n/src/nodes/*.js` / `n8n/src/lib/*.js` (Code node logic).
2. `python n8n/build.py` (writes `n8n/workflows/*.json`); `node --test n8n/tests/canonical.test.js`.
3. `docker compose up -d --force-recreate n8n-setup n8n` (imports and publishes, restarts n8n).
4. Run the contract tests (below).

A change made in the n8n editor is lost at the next `n8n-setup` run unless it is ported back to the source files.
`python n8n/build.py --check` fails when committed JSON and sources differ.

## Database changes

Add `db/migrations/NNNN_description.sql` with `-- migrate:up` / `-- migrate:down`, add or extend a
pgTAP file in `db/tests/`, then run `docker exec -u postgres fs-postgres bash /flatshare/scripts/db-test.sh`
(builds a throw-away database `flatshare_test` from all migrations and runs every test file).
Never edit a migration that has been applied on a machine you keep.

## Tests

| Suite | Command |
|---|---|
| Database (pgTAP) | `docker exec -u postgres fs-postgres bash /flatshare/scripts/db-test.sh` |
| JavaScript unit | `docker compose run --rm --no-deps -v "${PWD}:/flatshare:ro" --entrypoint node n8n --test /flatshare/n8n/tests/canonical.test.js` |
| Python unit + contract (through the proxy; includes outage tests that stop containers) | `docker compose --profile test run --rm --no-deps tests pytest -v -rs tests/unit tests/contract` |
| Same without outage tests | add `-k "not down and not unreachable"` |
| Secret scan | `docker compose --profile test run --rm --no-deps tests bash scripts/secret-scan.sh "" .env secrets/api-clients.env` |

The contract tests need `N8N_IMPORT_TEST_WORKFLOWS=1` at `up` time (verify.ps1 sets it) for the error-handler test.

## API keys

- Keys are created by `db-bootstrap` for `website` and `tests`; secrets are appended to `secrets/api-clients.env`.
- New key: `docker exec -u postgres fs-postgres psql -d flatshare -At -c "select secret from sec.create_api_client('name', 'description')"`.
- Revoke: `update sec.api_clients set active = false, revoked_at = now() where key_id = 'name';` (as postgres).
- The website server needs `FLATSHARE_API_BASE`, `FLATSHARE_WEBSITE_KEY_ID`, `FLATSHARE_WEBSITE_SECRET`.

## Settings without restart

Non-secret runtime settings are rows in `app.settings` (rate limits, timestamp window, Ollama URL, model name).
Example: `update app.settings set value = '120' where key = 'gateway.rate_limit_user_per_min';`

## Known gaps (phase 1)

- During a full PostgreSQL outage requests are answered with 503 but not logged (FAILURES F-010).
- `app.idempotency_keys` and `app.rate_counters` grow until the retention workflow exists (phase 7).
- No backup or restore procedure yet (phase 9).
