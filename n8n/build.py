#!/usr/bin/env python3
"""Generate the n8n workflow JSON files from this definition and the Code node
sources in n8n/src. The JSON in n8n/workflows is the build output that gets
imported into n8n; do not edit it by hand (edits in the n8n editor must be
ported back here, see docs/RUNBOOK.md).

    python3 n8n/build.py            # writes n8n/workflows/*.json and n8n/workflows-test/*.json
    python3 n8n/build.py --check    # exits 1 if the committed JSON differs from the build
"""
import json
import re
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
NS = uuid.UUID("6f1b2c9e-3d4a-4b5c-8d7e-0f1a2b3c4d5e")  # namespace for stable node ids

PG_CRED = {"postgres": {"id": "fsCredPgWorker01", "name": "Flatshare DB (n8n_worker)"}}
ERROR_WF = "fsOpsErrorHndl01"
GATEWAY_WF = "fsGatewayAuth001"


def code(name):
    text = (SRC / "nodes" / name).read_text(encoding="utf-8")

    def include(m):
        # paths are relative to n8n/src, or to the repository root (kb/..., eval/...)
        for base in (SRC, ROOT.parent):
            p = base / m.group(1)
            if p.is_file():
                return p.read_text(encoding="utf-8")
        raise FileNotFoundError(m.group(1))

    return re.sub(r"/\* @include ([\w/.-]+) \*/", include, text)


class WF:
    def __init__(self, wid, name, tags=(), settings=None):
        self.wid, self.name, self.tags = wid, name, list(tags)
        self.nodes, self.conns = [], {}
        self.settings = {
            "executionOrder": "v1",
            "errorWorkflow": ERROR_WF,
            "saveDataSuccessExecution": "none",
            "saveDataErrorExecution": "all",
            "saveManualExecutions": True,
            "callerPolicy": "workflowsFromSameOwner",
        }
        if settings:
            self.settings.update(settings)
        self._x = 0

    def node(self, name, ntype, version, params, pos=None, **extra):
        if pos is None:
            pos = [self._x, 0]
            self._x += 220
        n = {
            "id": str(uuid.uuid5(NS, f"{self.wid}/{name}")),
            "name": name,
            "type": ntype,
            "typeVersion": version,
            "position": pos,
            "parameters": params,
        }
        n.update(extra)
        self.nodes.append(n)
        return name

    def link(self, src, dst, out=0):
        outs = self.conns.setdefault(src, {"main": []})["main"]
        while len(outs) <= out:
            outs.append([])
        outs[out].append({"node": dst, "type": "main", "index": 0})

    def json(self):
        return {
            "id": self.wid,
            "name": self.name,
            "active": False,
            "isArchived": False,
            "nodes": self.nodes,
            "connections": self.conns,
            "settings": self.settings,
            "pinData": {},
            "tags": [{"name": t} for t in self.tags],
        }


# ---------- node helpers ---------------------------------------------------
def code_node(wf, name, src, pos=None, subst=None, on_error=None):
    js = code(src)
    for k, v in (subst or {}).items():
        js = js.replace(k, v)
    extra = {"onError": on_error} if on_error else {}
    return wf.node(name, "n8n-nodes-base.code", 2, {"mode": "runOnceForAllItems", "language": "javaScript", "jsCode": js},
                   pos, **extra)


def http_node(wf, name, method, url, pos=None, body=None, fmt="text", full=False, never_error=False,
              timeout="={{ 30000 }}", headers=None, on_error=None):
    """HTTP Request node. body: expression producing a JSON string. fmt: text | file | json."""
    params = {"method": method, "url": url,
              "options": {"timeout": timeout,
                          "redirect": {"redirect": {"followRedirects": True, "maxRedirects": 5}},
                          "response": {"response": {"fullResponse": full, "neverError": never_error,
                                                    "responseFormat": fmt}}}}
    if fmt in ("text", "file"):
        params["options"]["response"]["response"]["outputPropertyName"] = "data"
    if headers:
        params["sendHeaders"] = True
        params["headerParameters"] = {"parameters": [{"name": k, "value": v} for k, v in headers]}
    if body is not None:
        params.update({"sendBody": True, "contentType": "json", "specifyBody": "json", "jsonBody": body})
    extra = {"onError": on_error} if on_error else {}
    return wf.node(name, "n8n-nodes-base.httpRequest", 4.2, params, pos, **extra)


def exec_wf(wf, name, wid, wname, wait=True, pos=None, on_error=None):
    extra = {"onError": on_error} if on_error else {}
    return wf.node(name, "n8n-nodes-base.executeWorkflow", 1.2, {
        "source": "database",
        "workflowId": {"__rl": True, "value": wid, "mode": "id", "cachedResultName": wname},
        "mode": "once",
        "options": {"waitForSubWorkflow": wait},
    }, pos, **extra)


def pg_node(wf, name, query, replacement, pos=None, on_error="continueErrorOutput", always_output=False, retries=0):
    params = {"operation": "executeQuery", "query": query, "options": {}}
    if replacement:
        params["options"]["queryReplacement"] = replacement
    extra = {"onError": on_error} if on_error else {}
    if retries:
        extra.update(retryOnFail=True, maxTries=retries + 1, waitBetweenTries=5000)
    return wf.node(name, "n8n-nodes-base.postgres", 2.6, params, pos, credentials=PG_CRED, alwaysOutputData=always_output, **extra)


def if_node(wf, name, expr, pos=None):
    params = {
        "conditions": {
            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "conditions": [{
                "id": str(uuid.uuid5(NS, f"{wf.wid}/{name}/cond")),
                "leftValue": expr,
                "rightValue": "",
                "operator": {"type": "boolean", "operation": "true", "singleValue": True},
            }],
            "combinator": "and",
        },
        "looseTypeValidation": True,
        "options": {},
    }
    return wf.node(name, "n8n-nodes-base.if", 2.2, params, pos)


def webhook(wf, method, path, hook_id, pos=None):
    return wf.node("Webhook", "n8n-nodes-base.webhook", 2.1,
                   {"httpMethod": method, "path": path, "responseMode": "responseNode", "options": {"rawBody": True}},
                   pos, webhookId=hook_id)


def route_node(wf, route, pos=None):
    js = (
        "// Route contract for this endpoint (read by wf.gateway.auth).\n"
        f"const route = {json.dumps(route)};\n"
        "const item = $input.first();\n"
        "return [{ json: { ...item.json, t0: Date.now(), route }, binary: item.binary }];\n"
    )
    return wf.node("Route", "n8n-nodes-base.code", 2, {"mode": "runOnceForAllItems", "language": "javaScript", "jsCode": js}, pos)


def gateway_call(wf, pos=None):
    return wf.node("Gateway", "n8n-nodes-base.executeWorkflow", 1.2, {
        "source": "database",
        "workflowId": {"__rl": True, "value": GATEWAY_WF, "mode": "id", "cachedResultName": "wf.gateway.auth"},
        "mode": "once",
        "options": {"waitForSubWorkflow": True},
    }, pos)


def respond_tail(wf, x):
    """Envelope -> Finish (log + idempotency) -> Respond. All endpoint paths end here."""
    code_node(wf, "Envelope", "endpoint_envelope.js", [x, 300])
    pg_node(wf, "Finish", "select app.api_finish($1::jsonb) as finished",
            "={{ [ JSON.stringify($json.finish) ] }}", [x + 220, 300])
    if_node(wf, "Rate limited?", "={{ $('Envelope').first().json.status === 429 }}", [x + 440, 300])
    base_headers = [
        {"name": "X-Request-Id", "value": "={{ $('Envelope').first().json.headers['X-Request-Id'] }}"},
        {"name": "Cache-Control", "value": "no-store"},
    ]
    for name, extra, y in (("Respond", [], 400), ("Respond 429", [
            {"name": "Retry-After", "value": "={{ $('Envelope').first().json.headers['Retry-After'] || '60' }}"}], 200)):
        wf.node(name, "n8n-nodes-base.respondToWebhook", 1.5, {
            "respondWith": "json",
            "responseBody": "={{ $('Envelope').first().json.response }}",
            "options": {
                "responseCode": "={{ $('Envelope').first().json.status }}",
                "responseHeaders": {"entries": base_headers + extra},
            },
        }, [x + 660, y])
    wf.link("Envelope", "Finish")
    wf.link("Finish", "Rate limited?", 0)
    wf.link("Finish", "Rate limited?", 1)  # logging failure must not block the answer
    wf.link("Rate limited?", "Respond 429", 0)
    wf.link("Rate limited?", "Respond", 1)


