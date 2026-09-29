# PostgreSQL 18 + PostGIS 3.6 (base image, Debian 13 "trixie") + pgvector and pgTAP
# from the PostgreSQL project's apt repository (PGDG, already configured in the
# base image) + dbmate for migrations. No compilers are downloaded.
# Why 18 and not 17: docs/DECISIONS.md D-006, docs/FAILURES.md F-016 and F-017.
FROM amacneil/dbmate:2.36.0 AS dbmate

FROM postgis/postgis:18-3.6
RUN set -eux; \
    apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 update; \
    apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 install -y --no-install-recommends \
        postgresql-18-pgvector postgresql-18-pgtap libtap-parser-sourcehandler-pgtap-perl; \
    rm -rf /var/lib/apt/lists/*; \
    dpkg-query -W postgresql-18-pgvector postgresql-18-pgtap postgresql-18-postgis-3; \
    dpkg-query -W -f='${Version}' postgresql-18-pgvector | grep -q '^0\.8\.'
# dbmate is a static Linux binary (upstream Makefile links with -static).
COPY --from=dbmate /usr/local/bin/dbmate /usr/local/bin/dbmate
RUN dbmate --version && pg_prove --version
