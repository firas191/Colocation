# Versions

Checked on 2026-09-29. "Pinned in" is the file that fixes the version. Image digests are
not pinned yet: the sandbox cannot reach Docker Hub, so digests are recorded from the
first `verify.ps1` run on the owner's machine (section "Recorded at run time").

## Compose stack (the deliverable)

| Component | Version | Pinned in | How the version was chosen (source, date) |
|---|---|---|---|
| n8n | 2.41.3 | docker-compose.yml `n8nio/n8n:2.41.3` | npm dist-tags `latest` and `stable` = 2.41.3 (`npm view n8n dist-tags`); Docker Hub tag pushed 2026-09-25 |
| n8n task runners | 2.41.3 | docker-compose.yml `n8nio/runners:2.41.3` | must equal the n8n version (n8n docs "set up task runners", fetched 2026-09-29) |
| PostgreSQL | 18 (minor from the base image) | infra/postgres/Dockerfile `postgis/postgis:18-3.6` | 18.6 is the current 18 minor (postgresql.org/support/versioning); major chosen in DECISIONS D-006 |
| PostGIS | 3.6 | same base image (built on `postgres:18-trixie`) | Docker Hub tag `18-3.6` updated 2026-08-10; the 17 images failed (FAILURES F-016, F-017) |
| pgvector | 0.8.x (PGDG package `postgresql-18-pgvector`; the build fails if it is not 0.8) | infra/postgres/Dockerfile | pgvector CHANGELOG: 0.8.6 released 2026-07-29; PGDG lists 0.8.6-1.pgdg13+1 builds; exact version recorded at run time |
| pgTAP, pg_prove | PGDG `postgresql-18-pgtap` (1.3.4-1.pgdg13+1 listed) | not pinned (test tool) | recorded at run time |
| dbmate | 2.36.0 | infra/postgres/Dockerfile `amacneil/dbmate:2.36.0` | npm `dbmate` 2.36.0 (2026-09-19); GitHub latest release |
| Garage | v2.4.1 | docker-compose.yml `dxflrs/garage:v2.4.1` | garagehq.deuxfleurs.fr/_releases.html: v2.4.1, 2026-09-08 |
| Ollama | 0.34.4 | docker-compose.yml `ollama/ollama:0.34.4` | GitHub "latest release" v0.34.4 (2026-09-23); newest stable tag on Docker Hub; a third-party tracker listed 0.35.0 on 2026-09-28 that is not on Docker Hub yet |
| Embedding model | `bge-m3` (Ollama library) | `.env` `EMBED_MODEL` | spec default; model digest recorded at pull time |
| Caddy | 2.11.4 | docker-compose.yml `caddy:2.11.4-alpine` | Docker Hub tag updated 2026-09-23 |
| Redis (profile `queue` only) | 8.10.2 | docker-compose.yml `redis:8.10.2-alpine` | Docker Hub tag 8.10.2, 2026-09-24 |
| Test runner image | Python 3.12.14-slim, docker CLI 29.8.1 | infra/tests/Dockerfile | Docker Hub tags 3.12.14-slim (2026-09-25), 29.8.1-cli (2026-09-18) |
| Python test libraries | httpx 0.28.1, pytest 9.1.1, psycopg[binary] 3.3.6, detect-secrets 1.5.0, openapi-spec-validator 0.9.0, jsonschema 4.26.0, PyYAML 6.0.3 | infra/tests/requirements-dev.txt | latest on PyPI on 2026-09-29 (`pip index versions`) |

## Cloud sandbox (where phase 0 and 1 tests ran)

Different from the compose stack because the sandbox cannot pull images (FAILURES F-002).

| Component | Version | Source |
|---|---|---|
| OS | Ubuntu 24.04.4 LTS, 2 vCPU, 7.8 GB RAM, no GPU | `uname`, `free` |
| PostgreSQL | 16.13 | Ubuntu package `postgresql-16 16.13-0ubuntu0.24.04.1` |
| pgvector | 0.6.0 | Ubuntu package `postgresql-16-pgvector 0.6.0-1` (the version the spec's baseline test used) |
| PostGIS | 3.4.2 | Ubuntu package `postgresql-16-postgis-3 3.4.2+dfsg-1ubuntu3` |
| pgTAP / pg_prove | 1.3.2 / 3.36 | Ubuntu packages |
| dbmate | 2.36.0 | npm `dbmate@2.36.0` (static binary, sha256 47e284b3…ce) |
| n8n | 2.41.3 | npm `n8n@2.41.3` |
| Node.js | 24.21.0 | npm `node-linux-x64@24.21.0` (n8n 2.41.3 requires Node >= 24) |
| Caddy | 2.6.2 | Ubuntu package (older than the pinned 2.11.4) |
| Redis | 7.0.15 | Ubuntu package, used only for the F-004 spike |
| Python | 3.11.15 | system |
| Ollama, object storage | not available | replaced by `tests/mocks/deps_mock.py` for the health tests only |

## Recorded at run time

To be filled from the first `reports/verify-<timestamp>/verify.log` on the owner's machine:
image ids and digests, PostgreSQL minor version, pgvector/PostGIS/pgTAP versions as reported by
`pg_extension`, `bge-m3` model id, GPU model and memory if any.
