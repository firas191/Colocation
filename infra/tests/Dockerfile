# Test runner: pytest contract/unit tests, secret scan, docker CLI for the
# outage tests (it talks to the Docker engine through the mounted socket).
FROM docker:29.8.1-cli AS docker
FROM python:3.12.14-slim
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory /flatshare
COPY requirements-dev.txt /tmp/requirements-dev.txt
RUN pip install --no-cache-dir -r /tmp/requirements-dev.txt
WORKDIR /flatshare
