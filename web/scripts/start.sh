#!/bin/sh
# Container entrypoint. The website's API key comes from the file db-bootstrap writes (secrets/api-clients.env,
# mounted read-only). db-bootstrap writes it as root with mode 600, so this script starts as root only to read the
# website's two lines (the tests key in the same file is not exported); the server itself runs as the node user
# (run-as-node.cjs drops root before Next.js loads). F-071.
set -eu
f=/secrets/api-clients.env
if [ -z "${FLATSHARE_WEBSITE_SECRET:-}" ]; then
  if [ ! -r "$f" ]; then
    echo "start.sh: cannot read $f (the website's API key; db-bootstrap writes it)" >&2
    exit 1
  fi
  FLATSHARE_WEBSITE_KEY_ID=$(sed -n 's/^FLATSHARE_WEBSITE_KEY_ID=//p' "$f")
  FLATSHARE_WEBSITE_SECRET=$(sed -n 's/^FLATSHARE_WEBSITE_SECRET=//p' "$f")
  export FLATSHARE_WEBSITE_KEY_ID FLATSHARE_WEBSITE_SECRET
fi
if [ -z "${FLATSHARE_WEBSITE_SECRET:-}" ]; then
  echo "start.sh: FLATSHARE_WEBSITE_SECRET is empty (no website line in $f?)" >&2
  exit 1
fi
exec node run-as-node.cjs
