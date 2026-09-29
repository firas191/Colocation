# PostgreSQL 17 + PostGIS 3.5 (base image) + pgvector (built from a pinned tag)
# + pgTAP and pg_prove (tests) + dbmate (migrations). See docs/VERSIONS.md.
FROM amacneil/dbmate:2.36.0 AS dbmate

FROM postgis/postgis:17-3.5
ARG PGVECTOR_TAG=v0.8.6
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        build-essential git ca-certificates postgresql-server-dev-17 \
        postgresql-17-pgtap libtap-parser-sourcehandler-pgtap-perl; \
    git clone --branch "$PGVECTOR_TAG" --depth 1 https://github.com/pgvector/pgvector.git /tmp/pgvector; \
    make -C /tmp/pgvector OPTFLAGS=""; \
    make -C /tmp/pgvector install; \
    rm -rf /tmp/pgvector; \
    apt-get purge -y --auto-remove build-essential git postgresql-server-dev-17; \
    rm -rf /var/lib/apt/lists/*
# dbmate is a static Linux binary (upstream Makefile links with -static).
COPY --from=dbmate /usr/local/bin/dbmate /usr/local/bin/dbmate
RUN dbmate --version && pg_prove --version
