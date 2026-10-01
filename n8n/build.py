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


def pg_node(wf, name, query, replacement, pos=None, on_error="continueErrorOutput", always_output=False):
    params = {"operation": "executeQuery", "query": query, "options": {}}
    if replacement:
        params["options"]["queryReplacement"] = replacement
    extra = {"onError": on_error} if on_error else {}
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
where exists (select 1 from app.jurisdictions where code = $1::jsonb->>'jurisdiction')
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
    http_node(wf, "Embed", "POST", "={{ $json.url }}", [3740, -200], body="={{ JSON.stringify($json.body) }}",
              fmt="text", timeout="={{ Number($('Cleaned').first().json.cfg.embed_timeout_ms || 600000) }}")
    code_node(wf, "Vectors", "kb_src_vectors.js", [3960, -200])
    pg_node(wf, "Store embeddings", "select $1::text as model, kb.store_embeddings($1, $2::jsonb) as n",
            "={{ [ $json.model, $json.rows ] }}", [4180, -200], on_error=None)
    code_node(wf, "Result", "kb_src_result.js", [4400, -200], subst={"__MODE__": "done"})

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
    wf.link("Embed batches", "Embed")
    wf.link("Embed", "Vectors")
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


BUILDS = {
    "workflows": [gateway, health, users_sync, error_handler, admin_kb_ingest, kb_ingest, kb_ingest_source,
                  jobs_get, admin_eval_runs_create, eval_retrieval, admin_eval_runs_get],
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
