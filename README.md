# Flatshare backend

Backend of a worldwide flatshare platform, built on n8n for the ESPRIT Advanced Deep Learning
final project (AI automation). Specification: `FLATSHARE_BACKEND_SPEC.md` (one folder up).
This repository is at **phase 1 of 10** (environment, database, API gateway). No frontend.

## Requirements

- Windows 10/11 with Docker Desktop (WSL 2 backend), or Linux/macOS with Docker Engine and Compose v2.
- About 10 GB of free disk for images and the embedding model.
- Optional: an NVIDIA GPU visible to Docker (checked automatically).
- Internet access for the first build (images, pgvector source, the `bge-m3` model).

## Run and verify (Windows)

```powershell
cd D:\Projects\coloc\flatshare
powershell -ExecutionPolicy Bypass -File scripts\windows\verify.ps1
```

This creates `.env` with random secrets if it does not exist, builds the images, starts the
stack, pulls `bge-m3`, and runs every check: embedding dimension, database tests, unit tests,
contract tests through the proxy (including outage tests that stop and restart containers),
and a secret scan. Results: `reports\verify-<timestamp>\summary.txt` and `verify.log`.
Add `-Cpu` to ignore the GPU, `-SkipOutages` to skip the tests that stop containers.

Linux/macOS: `scripts/setup-env.sh`, then `docker compose up -d` and the commands in `docs/RUNBOOK.md`.

After start:

- API (through the proxy): http://localhost:8080/v1/... (signed requests only, see `docs/API_SIGNING.md`)
- n8n editor: http://localhost:5678 (create the owner account on first visit)
- API keys: `secrets/api-clients.env` (not committed)

## What exists

| Area | State |
|---|---|
| Database | 6 migrations (baseline schema unchanged + gateway, security fixes, settings, rate limits, request log), 156 pgTAP assertions |
| API | `GET /v1/health`, `POST /v1/users/sync`, signed-request gateway with replay protection, rate limits, idempotency, error envelope; `docs/openapi.yaml` |
| n8n workflows | `wf.gateway.auth`, `wf.api.health`, `wf.api.users_sync`, `wf.ops.error_handler` |
| Not yet | knowledge base and RAG (phase 2), agents and prompts (3 to 6), multimodal services (4), documents and privacy workflows (7), evaluation (8), hardening (9), 3D (10) |

## Layout

```
docker-compose.yml, docker-compose.gpu.yml, .env.example
infra/        postgres image, Caddyfile, garage.toml, test-runner image
db/           migrations (dbmate), tests (pgTAP), seed, baseline (original files)
n8n/          build.py, src (Code-node JS), workflows (generated JSON), tests
scripts/      db-bootstrap.sh, n8n-setup.sh, db-test.sh, secret-scan.sh, setup-env.sh, windows/*.ps1
tests/        client (signing reference), contract, unit, mocks (sandbox only), vectors
docs/         DECISIONS, FAILURES, TEST_REPORT, VERSIONS, ARCHITECTURE, API_SIGNING, RUNBOOK, openapi.yaml
reports/      evidence logs (phase1: sandbox runs; verify-*: runs on the owner's machine)
```
