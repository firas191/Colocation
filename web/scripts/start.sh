#!/bin/sh
# Container entrypoint: the website's API key comes from the file db-bootstrap wrote (secrets/api-clients.env,
# mounted read-only). Only the website's two lines are read; the tests key in the same file is not exported.
set -eu
f=/secrets/api-clients.env
if [ -z "${FLATSHARE_WEBSITE_SECRET:-}" ] && [ -f "$f" ]; then
  FLATSHARE_WEBSITE_KEY_ID=$(sed -n 's/^FLATSHARE_WEBSITE_KEY_ID=//p' "$f")
  FLATSHARE_WEBSITE_SECRET=$(sed -n 's/^FLATSHARE_WEBSITE_SECRET=//p' "$f")
  export FLATSHARE_WEBSITE_KEY_ID FLATSHARE_WEBSITE_SECRET
fi
exec node server.js