# ---------- wf.gateway.auth ---------------------------------------------------
def gateway():
    wf = WF(GATEWAY_WF, "wf.gateway.auth", tags=["gateway"])
    wf.node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1, {"inputSource": "passthrough"}, [0, 0])
    code_node(wf, "Prepare request", "gateway_prepare.js", [220, 0])
    if_node(wf, "Prepared?", "={{ $json.ok }}", [440, 0])
    pg_node(wf, "Gateway check", "select app.gateway_check($1::jsonb) as g",
            "={{ [ JSON.stringify($json.check) ] }}", [660, -100])
    code_node(wf, "Decide", "gateway_decide.js", [880, -100])
    if_node(wf, "Allowed?", "={{ $json.ok }}", [1100, -100])
    if_node(wf, "Needs idempotency?", "={{ !!$json.idempotency }}", [1320, -200])
    pg_node(wf, "Idempotency begin",
            "select app.idempotency_begin($1, $2, $3, $4, coalesce((select (value #>> '{}')::int from app.settings where key = 'gateway.idempotency_stale_s'), 300)) as r",
            "={{ [ $json.idempotency.scope, $json.idempotency.key, $json.idempotency.route, $json.idempotency.body_sha256 ] }}",
            [1540, -300])
    code_node(wf, "Apply idempotency", "gateway_idempotency.js", [1760, -300])
    code_node(wf, "Database unavailable", "gateway_db_error.js", [1540, 200])
    wf.node("Return", "n8n-nodes-base.noOp", 1, {}, [1980, 0])

    wf.link("Start", "Prepare request")
    wf.link("Prepare request", "Prepared?")
    wf.link("Prepared?", "Gateway check", 0)
    wf.link("Prepared?", "Return", 1)
    wf.link("Gateway check", "Decide", 0)
    wf.link("Gateway check", "Database unavailable", 1)
    wf.link("Decide", "Allowed?")
    wf.link("Allowed?", "Needs idempotency?", 0)
    wf.link("Allowed?", "Return", 1)
    wf.link("Needs idempotency?", "Idempotency begin", 0)
    wf.link("Needs idempotency?", "Return", 1)
    wf.link("Idempotency begin", "Apply idempotency", 0)
    wf.link("Idempotency begin", "Database unavailable", 1)
    wf.link("Apply idempotency", "Return")
    wf.link("Database unavailable", "Return")
    return wf


# ---------- wf.api.health -------------------------------------------------------
def health():
    wf = WF("fsApiHealth00001", "wf.api.health", tags=["api", "v1"])
    webhook(wf, "GET", "v1/health", "5d0c7a1e-8a51-4c43-9d6e-6b1f3f0a0001", [0, 0])
    route_node(wf, {"method": "GET", "template": "/v1/health", "require_user": False, "idempotent": False,
                    "required_consents": [], "roles": []}, [220, 0])
    gateway_call(wf, [440, 0])
    if_node(wf, "Gateway ok?", "={{ $json.ok }}", [660, 0])
    pg_node(wf, "Check database",
            "select current_setting('server_version') as server_version,"
            " (select max(version) from public.schema_migrations) as migration,"
            " (select jsonb_object_agg(extname, extversion) from pg_extension) as extensions,"
            " (select jsonb_object_agg(key, value #>> '{}') from app.settings"
            "   where key in ('ollama.base_url','ollama.embed_model','s3.health_url','health.timeout_ms')) as cfg",
            None, [880, -100])
    code_node(wf, "Health config", "health_config.js", [1100, -100])
    wf.node("Check Ollama", "n8n-nodes-base.httpRequest", 4.2, {
        "method": "GET", "url": "={{ $json.ollama_url }}/api/tags",
        "options": {"timeout": "={{ $json.timeout_ms }}", "response": {"response": {"responseFormat": "json"}}},
    }, [1320, -100], onError="continueRegularOutput")
    wf.node("Check object storage", "n8n-nodes-base.httpRequest", 4.2, {
        "method": "GET", "url": "={{ $('Health config').first().json.s3_health_url }}",
        "options": {"timeout": "={{ $('Health config').first().json.timeout_ms }}",
                    "response": {"response": {"responseFormat": "text"}}},
    }, [1540, -100], onError="continueRegularOutput")
    code_node(wf, "Summarize", "health_summary.js", [1760, -100])
    code_node(wf, "Database check failed", "health_db_error.js", [1100, 150])
    respond_tail(wf, 1980)

    wf.link("Webhook", "Route")
    wf.link("Route", "Gateway")
    wf.link("Gateway", "Gateway ok?")
    wf.link("Gateway ok?", "Check database", 0)
    wf.link("Gateway ok?", "Envelope", 1)
    wf.link("Check database", "Health config", 0)
    wf.link("Check database", "Database check failed", 1)
    wf.link("Health config", "Check Ollama")
    wf.link("Check Ollama", "Check object storage")
    wf.link("Check object storage", "Summarize")
    wf.link("Summarize", "Envelope")
    wf.link("Database check failed", "Envelope")
    return wf


# ---------- wf.api.users_sync ---------------------------------------------------
USERS_SYNC_SQL = """with up as (
  insert into app.users (external_auth_id, email, display_name, locale, jurisdiction_code)
  values ($1, nullif($2, '')::citext, nullif($3, ''), coalesce(nullif($4, ''), 'en'), nullif($5, ''))
  on conflict (external_auth_id) do update set
    email             = coalesce(excluded.email, app.users.email),
    display_name      = coalesce(nullif($3, ''), app.users.display_name),
    locale            = coalesce(nullif($4, ''), app.users.locale),
    jurisdiction_code = coalesce(excluded.jurisdiction_code, app.users.jurisdiction_code)
  returning id, (xmax = 0) as created, role, locale, jurisdiction_code
), audit as (
  insert into app.audit_log (actor_id, action, entity, entity_id)
  select id, case when created then 'user_created' else 'user_synced' end, 'user', id::text from up
)
select up.id as user_id, up.created, up.role, up.locale, up.jurisdiction_code,
  coalesce((select jsonb_object_agg(c.purpose, jsonb_build_object('granted', c.granted,
              'policy_version', c.policy_version, 'granted_at', c.granted_at))
            from (select distinct on (purpose) purpose, granted, policy_version, granted_at
                  from app.consents where user_id = up.id
                  order by purpose, granted_at desc, id desc) c), '{}'::jsonb) as consents
from up"""


def users_sync():
    wf = WF("fsApiUsersSync01", "wf.api.users_sync", tags=["api", "v1"])
    webhook(wf, "POST", "v1/users/sync", "5d0c7a1e-8a51-4c43-9d6e-6b1f3f0a0002", [0, 0])
    route_node(wf, {"method": "POST", "template": "/v1/users/sync", "require_user": False, "idempotent": True,
                    "required_consents": [], "roles": []}, [220, 0])
    gateway_call(wf, [440, 0])
    if_node(wf, "Gateway ok?", "={{ $json.ok }}", [660, 0])
    code_node(wf, "Validate body", "users_sync_validate.js", [880, -100])
    if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    pg_node(wf, "Upsert user", USERS_SYNC_SQL, "={{ $json.params }}", [1320, -200])
    code_node(wf, "Build result", "users_sync_result.js", [1540, -200])
    code_node(wf, "Upsert failed", "users_sync_db_error.js", [1540, 0])
    respond_tail(wf, 1760)

    wf.link("Webhook", "Route")
    wf.link("Route", "Gateway")
    wf.link("Gateway", "Gateway ok?")
    wf.link("Gateway ok?", "Validate body", 0)
    wf.link("Gateway ok?", "Envelope", 1)
    wf.link("Validate body", "Valid?")
    wf.link("Valid?", "Upsert user", 0)
    wf.link("Valid?", "Envelope", 1)
    wf.link("Upsert user", "Build result", 0)
    wf.link("Upsert user", "Upsert failed", 1)
    wf.link("Build result", "Envelope")
    wf.link("Upsert failed", "Envelope")
    return wf


# ---------- wf.ops.error_handler ------------------------------------------------
def error_handler():
    wf = WF(ERROR_WF, "wf.ops.error_handler", tags=["ops"], settings={"errorWorkflow": None, "saveDataSuccessExecution": "all"})
    del wf.settings["errorWorkflow"]
    wf.node("Error Trigger", "n8n-nodes-base.errorTrigger", 1, {}, [0, 0])
    code_node(wf, "Build record", "error_handler_record.js", [220, 0])
    pg_node(wf, "Record failure",
            "insert into ai.executions (request_id, workflow, n8n_execution_id, status, finished_at, error)"
            " values (gen_random_uuid(), $1, $2, 'failed', now(), $3) returning id",
            "={{ [ $json.workflow, $json.n8n_execution_id, $json.error ] }}", [440, 0], on_error="stopWorkflow")
    wf.link("Error Trigger", "Build record")
    wf.link("Build record", "Record failure")
    return wf


# ---------- test-only workflows ------------------------------------------------
def test_fail():
    """Throws on purpose so the error handler and the proxy's handling of
    unenveloped n8n errors can be tested. Imported only by the test runner."""
    wf = WF("fsTestFail000001", "wf.test.fail", tags=["test"])
    webhook(wf, "GET", "v1/test/fail", "5d0c7a1e-8a51-4c43-9d6e-6b1f3f0a00ff", [0, 0])
    wf.node("Throw", "n8n-nodes-base.code", 2, {"mode": "runOnceForAllItems", "language": "javaScript",
             "jsCode": "throw new Error('deliberate failure for the error-handler test');"}, [220, 0])
    wf.node("Respond", "n8n-nodes-base.respondToWebhook", 1.5, {"respondWith": "json", "responseBody": "={}", "options": {}}, [440, 0])
    wf.link("Webhook", "Throw")
    wf.link("Throw", "Respond")
    return wf


# ---------- phase 2: knowledge base and retrieval evaluation ---------------------
KB_INGEST_WF = "fsKbIngest000001"
KB_SOURCE_WF = "fsKbIngestSrc001"
EVAL_WF = "fsEvalRetrieval1"
JOBS_GET_HOOK = "5d0c7a1e-8a51-4c43-9d6e-6b1f3f0a0010"       # parameterised routes: see infra/caddy/Caddyfile
EVAL_GET_HOOK = "5d0c7a1e-8a51-4c43-9d6e-6b1f3f0a0011"

CREATE_JOB_SQL = """insert into app.jobs (type, status, input, requested_by, idempotency_key)
select $4, 'queued', $1::jsonb, $2::uuid, $3
where $1::jsonb->>'jurisdiction' is null or exists (select 1 from app.jurisdictions where code = $1::jsonb->>'jurisdiction')
on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
returning id, type, status, created_at, (xmax = 0) as created"""

FINISH_JOB_SQL = """update app.jobs set status = $2, output = $3::jsonb, error = $4, finished_at = now()
where id = $1::uuid returning id, status"""


def admin_job_endpoint(wid, name, path, hook, validate_src, worker_id, worker_name):
    wf = WF(wid, name, tags=["api", "v1", "admin"])
    webhook(wf, "POST", path, hook, [0, 0])
    route_node(wf, {"method": "POST", "template": "/" + path, "require_user": True, "idempotent": True,
                    "required_consents": [], "roles": ["admin"]}, [220, 0])
    gateway_call(wf, [440, 0])
    if_node(wf, "Gateway ok?", "={{ $json.ok }}", [660, 0])
    code_node(wf, "Validate body", validate_src, [880, -100])
    if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    pg_node(wf, "Create job", CREATE_JOB_SQL, "={{ $json.params }}", [1320, -200], always_output=True)
    if_node(wf, "Newly created?", "={{ $json.created === true }}", [1540, -200])
    exec_wf(wf, "Start worker", worker_id, worker_name, wait=False, pos=[1760, -300])
    code_node(wf, "Accepted", "job_accepted.js", [1980, -200])
    code_node(wf, "Database error", "job_db_error.js", [1540, 0])
    respond_tail(wf, 2200)
    wf.link("Webhook", "Route")
    wf.link("Route", "Gateway")
    wf.link("Gateway", "Gateway ok?")
    wf.link("Gateway ok?", "Validate body", 0)
    wf.link("Gateway ok?", "Envelope", 1)
    wf.link("Validate body", "Valid?")
    wf.link("Valid?", "Create job", 0)
    wf.link("Valid?", "Envelope", 1)
    wf.link("Create job", "Newly created?", 0)
    wf.link("Create job", "Database error", 1)
    wf.link("Newly created?", "Start worker", 0)
    wf.link("Newly created?", "Accepted", 1)        # retried request: job exists, or unknown jurisdiction
    wf.link("Start worker", "Accepted")
    wf.link("Accepted", "Envelope")
    wf.link("Database error", "Envelope")
    return wf


def admin_kb_ingest():
    return admin_job_endpoint("fsApiKbIngest001", "wf.api.admin_kb_ingest", "v1/admin/kb/ingest",
                              "5d0c7a1e-8a51-4c43-9d6e-6b1f3f0a0003", "admin_kb_ingest_validate.js",
                              KB_INGEST_WF, "wf.kb.ingest")


def admin_eval_runs_create():
    return admin_job_endpoint("fsApiEvalRun0001", "wf.api.admin_eval_runs_create", "v1/admin/eval/runs",
                              "5d0c7a1e-8a51-4c43-9d6e-6b1f3f0a0004", "admin_eval_validate.js",
                              EVAL_WF, "wf.eval.retrieval")


def get_by_id_endpoint(wid, name, template, hook, roles, sql, result_src):
    wf = WF(wid, name, tags=["api", "v1"])
    webhook(wf, "GET", template.lstrip("/"), hook, [0, 0])
    route_node(wf, {"method": "GET", "template": template, "require_user": True, "idempotent": False,
                    "required_consents": [], "roles": roles}, [220, 0])
    gateway_call(wf, [440, 0])
    if_node(wf, "Gateway ok?", "={{ $json.ok }}", [660, 0])
    pg_node(wf, "Load", sql, "={{ [ $json.ctx.params.id || '' ] }}", [880, -100], always_output=True)
    code_node(wf, "Build result", result_src, [1100, -200])
    code_node(wf, "Database error", "get_db_error.js", [1100, 0])
    respond_tail(wf, 1320)
    wf.link("Webhook", "Route")
    wf.link("Route", "Gateway")
    wf.link("Gateway", "Gateway ok?")
    wf.link("Gateway ok?", "Load", 0)
    wf.link("Gateway ok?", "Envelope", 1)
    wf.link("Load", "Build result", 0)
    wf.link("Load", "Database error", 1)
    wf.link("Build result", "Envelope")
    wf.link("Database error", "Envelope")
    return wf


def jobs_get():
    return get_by_id_endpoint("fsApiJobsGet0001", "wf.api.jobs_get", "/v1/jobs/:id", JOBS_GET_HOOK, [],
                              "select id, type, status, attempts, created_at, started_at, finished_at, output, error, requested_by"
                              " from app.jobs where id = app.try_uuid($1)", "job_get_result.js")


def admin_eval_runs_get():
    sql = """select r.id, r.status, r.config, r.git_sha, r.job_id, r.started_at, r.finished_at, r.summary,
  d.name || ' v' || d.version as dataset,
  (select jsonb_agg(jsonb_build_object('query_id', q.external_id, 'language', q.language, 'tags', q.tags,
                                       'metrics', x.metrics) order by q.external_id)
     from eval.results x join eval.queries q on q.id = x.query_id where x.run_id = r.id) as queries
from eval.runs r join eval.datasets d on d.id = r.dataset_id
where r.id = app.try_uuid($1)"""
    return get_by_id_endpoint("fsApiEvalGet0001", "wf.api.admin_eval_runs_get", "/v1/admin/eval/runs/:id",
                              EVAL_GET_HOOK, ["admin"], sql, "eval_get_result.js")


KB_START_SQL = """with j as (
  update app.jobs set status = 'running', started_at = now(), attempts = attempts + 1
  where id = $1::uuid and status = 'queued' returning id, input)
select j.id as job_id, j.input,
  (select jsonb_object_agg(key, value) from app.settings where key like 'kb.%' or key = 'ollama.base_url') as cfg,
  (select jsonb_agg(jsonb_build_object('name', name, 'endpoint', endpoint, 'query_prefix', query_prefix,
                                       'passage_prefix', passage_prefix, 'dims', dims))
     from ai.models where kind = 'embedding' and active) as models,
  coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'source_key', s.source_key, 'url', s.url,
                                                'language', s.language, 'cite_as', s.cite_as,
                                                'jurisdiction_code', s.jurisdiction_code, 'fetch_config', s.fetch_config)
                             order by s.source_key)
            from kb.sources s
            where s.status = 'active' and s.source_key is not null and s.url is not null
              and (s.jurisdiction_code = j.input->>'jurisdiction'
                   or (s.jurisdiction_code is null and coalesce((j.input->>'include_global')::boolean, true)))
              and (jsonb_array_length(coalesce(j.input->'sources', '[]'::jsonb)) = 0
                   or (j.input->'sources') ? s.source_key)), '[]'::jsonb) as sources
from j"""


def kb_ingest():
    wf = WF(KB_INGEST_WF, "wf.kb.ingest", tags=["kb", "worker"], settings={"saveDataSuccessExecution": "all"})
    wf.node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1, {"inputSource": "passthrough"}, [0, 0])
    pg_node(wf, "Start job", KB_START_SQL, "={{ [ $json.id ] }}", [220, 0], on_error=None, always_output=True)
    code_node(wf, "Plan", "kb_ingest_plan.js", [440, 0], on_error="continueErrorOutput")
    if_node(wf, "Anything to do?", "={{ !$json.empty }}", [660, 0])
    code_node(wf, "Job failed", "worker_failed.js", [880, -400])
    wf.node("Loop sources", "n8n-nodes-base.splitInBatches", 3, {"batchSize": 1, "options": {}}, [880, -100])
    exec_wf(wf, "Ingest source", KB_SOURCE_WF, "wf.kb.ingest_source", wait=True, pos=[1100, 0],
            on_error="continueRegularOutput")
    code_node(wf, "Normalize result", "kb_ingest_normalize.js", [1320, 0])
    pg_node(wf, "Log source",
            "with l as (insert into kb.ingest_log (job_id, source_id, source_key, step, status, detail, ms)"
            " values ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::int) returning id)"
            " update kb.sources set last_status = $5, last_error = $8 where id = $2::uuid returning id",
            "={{ $json.log }}", [1540, 0], on_error="continueRegularOutput", always_output=True)
    wf.node("Keep result", "n8n-nodes-base.code", 2, {"mode": "runOnceForAllItems", "language": "javaScript",
            "jsCode": "return [{ json: $('Normalize result').first().json }];"}, [1760, 0])
    code_node(wf, "Summarize", "kb_ingest_summary.js", [1100, -250])
    pg_node(wf, "Finish job", FINISH_JOB_SQL,
            "={{ [ $json.job_id, $json.status, JSON.stringify($json.output), $json.error ] }}", [1320, -250], on_error=None)
    wf.link("Start", "Start job")
    wf.link("Start job", "Plan")
    wf.link("Plan", "Anything to do?", 0)
    wf.link("Plan", "Job failed", 1)
    wf.link("Job failed", "Finish job")
    wf.link("Anything to do?", "Loop sources", 0)
    wf.link("Anything to do?", "Summarize", 1)
    wf.link("Loop sources", "Summarize", 0)       # done
    wf.link("Loop sources", "Ingest source", 1)   # loop
    wf.link("Ingest source", "Normalize result")
    wf.link("Normalize result", "Log source")
    wf.link("Log source", "Keep result")
    wf.link("Keep result", "Loop sources")
    wf.link("Summarize", "Finish job")
    return wf


UA = [("User-Agent", "={{ $('Robots URL').first().json.cfg.user_agent }}")]


def kb_ingest_source():
    wf = WF(KB_SOURCE_WF, "wf.kb.ingest_source", tags=["kb", "worker"], settings={"saveDataSuccessExecution": "none"})
    wf.node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1, {"inputSource": "passthrough"}, [0, 0])
    code_node(wf, "Robots URL", "kb_src_robots_url.js", [220, 0])
    http_node(wf, "Fetch robots.txt", "GET", "={{ $json.robots_url }}", [440, 0], fmt="text", full=True,
              never_error=True, timeout="={{ 15000 }}", headers=UA, on_error="continueRegularOutput")
    code_node(wf, "Robots decision", "kb_src_robots_decide.js", [660, 0])
    if_node(wf, "Allowed?", "={{ $json.robots.allowed }}", [880, 0])
    code_node(wf, "Skipped (robots)", "kb_src_result.js", [1100, 200], subst={"__MODE__": "robots"})
    http_node(wf, "Fetch source", "GET", "={{ $json.source.url }}", [1100, -100], fmt="file", full=True,
              never_error=True, timeout="={{ Number($json.cfg.fetch_timeout_ms || 60000) }}", headers=UA)
    if_node(wf, "PDF?", "={{ ($json.source.fetch || {}).format === 'pdf' || String(($json.headers || {})['content-type'] || '').includes('pdf') }}"
            .replace("$json.source", "$('Robots decision').first().json.source"), [1320, -100])
    wf.node("Extract PDF", "n8n-nodes-base.extractFromFile", 1.1,
            {"operation": "pdf", "binaryPropertyName": "data", "options": {"joinPages": False, "keepSource": "both"}},
            [1540, -200])
    code_node(wf, "Clean PDF", "kb_src_clean_pdf.js", [1760, -200])
    code_node(wf, "Clean HTML", "kb_src_clean_html.js", [1760, 0])
    wf.node("Cleaned", "n8n-nodes-base.noOp", 1, {}, [1980, -100])
    pg_node(wf, "Store document",
            "with d as (select kb.store_document($1::jsonb) as r)"
            " select d.r as doc, kb.document_progress((d.r->>'document_id')::uuid) as progress from d",
            "={{ [ JSON.stringify({ source_id: $json.source.id, url: $json.source.url, http_status: $json.http_status,"
            " content_type: $json.content_type, bytes_b64: $json.bytes_b64, content: $json.content,"
            " language: $json.source.language, extractor: $json.extractor, metadata: $json.doc_metadata,"
            " force: $json.force }) ] }}", [2200, -100], on_error=None)
    code_node(wf, "Tokenize batches", "kb_src_tokenize_batches.js", [2420, -100])
    if_node(wf, "Work needed?", "={{ !$json.skip }}", [2640, -100])
    code_node(wf, "Skipped (unchanged)", "kb_src_result.js", [2860, 100], subst={"__MODE__": "unchanged"})
    http_node(wf, "Tokenize", "POST", "={{ $('Cleaned').first().json.cfg.tei_base_url }}/tokenize", [2860, -200],
              body="={{ JSON.stringify($json.body) }}", fmt="text", timeout="={{ 120000 }}")
    code_node(wf, "Chunk", "kb_src_chunk.js", [3080, -200])
    pg_node(wf, "Store chunks", "select kb.store_chunks($1::uuid, $2::jsonb) as ids",
            "={{ [ $json.doc.document_id, JSON.stringify($json.chunks) ] }}", [3300, -200], on_error=None)
    code_node(wf, "Embed batches", "kb_src_embed_batches.js", [3520, -200])
    # One embedding request at a time (F-033): the HTTP Request node starts all its
    # items' requests at once, so a long document queued every batch on TEI's CPU
    # and the last ones hit the timeout. The loop sends them one after the other;
    # the timeout then applies to one batch.
    wf.node("Embed loop", "n8n-nodes-base.splitInBatches", 3, {"batchSize": 1, "options": {}}, [3740, -200])
    http_node(wf, "Embed", "POST", "={{ $json.url }}", [3960, -300], body="={{ JSON.stringify($json.body) }}",
              fmt="text", timeout="={{ Number($('Cleaned').first().json.cfg.embed_timeout_ms || 600000) }}")
    code_node(wf, "Vectors", "kb_src_vectors.js", [4180, -100])
    pg_node(wf, "Store embeddings", "select $1::text as model, kb.store_embeddings($1, $2::jsonb) as n",
            "={{ [ $json.model, $json.rows ] }}", [4400, -100], on_error=None)
    code_node(wf, "Result", "kb_src_result.js", [4620, -100], subst={"__MODE__": "done"})

    wf.link("Start", "Robots URL")
    wf.link("Robots URL", "Fetch robots.txt")
    wf.link("Fetch robots.txt", "Robots decision")
    wf.link("Robots decision", "Allowed?")
    wf.link("Allowed?", "Fetch source", 0)
    wf.link("Allowed?", "Skipped (robots)", 1)
    wf.link("Fetch source", "PDF?")
    wf.link("PDF?", "Extract PDF", 0)
    wf.link("PDF?", "Clean HTML", 1)
    wf.link("Extract PDF", "Clean PDF")
    wf.link("Clean PDF", "Cleaned")
    wf.link("Clean HTML", "Cleaned")
    wf.link("Cleaned", "Store document")
    wf.link("Store document", "Tokenize batches")
    wf.link("Tokenize batches", "Work needed?")
    wf.link("Work needed?", "Tokenize", 0)
    wf.link("Work needed?", "Skipped (unchanged)", 1)
    wf.link("Tokenize", "Chunk")
    wf.link("Chunk", "Store chunks")
    wf.link("Store chunks", "Embed batches")
    wf.link("Embed batches", "Embed loop")
    wf.link("Embed loop", "Vectors", 0)       # done: every answer, in request order
    wf.link("Embed loop", "Embed", 1)         # loop: one request
    wf.link("Embed", "Embed loop")
    wf.link("Vectors", "Store embeddings")
    wf.link("Store embeddings", "Result")
    return wf


EVAL_START_SQL = """with j as (
  update app.jobs set status = 'running', started_at = now(), attempts = attempts + 1
  where id = $1::uuid and status = 'queued' returning id, input)
select j.id as job_id, j.input, d.id as dataset_id,
  (select jsonb_agg(jsonb_build_object('id', q.id, 'external_id', q.external_id, 'query', q.query,
                                       'language', q.language, 'tags', q.tags, 'gold', eval.resolve_gold(q.gold))
                    order by q.external_id)
     from eval.queries q where q.dataset_id = d.id) as queries,
  (select jsonb_object_agg(key, value) from app.settings
    where key like 'kb.%' or key like 'eval.%' or key = 'ollama.base_url') as cfg,
  (select jsonb_agg(jsonb_build_object('name', name, 'endpoint', endpoint, 'query_prefix', query_prefix, 'dims', dims))
     from ai.models where kind = 'embedding' and active) as models
from j left join eval.datasets d
  on d.name = j.input->>'dataset' and d.version = (j.input->>'version')::int and d.kind = 'retrieval'"""


def eval_retrieval():
    wf = WF(EVAL_WF, "wf.eval.retrieval", tags=["eval", "worker"], settings={"saveDataSuccessExecution": "none"})
    E = "continueErrorOutput"          # every step after "Start job" sends failures to "Job failed"
    wf.node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1, {"inputSource": "passthrough"}, [0, 0])
    pg_node(wf, "Start job", EVAL_START_SQL, "={{ [ $json.id ] }}", [220, 0], on_error=None, always_output=True)
    code_node(wf, "Plan", "eval_plan.js", [440, 0], on_error=E)
    if_node(wf, "Embeddings needed?", "={{ !$json.none }}", [660, 0])
    http_node(wf, "Embed queries", "POST", "={{ $json.url }}", [880, -100], body="={{ JSON.stringify($json.body) }}",
              fmt="text", timeout="={{ 600000 }}", on_error=E)
    code_node(wf, "Query vectors", "eval_query_vectors.js", [1100, 0], on_error=E)
    wf.node("Loop configs", "n8n-nodes-base.splitInBatches", 3, {"batchSize": 1, "options": {}}, [1320, 0])
    pg_node(wf, "Create run",
            "insert into eval.runs (dataset_id, config, git_sha, job_id, status)"
            " values ($1::uuid, $2::jsonb, $3, $4::uuid, 'running') returning id, config",
            "={{ [ $json.dataset_id, JSON.stringify($json.config), $json.git_sha, $json.job_id ] }}", [1540, 100], on_error=E)
    code_node(wf, "Expand queries", "eval_expand.js", [1760, 100], on_error=E)
    pg_node(wf, "Search", "select eval.timed_search($1::jsonb) as r", "={{ [ $json.p ] }}", [1980, 100], on_error=E)
    code_node(wf, "Score", "eval_score.js", [2200, 100], on_error=E)
    pg_node(wf, "Store results",
            "with ins as (insert into eval.results (run_id, query_id, retrieved, metrics)"
            " select (x->>'run_id')::uuid, (x->>'query_id')::uuid, x->'retrieved', x->'metrics'"
            " from jsonb_array_elements($2::jsonb) x returning 1)"
            " update eval.runs set status = 'succeeded', finished_at = now(), summary = $3::jsonb where id = $1::uuid"
            " returning id as run_id, config, summary, (select count(*) from ins) as stored",
            "={{ [ $json.run_id, $json.rows, $json.summary ] }}", [2420, 100], on_error=E)
    code_node(wf, "Summarize", "eval_summary.js", [1540, -150])
    code_node(wf, "Job failed", "worker_failed.js", [1540, -350])
    pg_node(wf, "Finish job", FINISH_JOB_SQL,
            "={{ [ $json.job_id, $json.status, JSON.stringify($json.output), $json.error ] }}", [1760, -150], on_error=None)
    wf.link("Start", "Start job")
    wf.link("Start job", "Plan")
    wf.link("Plan", "Embeddings needed?", 0)
    wf.link("Embeddings needed?", "Embed queries", 0)
    wf.link("Embeddings needed?", "Query vectors", 1)
    wf.link("Embed queries", "Query vectors", 0)
    wf.link("Query vectors", "Loop configs", 0)
    wf.link("Loop configs", "Summarize", 0)
    wf.link("Loop configs", "Create run", 1)
    wf.link("Create run", "Expand queries", 0)
    wf.link("Expand queries", "Search", 0)
    wf.link("Search", "Score", 0)
    wf.link("Score", "Store results", 0)
    wf.link("Store results", "Loop configs", 0)
    for n in ("Plan", "Embed queries", "Query vectors", "Create run", "Expand queries", "Search", "Score", "Store results"):
        wf.link(n, "Job failed", 1)
    wf.link("Summarize", "Finish job")
    wf.link("Job failed", "Finish job")
    return wf


# ---------- phase 3: prompts, profiles, search ------------------------------------
LLM_CALL_WF = "fsLlmCall0000001"
EVALP_WF = "fsEvalPrompts001"
PROFILE_WF = "fsProfileExtr001"
MATCH_WF = "fsMatchSearch001"
EMBED_WF = "fsListingsEmb001"
FX_WF = "fsFxRefresh00001"
USER_CONSENTS = ["terms", "privacy"]       # D-062: endpoints that process a person's request text or profile


def llm_call():
    """Sub-workflow: one prompt call to the local model with schema validation and one retry.
    Input {prompt, version?, model?, vars, meta?}; output see llm_result.js."""
    wf = WF(LLM_CALL_WF, "wf.llm.call", tags=["agent", "llm"])
    wf.node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1, {"inputSource": "passthrough"}, [0, 0])
    pg_node(wf, "Load prompt",
            "select ai.prompt_for($1, nullif($2, '')::int) as prompt_row,"
            " (select jsonb_object_agg(key, value) from app.settings where key like 'llm.%' or key = 'ollama.base_url') as cfg",
            "={{ [ $json.prompt, $json.version === null || $json.version === undefined ? '' : String($json.version) ] }}",
            [220, 0], on_error=None)
    code_node(wf, "Build request", "llm_build.js", [440, 0])
    if_node(wf, "Call model?", "={{ !$json.skip }}", [660, 0])
    http_node(wf, "Call model", "POST", "={{ $json.url }}", [880, -100], body="={{ JSON.stringify($json.body) }}",
              fmt="json", full=True, never_error=True, timeout="={{ $json.timeout_ms }}", on_error="continueRegularOutput")
    code_node(wf, "Check output", "llm_check.js", [1100, -100], subst={"__ATTEMPT__": "1"})
    if_node(wf, "Retry?", "={{ $json.retry }}", [1320, -100])
    http_node(wf, "Call model again", "POST", "={{ $json.url }}", [1540, -200], body="={{ JSON.stringify($json.body) }}",
              fmt="json", full=True, never_error=True, timeout="={{ $('Build request').first().json.timeout_ms }}",
              on_error="continueRegularOutput")
    code_node(wf, "Check retry", "llm_check.js", [1760, -200], subst={"__ATTEMPT__": "2"})
    code_node(wf, "Result", "llm_result.js", [1980, 0])
    wf.link("Start", "Load prompt")
    wf.link("Load prompt", "Build request")
    wf.link("Build request", "Call model?")
    wf.link("Call model?", "Call model", 0)
    wf.link("Call model?", "Result", 1)
    wf.link("Call model", "Check output")
    wf.link("Check output", "Retry?")
    wf.link("Retry?", "Call model again", 0)
    wf.link("Retry?", "Result", 1)
    wf.link("Call model again", "Check retry")
    wf.link("Check retry", "Result")
    return wf


EVALP_START_SQL = """with j as (
  update app.jobs set status = 'running', started_at = now(), attempts = attempts + 1
  where id = $1::uuid and status = 'queued' returning id, input)
select j.id as job_id, j.input, d.id as dataset_id, d.kind,
  (select jsonb_agg(jsonb_build_object('id', q.id, 'external_id', q.external_id, 'query', q.query, 'gold', q.gold,
                                       'tags', to_jsonb(q.tags)) order by q.external_id)
     from eval.queries q where q.dataset_id = d.id) as queries,
  (select jsonb_agg(jsonb_build_object('version_id', v.id, 'version', v.version) order by v.version)
     from ai.prompt_versions v join ai.prompts p on p.id = v.prompt_id
    where p.name = j.input->>'prompt'
      and v.version in (select x::int from jsonb_array_elements_text(j.input->'versions') x)) as versions,
  (select jsonb_object_agg(code, app.extraction_context(code)) from app.jurisdictions) as contexts,
  (select value #>> '{}' from app.settings where key = 'llm.default_model') as default_model
from j left join eval.datasets d on d.name = j.input->>'dataset' and d.version = (j.input->>'dataset_version')::int"""

EVALP_LOAD_SQL = """select r.id as run_id, r.config, r.prompt_version_id,
  (select jsonb_agg(jsonb_build_object('external_id', q.external_id, 'tags', to_jsonb(q.tags), 'query', q.query,
                                       'labels', q.gold->'labels', 'metrics', x.metrics, 'output', x.output)
                    order by q.external_id)
     from eval.results x join eval.queries q on q.id = x.query_id where x.run_id = r.id) as results
from eval.runs r where r.job_id = $1::uuid order by r.started_at, r.id"""

EVALP_FINISH_SQL = """with s as (
  update eval.runs r set status = 'succeeded', finished_at = now(), summary = x->'summary'
  from jsonb_array_elements($1::jsonb) x where r.id = (x->>'run_id')::uuid returning r.id),
f as (
  insert into ai.prompt_failures (prompt_version_id, eval_run_id, item_id, category, input, observed_output, expected_output)
  select (x->>'prompt_version_id')::uuid, (x->>'eval_run_id')::uuid, x->>'item_id', x->>'category', x->>'input',
         x->>'observed', x->>'expected'
  from jsonb_array_elements($2::jsonb) x returning 1)
select (select count(*) from s) as runs, (select count(*) from f) as failures"""


def eval_prompts():
    """Worker: golden-set run of one prompt for given versions and models (spec 9.5 loop steps 1-2)."""
    wf = WF(EVALP_WF, "wf.eval.prompts", tags=["eval", "worker"], settings={"saveDataSuccessExecution": "none"})
    E = "continueErrorOutput"
    wf.node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1, {"inputSource": "passthrough"}, [0, 0])
    pg_node(wf, "Start job", EVALP_START_SQL, "={{ [ $json.id ] }}", [220, 0], on_error=None, always_output=True)
    code_node(wf, "Plan", "evalp_plan.js", [440, 0], on_error=E)
    pg_node(wf, "Create runs",
            "insert into eval.runs (dataset_id, config, git_sha, job_id, status, prompt_version_id)"
            " select $1::uuid, (x->'config') || jsonb_build_object('key', x->>'key'), $2, $3::uuid, 'running', (x->>'prompt_version_id')::uuid"
            " from jsonb_array_elements($4::jsonb) x returning id, config->>'key' as key",
            "={{ [ $json.dataset_id, $json.git_sha || '', $json.job_id, JSON.stringify($json.runs) ] }}", [660, 0], on_error=E)
    code_node(wf, "Expand", "evalp_expand.js", [880, 0], on_error=E)
    wf.node("Loop items", "n8n-nodes-base.splitInBatches", 3, {"batchSize": 1, "options": {}}, [1100, 0])
    code_node(wf, "Call input", "evalp_vars.js", [1320, 100], on_error=E)
    exec_wf(wf, "Call model", LLM_CALL_WF, "wf.llm.call", pos=[1540, 100], on_error=E)
    code_node(wf, "Score", "evalp_score.js", [1760, 100], on_error=E)
    pg_node(wf, "Store result",
            "insert into eval.results (run_id, query_id, retrieved, output, metrics) values ($1::uuid, $2::uuid, '[]'::jsonb, $3::jsonb, $4::jsonb)"
            " on conflict (run_id, query_id) do update set output = excluded.output, metrics = excluded.metrics returning run_id",
            "={{ $json.params }}", [1980, 100], on_error=E, retries=2)
    code_node(wf, "Loop done", "evalp_done.js", [1320, -150])
    pg_node(wf, "Load results", EVALP_LOAD_SQL, "={{ [ $json.job_id ] }}", [1540, -150], on_error=E)
    code_node(wf, "Summarize", "evalp_summary.js", [1760, -150], on_error=E)
    pg_node(wf, "Finish runs", EVALP_FINISH_SQL, "={{ [ JSON.stringify($json.summaries), JSON.stringify($json.failures) ] }}",
            [1980, -150], on_error=E)
    wf.node("Job output", "n8n-nodes-base.code", 2, {"mode": "runOnceForAllItems", "language": "javaScript", "jsCode":
            "// wf.eval.prompts > \"Job output\"\nconst s = $('Summarize').first().json;\nconst f = $input.first().json;\n"
            "return [{ json: { job_id: s.job_id, status: 'succeeded', error: null, output: { runs: s.brief, failures_recorded: Number(f.failures) } } }];\n"},
            [2200, -150])
    code_node(wf, "Job failed", "worker_failed.js", [1760, -400])
    pg_node(wf, "Finish job", FINISH_JOB_SQL,
            "={{ [ $json.job_id, $json.status, JSON.stringify($json.output), $json.error ] }}", [2420, -250], on_error=None)
    wf.link("Start", "Start job")
    wf.link("Start job", "Plan")
    wf.link("Plan", "Create runs", 0)
    wf.link("Create runs", "Expand", 0)
    wf.link("Expand", "Loop items", 0)
    wf.link("Loop items", "Loop done", 0)
    wf.link("Loop items", "Call input", 1)
    wf.link("Call input", "Call model", 0)
    wf.link("Call model", "Score", 0)
    wf.link("Score", "Store result", 0)
    wf.link("Store result", "Loop items", 0)
    wf.link("Loop done", "Load results")
    wf.link("Load results", "Summarize", 0)
    wf.link("Summarize", "Finish runs", 0)
    wf.link("Finish runs", "Job output", 0)
    for n in ("Plan", "Create runs", "Expand", "Call input", "Call model", "Score", "Store result", "Load results", "Summarize", "Finish runs"):
        wf.link(n, "Job failed", 1)
    wf.link("Job output", "Finish job")
    wf.link("Job failed", "Finish job")
    return wf


def profile_extract():
    """Sub-workflow A2: free text -> checked profile with a geocoded anchor (spec 8.2).
    Input {text, jurisdiction, today, model?, version?}."""
    wf = WF(PROFILE_WF, "wf.profile.extract", tags=["agent"])
    wf.node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1, {"inputSource": "passthrough"}, [0, 0])
    pg_node(wf, "Context", "select app.extraction_context($1) as ctx", "={{ [ $json.jurisdiction || '' ] }}", [220, 0], on_error=None)
    code_node(wf, "Call input", "profile_vars.js", [440, 0])
    exec_wf(wf, "Extract", LLM_CALL_WF, "wf.llm.call", pos=[660, 0])
    code_node(wf, "Check profile", "profile_post.js", [880, 0])
    pg_node(wf, "Geocode",
            "select case when $1 <> '' and $2 <> '' then app.geocode($1, $2) end as g",
            "={{ [ $json.anchor_label || '', $json.geo_jurisdiction || '' ] }}", [1100, 0], on_error=None)
    code_node(wf, "Result", "profile_result.js", [1320, 0])
    for a, b in (("Start", "Context"), ("Context", "Call input"), ("Call input", "Extract"), ("Extract", "Check profile"),
                 ("Check profile", "Geocode"), ("Geocode", "Result")):
        wf.link(a, b)
    return wf


def match_search():
    """Sub-workflow A3 (phase 3 part): embed the text query and run app.search_public.
    Input {jurisdiction, q, max_rent_minor, currency, budget_period, lat, lng, place, radius_m, limit}."""
    wf = WF(MATCH_WF, "wf.match.search", tags=["agent"])
    wf.node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1, {"inputSource": "passthrough"}, [0, 0])
    pg_node(wf, "Settings", "select (select jsonb_object_agg(key, value #>> '{}') from app.settings"
            " where key in ('ollama.base_url', 'ollama.embed_model', 'llm.keep_alive')) as cfg", None, [220, 0], on_error=None)
    code_node(wf, "Plan", "match_plan.js", [440, 0])
    if_node(wf, "Text query?", "={{ $json.embed }}", [660, 0])
    http_node(wf, "Embed query", "POST", "={{ $json.url }}", [880, -100], body="={{ JSON.stringify($json.body) }}",
              fmt="json", full=True, never_error=True, timeout="={{ 30000 }}", on_error="continueRegularOutput")
    code_node(wf, "Query vector", "match_vector.js", [1100, -100])
    code_node(wf, "No text", "match_novector.js", [1100, 100])
    code_node(wf, "Search input", "match_search_input.js", [1320, 0])
    pg_node(wf, "Search", "select app.search_public($1::jsonb) as r", "={{ $json.params }}", [1540, 0], on_error=None)
    code_node(wf, "Result", "match_result.js", [1760, 0])
    wf.link("Start", "Settings")
    wf.link("Settings", "Plan")
    wf.link("Plan", "Text query?")
    wf.link("Text query?", "Embed query", 0)
    wf.link("Text query?", "No text", 1)
    wf.link("Embed query", "Query vector")
    wf.link("Query vector", "Search input")
    wf.link("No text", "Search input")
    wf.link("Search input", "Search")
    wf.link("Search", "Result")
    return wf


def endpoint(wid, name, method, path, hook, route_extra=None):
    """Common head of a user endpoint: webhook, route, gateway, 'Gateway ok?' (false -> Envelope)."""
    wf = WF(wid, name, tags=["api", "v1"])
    webhook(wf, method, path, hook, [0, 0])
    route = {"method": method, "template": "/" + path, "require_user": True, "idempotent": False,
             "required_consents": USER_CONSENTS, "roles": []}
    route.update(route_extra or {})
    route_node(wf, route, [220, 0])
    gateway_call(wf, [440, 0])
    if_node(wf, "Gateway ok?", "={{ $json.ok }}", [660, 0])
    wf.link("Webhook", "Route")
    wf.link("Route", "Gateway")
    wf.link("Gateway", "Gateway ok?")
    wf.link("Gateway ok?", "Envelope", 1)
    return wf


def api_search():
    wf = endpoint("fsApiSearch00001", "wf.api.search", "GET", "v1/search", "5d0c7a1e-8a51-4c43-9d6e-6b1f3f0a0012")
    code_node(wf, "Validate query", "search_validate.js", [880, -100])
    if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    pg_node(wf, "Profile",
            "select (select jsonb_build_object('jurisdiction_code', jurisdiction_code, 'budget_max_minor', budget_max_minor,"
            " 'currency', currency, 'budget_period', budget_period, 'radius_m', search_radius_m,"
            " 'lat', st_y(anchor_point::geometry), 'lng', st_x(anchor_point::geometry))"
            " from app.profiles where user_id = app.try_uuid($1) and $2::boolean) as profile",
            "={{ [ $json.params[0], String($json.params[1]) ] }}", [1320, -200], on_error=None)
    code_node(wf, "Search input", "search_input.js", [1540, -200])
    if_node(wf, "Has jurisdiction?", "={{ !$json.no_jurisdiction }}", [1760, -200])
    exec_wf(wf, "Search", MATCH_WF, "wf.match.search", pos=[1980, -300])
    code_node(wf, "Build result", "search_result.js", [2200, -300])
    code_node(wf, "No jurisdiction", "search_nojur.js", [1980, -100])
    respond_tail(wf, 2420)
    wf.link("Gateway ok?", "Validate query", 0)
    wf.link("Validate query", "Valid?")
    wf.link("Valid?", "Profile", 0)
    wf.link("Valid?", "Envelope", 1)
    wf.link("Profile", "Search input")
    wf.link("Search input", "Has jurisdiction?")
    wf.link("Has jurisdiction?", "Search", 0)
    wf.link("Has jurisdiction?", "No jurisdiction", 1)
    wf.link("Search", "Build result")
    wf.link("Build result", "Envelope")
    wf.link("No jurisdiction", "Envelope")
    return wf


def api_profiles_extract():
    wf = endpoint("fsApiProfExtr001", "wf.api.profiles_extract", "POST", "v1/profiles/extract",
                  "5d0c7a1e-8a51-4c43-9d6e-6b1f3f0a0013")
    code_node(wf, "Validate body", "profiles_extract_validate.js", [880, -100])
    if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    code_node(wf, "Extract input", "profiles_extract_call.js", [1320, -200])
    exec_wf(wf, "Extract", PROFILE_WF, "wf.profile.extract", pos=[1540, -200])
    if_node(wf, "Save?", "={{ $('Validate body').first().json.save && $json.ok }}", [1760, -200])
    code_node(wf, "Save input", "profiles_save_params.js", [1980, -300])
    pg_node(wf, "Save profile", "select app.save_profile($1::uuid, $2::jsonb) as saved", "={{ $json.params }}",
            [2200, -300], on_error="continueRegularOutput")
    code_node(wf, "Build result", "profiles_extract_result.js", [2420, -200])
    respond_tail(wf, 2640)
    wf.link("Gateway ok?", "Validate body", 0)
    wf.link("Validate body", "Valid?")
    wf.link("Valid?", "Extract input", 0)
    wf.link("Valid?", "Envelope", 1)
    wf.link("Extract input", "Extract")
    wf.link("Extract", "Save?")
    wf.link("Save?", "Save input", 0)
    wf.link("Save?", "Build result", 1)
    wf.link("Save input", "Save profile")
    wf.link("Save profile", "Build result")
    wf.link("Build result", "Envelope")
    return wf


def api_profiles_me():
    wf = endpoint("fsApiProfMe00001", "wf.api.profiles_me", "PUT", "v1/profiles/me",
                  "5d0c7a1e-8a51-4c43-9d6e-6b1f3f0a0014", {"idempotent": True})
    code_node(wf, "Validate body", "profiles_me_validate.js", [880, -100])
    if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    pg_node(wf, "Save profile", "select app.save_profile($1::uuid, $2::jsonb) as saved", "={{ $json.params }}",
            [1320, -200], on_error="continueRegularOutput")
    code_node(wf, "Build result", "profiles_me_result.js", [1540, -200])
    respond_tail(wf, 1760)
    wf.link("Gateway ok?", "Validate body", 0)
    wf.link("Validate body", "Valid?")
    wf.link("Valid?", "Save profile", 0)
    wf.link("Valid?", "Envelope", 1)
    wf.link("Save profile", "Build result")
    wf.link("Build result", "Envelope")
    return wf


def orchestrator():
    """A0 (spec 8.2): P1 classifies, a deterministic Switch routes. Phase 3 serves search_listings;
    other intents answer with a status code until their agents exist."""
    wf = endpoint("fsOrchestrator01", "wf.orchestrator", "POST", "v1/assistant/message",
                  "5d0c7a1e-8a51-4c43-9d6e-6b1f3f0a0015")
    code_node(wf, "Validate body", "orch_validate.js", [880, -100])
    if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    pg_node(wf, "Context", "select coalesce((select (value #>> '{}')::float from app.settings where key = 'router.min_confidence'), 0.6) as min_confidence",
            None, [1320, -200], on_error=None)
    code_node(wf, "Router input", "orch_p1_input.js", [1540, -200])
    exec_wf(wf, "Classify", LLM_CALL_WF, "wf.llm.call", pos=[1760, -200])
    code_node(wf, "Decide route", "orch_route.js", [1980, -200])
    wf.node("Route by intent", "n8n-nodes-base.switch", 3.2, {
        "mode": "expression", "numberOutputs": 5, "output": "={{ $json.route }}", "options": {}}, [2200, -200])
    code_node(wf, "Profile input", "orch_profile_input.js", [2420, -400])
    exec_wf(wf, "Extract profile", PROFILE_WF, "wf.profile.extract", pos=[2640, -400])
    code_node(wf, "Match input", "orch_match_input.js", [2860, -400])
    if_node(wf, "Search?", "={{ !$json.skip }}", [3080, -400])
    exec_wf(wf, "Match", MATCH_WF, "wf.match.search", pos=[3300, -500])
    code_node(wf, "Search result", "orch_search_result.js", [3520, -400])
    code_node(wf, "Other intents", "orch_other.js", [2420, 0])
    respond_tail(wf, 3740)
    wf.link("Gateway ok?", "Validate body", 0)
    wf.link("Validate body", "Valid?")
    wf.link("Valid?", "Context", 0)
    wf.link("Valid?", "Envelope", 1)
    wf.link("Context", "Router input")
    wf.link("Router input", "Classify")
    wf.link("Classify", "Decide route")
    wf.link("Decide route", "Route by intent")
    wf.link("Route by intent", "Profile input", 0)
    for i in (1, 2, 3, 4):
        wf.link("Route by intent", "Other intents", i)
    wf.link("Profile input", "Extract profile")
    wf.link("Extract profile", "Match input")
    wf.link("Match input", "Search?")
    wf.link("Search?", "Match", 0)
    wf.link("Search?", "Search result", 1)
    wf.link("Match", "Search result")
    wf.link("Search result", "Envelope")
    wf.link("Other intents", "Envelope")
    return wf


def admin_eval_prompt_runs_create():
    return admin_job_endpoint("fsApiEvalPrmt001", "wf.api.admin_eval_prompt_runs_create", "v1/admin/eval/prompt-runs",
                              "5d0c7a1e-8a51-4c43-9d6e-6b1f3f0a0016", "evalp_validate.js", EVALP_WF, "wf.eval.prompts")


EMBED_START_SQL = """with j as (
  update app.jobs set status = 'running', started_at = now(), attempts = attempts + 1
  where id = $1::uuid and status = 'queued' returning id, input)
select j.id as job_id, j.input, app.listings_to_embed(coalesce((j.input->>'limit')::int, 500)) as listings,
  (select jsonb_object_agg(key, value #>> '{}') from app.settings where key in ('ollama.base_url', 'ollama.embed_model')) as cfg
from j"""


def listings_embed():
    wf = WF(EMBED_WF, "wf.listings.embed", tags=["worker"], settings={"saveDataSuccessExecution": "none"})
    E = "continueErrorOutput"
    wf.node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1, {"inputSource": "passthrough"}, [0, 0])
    pg_node(wf, "Start job", EMBED_START_SQL, "={{ [ $json.id ] }}", [220, 0], on_error=None, always_output=True)
    code_node(wf, "Batches", "embed_plan.js", [440, 0], on_error=E)
    if_node(wf, "Anything to embed?", "={{ !$json.none }}", [660, 0])
    wf.node("Loop batches", "n8n-nodes-base.splitInBatches", 3, {"batchSize": 1, "options": {}}, [880, 0])
    http_node(wf, "Embed", "POST", "={{ $json.url }}", [1100, 100], body="={{ JSON.stringify($json.body) }}",
              fmt="json", timeout="={{ 600000 }}", on_error=E)
    code_node(wf, "Vectors", "embed_vectors.js", [1320, 100], on_error=E)
    pg_node(wf, "Store", "select app.store_listing_embeddings($1, $2::jsonb) as stored", "={{ $json.params }}", [1540, 100], on_error=E)
    wf.node("Loop done", "n8n-nodes-base.code", 2, {"mode": "runOnceForAllItems", "language": "javaScript",
            "jsCode": "// wf.listings.embed > \"Loop done\"\nreturn [{ json: {} }];\n"}, [1100, -150])
    code_node(wf, "Summarize", "embed_summary.js", [1320, -150])
    code_node(wf, "Job failed", "worker_failed.js", [1320, -350])
    pg_node(wf, "Finish job", FINISH_JOB_SQL,
            "={{ [ $json.job_id, $json.status, JSON.stringify($json.output), $json.error ] }}", [1540, -250], on_error=None)
    wf.link("Start", "Start job")
    wf.link("Start job", "Batches")
    wf.link("Batches", "Anything to embed?", 0)
    wf.link("Anything to embed?", "Loop batches", 0)
    wf.link("Anything to embed?", "Summarize", 1)
    wf.link("Loop batches", "Loop done", 0)
    wf.link("Loop batches", "Embed", 1)
    wf.link("Embed", "Vectors", 0)
    wf.link("Vectors", "Store", 0)
    wf.link("Store", "Loop batches", 0)
    wf.link("Loop done", "Summarize")
    for n in ("Batches", "Embed", "Vectors", "Store"):
        wf.link(n, "Job failed", 1)
    wf.link("Summarize", "Finish job")
    wf.link("Job failed", "Finish job")
    return wf


def admin_listings_embed():
    return admin_job_endpoint("fsApiListEmb0001", "wf.api.admin_listings_embed", "v1/admin/listings/embed",
                              "5d0c7a1e-8a51-4c43-9d6e-6b1f3f0a0017", "embed_validate.js", EMBED_WF, "wf.listings.embed")


FX_START_SQL = """with j as (
  update app.jobs set status = 'running', started_at = now(), attempts = attempts + 1
  where id = $1::uuid and status = 'queued' returning id)
select j.id as job_id, (select value #>> '{}' from app.settings where key = 'fx.ecb_url') as url,
  (select value #>> '{}' from app.settings where key = 'kb.user_agent') as user_agent from j"""


def fx_refresh():
    """Worker: ECB euro reference rates into app.fx_rates (D-057). Daily schedule or admin job."""
    wf = WF(FX_WF, "wf.fx.refresh", tags=["worker", "fx"], settings={"saveDataSuccessExecution": "none"})
    E = "continueErrorOutput"
    wf.node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1, {"inputSource": "passthrough"}, [0, 0])
    # ECB publishes around 16:00 CET; run at 17:10 Europe/Paris on weekdays.
    wf.node("Every weekday", "n8n-nodes-base.scheduleTrigger", 1.2, {"rule": {"interval": [
        {"field": "cronExpression", "expression": "10 17 * * 1-5"}]}}, [0, 200])
    code_node(wf, "Scheduled", "fx_schedule.js", [220, 200])
    pg_node(wf, "Create job",
            "insert into app.jobs (type, status, input, idempotency_key) values ('fx_refresh', 'queued', '{}'::jsonb, $1)"
            " on conflict (idempotency_key) do nothing returning id", "={{ [ $json.key ] }}", [440, 200], on_error=None)
    pg_node(wf, "Start job", FX_START_SQL, "={{ [ $json.id ] }}", [660, 0], on_error=None, always_output=True)
    if_node(wf, "Job started?", "={{ !!$json.job_id }}", [880, 0])
    http_node(wf, "Fetch rates", "GET", "={{ $json.url }}", [1100, -100], fmt="text", timeout="={{ 30000 }}",
              headers=[("User-Agent", "={{ $json.user_agent }}")], on_error=E)
    code_node(wf, "Parse rates", "fx_parse.js", [1320, -100], on_error=E)
    pg_node(wf, "Store rates", "select app.store_fx_rates($1::jsonb) as stored", "={{ $json.params }}", [1540, -100], on_error=E)
    code_node(wf, "Summarize", "fx_summary.js", [1760, -100])
    code_node(wf, "Job failed", "worker_failed.js", [1760, 100])
    pg_node(wf, "Finish job", FINISH_JOB_SQL,
            "={{ [ $json.job_id, $json.status, JSON.stringify($json.output), $json.error ] }}", [1980, 0], on_error=None)
    wf.link("Start", "Start job")
    wf.link("Every weekday", "Scheduled")
    wf.link("Scheduled", "Create job")
    wf.link("Create job", "Start job")
    wf.link("Start job", "Job started?")
    wf.link("Job started?", "Fetch rates", 0)
    wf.link("Fetch rates", "Parse rates", 0)
    wf.link("Parse rates", "Store rates", 0)
    wf.link("Store rates", "Summarize", 0)
    for n in ("Fetch rates", "Parse rates", "Store rates"):
        wf.link(n, "Job failed", 1)
    wf.link("Summarize", "Finish job")
    wf.link("Job failed", "Finish job")
    return wf


def admin_fx_refresh():
    return admin_job_endpoint("fsApiFxRefresh01", "wf.api.admin_fx_refresh", "v1/admin/fx/refresh",
                              "5d0c7a1e-8a51-4c43-9d6e-6b1f3f0a0018", "fx_validate.js", FX_WF, "wf.fx.refresh")


BUILDS = {
    "workflows": [gateway, health, users_sync, error_handler, admin_kb_ingest, kb_ingest, kb_ingest_source,
                  jobs_get, admin_eval_runs_create, eval_retrieval, admin_eval_runs_get,
                  llm_call, eval_prompts, profile_extract, match_search, api_search, api_profiles_extract, api_profiles_me,
                  orchestrator, admin_eval_prompt_runs_create, listings_embed, admin_listings_embed, fx_refresh, admin_fx_refresh],
    "workflows-test": [test_fail],
}


def main():
    check = "--check" in sys.argv
    changed = []
    for folder, fns in BUILDS.items():
        out = ROOT / folder
        out.mkdir(exist_ok=True)
        for fn in fns:
            wf = fn()
            path = out / f"{wf.name}.json"
            text = json.dumps(wf.json(), indent=2, ensure_ascii=False) + "\n"
            if check:
                if not path.exists() or path.read_text(encoding="utf-8") != text:
                    changed.append(str(path.relative_to(ROOT.parent)))
            else:
                path.write_text(text, encoding="utf-8")
                print("wrote", path.relative_to(ROOT.parent))
    if check:
        if changed:
            print("out of date:", *changed, sep="\n  ")
            sys.exit(1)
        print("workflow JSON is up to date")


if __name__ == "__main__":
    main()
