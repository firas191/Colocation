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

    def ai_link(self, src, dst, kind):
        """Sub-node connection of an AI root node: kind is ai_languageModel, ai_memory or ai_tool."""
        outs = self.conns.setdefault(src, {}).setdefault(kind, [[]])
        outs[0].append({"node": dst, "type": kind, "index": 0})

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


SVC_CRED = {"httpHeaderAuth": {"id": "fsCredSvcToken01", "name": "Compute services token"}}


def http_node(wf, name, method, url, pos=None, body=None, fmt="text", full=False, never_error=False,
              timeout="={{ 30000 }}", headers=None, on_error=None, svc=False):
    """HTTP Request node. body: expression producing a JSON string. fmt: text | file | json.
    svc=True: sends X-Internal-Token from the n8n credential (compute services, spec 5.4 item 4)."""
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
    if svc:
        params.update({"authentication": "genericCredentialType", "genericAuthType": "httpHeaderAuth"})
        extra["credentials"] = SVC_CRED
    return wf.node(name, "n8n-nodes-base.httpRequest", 4.2, params, pos, **extra)


def exec_wf(wf, name, wid, wname, wait=True, pos=None, on_error=None, each=False):
    """each=True starts one sub-workflow execution per input item (the workers assume one item, F-054)."""
    extra = {"onError": on_error} if on_error else {}
    return wf.node(name, "n8n-nodes-base.executeWorkflow", 1.2, {
        "source": "database",
        "workflowId": {"__rl": True, "value": wid, "mode": "id", "cachedResultName": wname},
        "mode": "each" if each else "once",
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
MATCH_AGENT_WF = "fsMatchAgent0001"
MATCH_TOOL_SEARCH_WF = "fsMatchToolSrch1"
MATCH_TOOL_LISTING_WF = "fsMatchToolList1"
OLLAMA_CRED = {"ollamaApi": {"id": "fsCredOllama0001", "name": "Ollama (local)"}}
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
            " (select jsonb_object_agg(key, value) from app.settings where key like 'llm.%' or key = 'ollama.base_url'"
            "   or key like 'vision.%' or key = 'services.media_url') as cfg",
            "={{ [ $json.prompt, $json.version === null || $json.version === undefined ? '' : String($json.version) ] }}",
            [220, 0], on_error=None)
    # P7: the photo comes from the Media service as a small JPEG of the stored (blurred) copy (D-081).
    if_node(wf, "Image?", "={{ !!($('Start').first().json.image && $('Start').first().json.image.key) }}", [330, 150])
    http_node(wf, "Load image", "POST", "={{ String($json.cfg['services.media_url']).replace(/\\/+$/, '') + '/v1/images/vision' }}",
              [440, 250], body="={{ JSON.stringify({ key: $('Start').first().json.image.key, max_side: Number($json.cfg['vision.max_side'] || 1024) }) }}",
              fmt="json", full=True, never_error=True, timeout="={{ 60000 }}", svc=True, on_error="continueRegularOutput")
    code_node(wf, "Build request", "llm_build.js", [660, 0])
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
    wf.link("Load prompt", "Image?")
    wf.link("Image?", "Load image", 0)
    wf.link("Image?", "Build request", 1)
    wf.link("Load image", "Build request")
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


def tool_inputs(names):
    """Start node of a sub-workflow called as an agent tool: named inputs, so the tool node can map them."""
    return {"inputSource": "workflowInputs",
            "workflowInputs": {"values": [{"name": n, **({"type": t} if t != "string" else {})} for n, t in names]}}


def tool_mapping(fields):
    """workflowInputs of a 'Call n8n Workflow Tool' node: fields is [(name, type, expression)]."""
    return {"mappingMode": "defineBelow", "value": {n: e for n, _t, e in fields}, "matchingColumns": [],
            "schema": [{"id": n, "displayName": n, "required": False, "defaultMatch": False, "display": True,
                        "canBeUsedToMatch": True, "type": t, "removed": False} for n, t, _e in fields],
            "attemptToConvertTypes": False, "convertFieldsToString": False}


def match_tool_search():
    """Tool of the A3 Match agent: the agent's request in words -> P2 profile -> wf.match.search. Stores the result
    for the conversation (ai.match_sessions) and answers the model with fields only (D-084)."""
    wf = WF(MATCH_TOOL_SEARCH_WF, "wf.match.tool_search", tags=["agent"])
    wf.node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1,
            tool_inputs([("request", "string"), ("session_id", "string"), ("user_id", "string"), ("request_id", "string"),
                         ("jurisdiction", "string"), ("today", "string")]), [0, 0])
    code_node(wf, "Profile input", "tool_search_input.js", [220, 0])
    exec_wf(wf, "Extract profile", PROFILE_WF, "wf.profile.extract", pos=[440, 0])
    code_node(wf, "Search plan", "tool_search_plan.js", [660, 0])
    if_node(wf, "Search?", "={{ !$json.skip }}", [880, 0])
    exec_wf(wf, "Match", MATCH_WF, "wf.match.search", pos=[1100, -100])
    code_node(wf, "Session data", "tool_search_session.js", [1320, 0])
    pg_node(wf, "Store", "select app.match_session_store($1, $2::uuid, $3::uuid, $4::jsonb) as r", "={{ $json.params }}",
            [1540, 0], on_error=None)
    code_node(wf, "Tool answer", "tool_search_answer.js", [1760, 0])
    for a, b in (("Start", "Profile input"), ("Profile input", "Extract profile"), ("Extract profile", "Search plan"),
                 ("Search plan", "Search?"), ("Match", "Session data"), ("Session data", "Store"), ("Store", "Tool answer")):
        wf.link(a, b)
    wf.link("Search?", "Match", 0)
    wf.link("Search?", "Session data", 1)
    return wf


def match_tool_listing():
    """Tool of the A3 Match agent: fields of one result of the conversation's last search, by its number."""
    wf = WF(MATCH_TOOL_LISTING_WF, "wf.match.tool_listing", tags=["agent"])
    wf.node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1,
            tool_inputs([("number", "number"), ("session_id", "string")]), [0, 0])
    pg_node(wf, "Listing", "select app.match_session_listing($1, $2::int) as r",
            "={{ [ $json.session_id || '', Number.isInteger(Number($json.number)) ? Number($json.number) : 0 ] }}", [220, 0],
            on_error=None)
    code_node(wf, "Tool answer", "tool_listing_answer.js", [440, 0])
    wf.link("Start", "Listing")
    wf.link("Listing", "Tool answer")
    return wf


SEARCH_TOOL_DESC = ("Search the published room and flatshare listings. Input: the whole search in one sentence in the user's "
                    "words (kind of place, budget, area, dates, rules). For a change to an earlier search, write the earlier "
                    "request again with the change. Returns how many were found, what was understood and numbered results.")
LISTING_TOOL_DESC = ("Details of one result of the last search: give its number in the list (1 for the first). Returns its "
                     "fields: rent, deposit, bills, furnished, bedrooms, flatmates, amenities, house rules, area, distance, "
                     "availability.")


def match_agent():
    """A3 Match agent (spec 8.2): an n8n AI Agent node with the local chat model (Ollama), a Postgres chat memory per
    user and two workflow tools. System message from the prompt registry (P6_match_agent). Input {text (masked),
    language, jurisdiction, today, user_id, request_id}. Output {ok, status, answer, results, profile, anchor, steps}."""
    wf = WF(MATCH_AGENT_WF, "wf.match.agent", tags=["agent"])
    wf.node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1, {"inputSource": "passthrough"}, [0, 0])
    pg_node(wf, "Context", "select app.match_agent_context($1::uuid) as c", "={{ [ $json.user_id ] }}", [220, 0], on_error=None)
    code_node(wf, "Agent input", "agent_input.js", [440, 0])
    if_node(wf, "Prompt ok?", "={{ $json.ok }}", [660, 0])
    wf.node("Match agent", "@n8n/n8n-nodes-langchain.agent", 3.1, {
        "promptType": "define", "text": "={{ $json.text }}", "hasOutputParser": False,
        "options": {"systemMessage": "={{ $json.system }}", "maxIterations": "={{ $json.max_iterations }}",
                    "returnIntermediateSteps": True}}, [900, -100], onError="continueRegularOutput")
    wf.node("Ollama Chat Model", "@n8n/n8n-nodes-langchain.lmChatOllama", 1, {
        "model": "={{ $('Agent input').first().json.model }}",
        "options": {"temperature": 0, "think": False, "keepAlive": "={{ $('Agent input').first().json.keep_alive }}",
                    "numCtx": "={{ $('Agent input').first().json.num_ctx }}",
                    "numPredict": "={{ $('Agent input').first().json.num_predict }}"}},
        [760, 140], credentials=OLLAMA_CRED)
    wf.node("Chat memory", "@n8n/n8n-nodes-langchain.memoryPostgresChat", 1.3, {
        "sessionIdType": "customKey", "sessionKey": "={{ $('Agent input').first().json.session_id }}",
        "tableName": "agent_memory.chat_histories",
        "contextWindowLength": "={{ $('Agent input').first().json.memory_turns }}"}, [900, 140], credentials=PG_CRED)
    ai = "$('Agent input').first().json"
    wf.node("search_listings", "@n8n/n8n-nodes-langchain.toolWorkflow", 2.2, {
        "description": SEARCH_TOOL_DESC, "source": "database",
        "workflowId": {"__rl": True, "value": MATCH_TOOL_SEARCH_WF, "mode": "id", "cachedResultName": "wf.match.tool_search"},
        "workflowInputs": tool_mapping([
            ("request", "string", "={{ $fromAI('request', 'The whole search in one sentence, in the words of the user', 'string') }}"),
            ("session_id", "string", "={{ %s.session_id }}" % ai), ("user_id", "string", "={{ %s.user_id }}" % ai),
            ("request_id", "string", "={{ %s.request_id }}" % ai), ("jurisdiction", "string", "={{ %s.jurisdiction }}" % ai),
            ("today", "string", "={{ %s.today }}" % ai)])}, [1040, 140])
    wf.node("listing_details", "@n8n/n8n-nodes-langchain.toolWorkflow", 2.2, {
        "description": LISTING_TOOL_DESC, "source": "database",
        "workflowId": {"__rl": True, "value": MATCH_TOOL_LISTING_WF, "mode": "id", "cachedResultName": "wf.match.tool_listing"},
        "workflowInputs": tool_mapping([
            ("number", "number", "={{ $fromAI('number', 'Number of the result in the last list, 1 for the first', 'number') }}"),
            ("session_id", "string", "={{ %s.session_id }}" % ai)])}, [1180, 140])
    code_node(wf, "Check answer", "agent_output.js", [1180, -100])
    pg_node(wf, "Search of this request", "select app.match_session_result($1, $2::uuid) as r",
            "={{ [ $json.session_id, $json.request_id ] }}", [1400, -100], on_error=None)
    code_node(wf, "Result", "agent_result.js", [1620, -100])
    code_node(wf, "No prompt", "agent_prompt_missing.js", [900, 260])
    wf.link("Start", "Context")
    wf.link("Context", "Agent input")
    wf.link("Agent input", "Prompt ok?")
    wf.link("Prompt ok?", "Match agent", 0)
    wf.link("Prompt ok?", "No prompt", 1)
    wf.link("Match agent", "Check answer")
    wf.link("Check answer", "Search of this request")
    wf.link("Search of this request", "Result")
    wf.ai_link("Ollama Chat Model", "Match agent", "ai_languageModel")
    wf.ai_link("Chat memory", "Match agent", "ai_memory")
    wf.ai_link("search_listings", "Match agent", "ai_tool")
    wf.ai_link("listing_details", "Match agent", "ai_tool")
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
    pg_node(wf, "Context", "select coalesce((select (value #>> '{}')::float from app.settings where key = 'router.min_confidence'), 0.6) as min_confidence,"
            " (select value #>> '{}' from app.settings where key = 'services.text_url') as text_url,"
            " coalesce((select value #>> '{}' from app.settings where key = 'match.agent_enabled'), 'false') = 'true' as agent_enabled,"
            " app.match_followup_open($1::uuid) as followup_open",
            "={{ [ $json.gw.ctx.user_id ] }}", [1320, -200], on_error=None)
    # Text service before P1 (spec 8.2 A0, 9.7): language identification and PII count. A failure here is
    # recorded in the trace and does not stop the request (phase 4, D-074).
    http_node(wf, "Text analysis", "POST", "={{ $json.text_url.replace(/\\/+$/, '') + '/v1/analyze' }}", [1430, -350],
              body="={{ JSON.stringify({ text: $('Validate body').first().json.text, mask: true, use_ner: true }) }}",
              fmt="json", full=True, never_error=True, timeout="={{ 10000 }}", svc=True, on_error="continueRegularOutput")
    code_node(wf, "Router input", "orch_p1_input.js", [1540, -200])
    exec_wf(wf, "Classify", LLM_CALL_WF, "wf.llm.call", pos=[1760, -200])
    code_node(wf, "Decide route", "orch_route.js", [1980, -200])
    wf.node("Route by intent", "n8n-nodes-base.switch", 3.2, {
        "mode": "expression", "numberOutputs": 5, "output": "={{ $json.route }}", "options": {}}, [2200, -200])
    # search_listings: the A3 Match agent when it is on (D-084); P2 + search when it is off or fails
    if_node(wf, "Use agent?", "={{ $json.agent_enabled }}", [2420, -700])
    code_node(wf, "Agent request", "orch_agent_input.js", [2640, -800])
    exec_wf(wf, "Match agent", MATCH_AGENT_WF, "wf.match.agent", pos=[2860, -800], on_error="continueRegularOutput")
    if_node(wf, "Agent ok?", "={{ $json.ok === true }}", [3080, -800])
    code_node(wf, "Agent answer", "orch_agent_result.js", [3300, -900])
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
    wf.link("Context", "Text analysis")
    wf.link("Text analysis", "Router input")
    wf.link("Router input", "Classify")
    wf.link("Classify", "Decide route")
    wf.link("Decide route", "Route by intent")
    wf.link("Route by intent", "Use agent?", 0)
    wf.link("Use agent?", "Agent request", 0)
    wf.link("Use agent?", "Profile input", 1)
    wf.link("Agent request", "Match agent")
    wf.link("Match agent", "Agent ok?")
    wf.link("Agent ok?", "Agent answer", 0)
    wf.link("Agent ok?", "Profile input", 1)
    wf.link("Agent answer", "Envelope")
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



# ---------------------------------------------------------------- phase 4: listings and media intake
LISTING_GET_HOOK = "5d0c7a1e-8a51-4c43-9d6e-6b1f3f0a0019"        # parameterised routes: see infra/caddy/Caddyfile
LISTING_PRESIGN_HOOK = "5d0c7a1e-8a51-4c43-9d6e-6b1f3f0a001a"
LISTING_ANALYZE_HOOK = "5d0c7a1e-8a51-4c43-9d6e-6b1f3f0a001b"
ME_CONSENTS_HOOK = "5d0c7a1e-8a51-4c43-9d6e-6b1f3f0a001c"
TRACE_GET_HOOK = "5d0c7a1e-8a51-4c43-9d6e-6b1f3f0a001d"        # parameterised: see infra/caddy/Caddyfile
MEDIA_CONSENTS = ["terms", "privacy", "media_processing"]      # spec 11.1 privacy, 13.4
ANALYZE_WF = "fsListingAnalyz1"
INTAKE_PHOTOS_WF = "fsIntakePhotos01"
LISTING_EXTRACT_WF = "fsListingExtr001"
SETTINGS_SQL = ("select (select value #>> '{}' from app.settings where key = 'services.media_url') as media_url,"
                " (select value #>> '{}' from app.settings where key = 'services.text_url') as text_url,"
                " (select value #>> '{}' from app.settings where key = 'services.asr_url') as asr_url")
ANALYZE_START_SQL = """with j as (select * from app.job_start($1::uuid))
select j.id as job_id, j.input, j.attempts, j.max_attempts,
  (select value #>> '{}' from app.settings where key = 'services.media_url') as media_url,
  coalesce((select jsonb_agg(jsonb_build_object('upload_id', u.id, 'kind', u.kind, 'key', u.storage_key) order by u.created_at)
            from app.media_uploads u
            where u.listing_id = (j.input->>'listing_id')::uuid and u.status in ('pending', 'expired', 'processing')), '[]'::jsonb) as uploads
from j"""
JOB_FINISH_SQL = "select id, status, attempts, next_attempt_at from app.job_finish($1::uuid, $2, $3::jsonb, $4, $5::boolean)"


def api_listings_create():
    wf = endpoint("fsApiListCreate1", "wf.api.listings_create", "POST", "v1/listings",
                  "5d0c7a1e-8a51-4c43-9d6e-6b1f3f0a0018", {"idempotent": True})
    code_node(wf, "Validate body", "listings_create_validate.js", [880, -100])
    if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    pg_node(wf, "Create listing", "select app.listing_create($1::uuid, $2::jsonb) as r", "={{ $json.params }}", [1320, -200], on_error=None)
    code_node(wf, "Build result", "listings_create_result.js", [1540, -200])
    respond_tail(wf, 1760)
    wf.link("Gateway ok?", "Validate body", 0)
    wf.link("Validate body", "Valid?")
    wf.link("Valid?", "Create listing", 0)
    wf.link("Valid?", "Envelope", 1)
    wf.link("Create listing", "Build result")
    wf.link("Build result", "Envelope")
    return wf


def api_listings_get():
    wf = endpoint("fsApiListGet0001", "wf.api.listings_get", "GET", "v1/listings/:id", LISTING_GET_HOOK)
    pg_node(wf, "Load", "select app.listing_owner_view(app.try_uuid($1), app.try_uuid($2)) as v",
            "={{ [ $json.ctx.user_id, $json.ctx.params.id || '' ] }}", [880, -100], on_error=None)
    code_node(wf, "Build result", "listings_get_result.js", [1100, -100])
    respond_tail(wf, 1320)
    wf.link("Gateway ok?", "Load", 0)
    wf.link("Load", "Build result")
    wf.link("Build result", "Envelope")
    return wf


def api_listings_presign():
    wf = endpoint("fsApiListPresig1", "wf.api.listings_presign", "POST", "v1/listings/:id/media/presign", LISTING_PRESIGN_HOOK,
                  {"idempotent": True, "required_consents": MEDIA_CONSENTS})
    code_node(wf, "Validate body", "listings_presign_validate.js", [880, -100])
    if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    pg_node(wf, "Settings", SETTINGS_SQL, None, [1320, -200], on_error=None)
    pg_node(wf, "Create slots", "select app.media_upload_create($1::uuid, app.try_uuid($2), $3::jsonb) as r",
            "={{ $('Validate body').first().json.params }}", [1540, -200], on_error=None)
    code_node(wf, "Slots", "listings_presign_slots.js", [1760, -200])
    if_node(wf, "Slots ok?", "={{ !$json.reject }}", [1980, -200])
    http_node(wf, "Presign", "POST", "={{ $json.url }}", [2200, -300], body="={{ JSON.stringify($json.body) }}",
              fmt="text", full=True, never_error=True, timeout="={{ 15000 }}", svc=True)
    code_node(wf, "Build result", "listings_presign_result.js", [2420, -300])
    respond_tail(wf, 2640)
    wf.link("Gateway ok?", "Validate body", 0)
    wf.link("Validate body", "Valid?")
    wf.link("Valid?", "Settings", 0)
    wf.link("Valid?", "Envelope", 1)
    wf.link("Settings", "Create slots")
    wf.link("Create slots", "Slots")
    wf.link("Slots", "Slots ok?")
    wf.link("Slots ok?", "Presign", 0)
    wf.link("Slots ok?", "Envelope", 1)
    wf.link("Presign", "Build result")
    wf.link("Build result", "Envelope")
    return wf


def api_listings_analyze():
    wf = endpoint("fsApiListAnalyz1", "wf.api.listings_analyze", "POST", "v1/listings/:id/analyze", LISTING_ANALYZE_HOOK,
                  {"idempotent": True, "required_consents": MEDIA_CONSENTS})
    code_node(wf, "Validate body", "listings_analyze_validate.js", [880, -100])
    if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    pg_node(wf, "Check listing",
            "select l.id, l.status, l.owner_id = app.try_uuid($1) as mine,"
            " (select count(*) from app.media_uploads u where u.listing_id = l.id and u.status in ('pending', 'expired')) as pending,"
            " coalesce(btrim(l.description), '') <> '' as has_text"
            " from (select app.try_uuid($2) as id) k left join app.listings l on l.id = k.id",
            "={{ $json.params }}", [1320, -200], on_error=None)
    code_node(wf, "Job input", "listings_analyze_job.js", [1540, -200])
    if_node(wf, "Accept?", "={{ $json.ok }}", [1760, -200])
    pg_node(wf, "Create job", CREATE_JOB_SQL, "={{ $json.params }}", [1980, -300], on_error=None, always_output=True)
    if_node(wf, "Newly created?", "={{ $json.created === true }}", [2200, -300])
    exec_wf(wf, "Start worker", ANALYZE_WF, "wf.listing.analyze", wait=False, pos=[2420, -400])
    code_node(wf, "Accepted", "listings_analyze_accepted.js", [2640, -300])
    respond_tail(wf, 2860)
    wf.link("Gateway ok?", "Validate body", 0)
    wf.link("Validate body", "Valid?")
    wf.link("Valid?", "Check listing", 0)
    wf.link("Valid?", "Envelope", 1)
    wf.link("Check listing", "Job input")
    wf.link("Job input", "Accept?")
    wf.link("Accept?", "Create job", 0)
    wf.link("Accept?", "Envelope", 1)
    wf.link("Create job", "Newly created?")
    wf.link("Newly created?", "Start worker", 0)
    wf.link("Newly created?", "Accepted", 1)
    wf.link("Start worker", "Accepted")
    wf.link("Accepted", "Envelope")
    return wf


def api_me_consents():
    """POST /v1/me/consents (spec 6.2, 13.4): record consent; no consent needed to call it."""
    wf = endpoint("fsApiMeConsent01", "wf.api.me_consents", "POST", "v1/me/consents", ME_CONSENTS_HOOK,
                  {"idempotent": True, "required_consents": []})
    code_node(wf, "Validate body", "me_consents_validate.js", [880, -100])
    if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    pg_node(wf, "Record", "select app.record_consents($1::uuid, $2::jsonb) as c", "={{ $json.params }}", [1320, -200], on_error=None)
    code_node(wf, "Build result", "me_consents_result.js", [1540, -200])
    respond_tail(wf, 1760)
    wf.link("Gateway ok?", "Validate body", 0)
    wf.link("Validate body", "Valid?")
    wf.link("Valid?", "Record", 0)
    wf.link("Valid?", "Envelope", 1)
    wf.link("Record", "Build result")
    wf.link("Build result", "Envelope")
    return wf


def api_admin_traces_get():
    """GET /v1/admin/traces/:request_id (spec 6.2, 8.3), admins only."""
    return get_by_id_endpoint("fsApiTraceGet001", "wf.api.admin_traces_get", "/v1/admin/traces/:id", TRACE_GET_HOOK, ["admin"],
                              "select ai.trace(app.try_uuid($1)) as t", "trace_get_result.js")


def intake_photos():
    """A1 intake for one uploaded photo (spec 8.4 wf.intake.photos, 11.2 steps 1 to 4 and the duplicate lookup)."""
    wf = WF(INTAKE_PHOTOS_WF, "wf.intake.photos", tags=["agent", "intake"])
    wf.node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1, {"inputSource": "passthrough"}, [0, 0])
    code_node(wf, "Request", "intake_photo_request.js", [220, 0])
    http_node(wf, "Process", "POST", "={{ $json.url }}", [440, 0], body="={{ JSON.stringify($json.body) }}",
              fmt="json", full=True, never_error=True, timeout="={{ 120000 }}", svc=True, on_error="continueRegularOutput")
    code_node(wf, "Outcome", "intake_photo_outcome.js", [660, 0])
    wf.node("Action", "n8n-nodes-base.switch", 3.2, {
        "mode": "expression", "numberOutputs": 3,
        "output": "={{ ({store: 0, reject: 1})[$json.action] ?? 2 }}", "options": {}}, [880, 0])
    pg_node(wf, "Store photo", "select app.store_listing_photo($1::uuid, $2::jsonb) as r,"
            " coalesce((select value::text from app.settings where key = 'vision.enabled'), 'true') = 'true' as vision",
            "={{ [ $json.upload_id, JSON.stringify($json.report) ] }}", [1100, -200], on_error=None, retries=1)
    # Step 5 and 6 of spec 11.2: P7 on the stored copy; a failed analysis is stored as failed (D-081).
    if_node(wf, "Analyze photo?", "={{ !!($json.r && $json.r.ok && $json.vision) }}", [1320, -200])
    code_node(wf, "Vision input", "photo_vision_vars.js", [1540, -350])
    exec_wf(wf, "Analyze photo", LLM_CALL_WF, "wf.llm.call", pos=[1760, -350], on_error="continueRegularOutput")
    code_node(wf, "Check photo", "photo_vision_post.js", [1980, -350])
    pg_node(wf, "Store analysis", "select app.store_photo_analysis($1::uuid, $2::jsonb) as r",
            "={{ [ $json.media_id, JSON.stringify($json.analysis) ] }}", [2200, -350], on_error="continueRegularOutput", retries=1)
    pg_node(wf, "Record steps", "select app.record_job_steps(nullif($1, '')::uuid, 'wf.intake.photos', $2, $3::jsonb) as execution_id",
            "={{ [ $('Start').first().json.job_id || '', $execution.id, JSON.stringify($('Check photo').first().json.steps) ] }}",
            [2420, -350], on_error="continueRegularOutput")
    pg_node(wf, "Reject upload", "select app.media_upload_reject($1::uuid, $2, $3) as r",
            "={{ [ $json.upload_id, $json.code, $json.message ] }}", [1100, 0], on_error=None, retries=1)
    code_node(wf, "Result", "intake_photo_result.js", [2640, 0])
    wf.link("Start", "Request")
    wf.link("Request", "Process")
    wf.link("Process", "Outcome")
    wf.link("Outcome", "Action")
    wf.link("Action", "Store photo", 0)
    wf.link("Action", "Reject upload", 1)
    wf.link("Action", "Result", 2)
    wf.link("Store photo", "Analyze photo?")
    wf.link("Analyze photo?", "Vision input", 0)
    wf.link("Analyze photo?", "Result", 1)
    wf.link("Vision input", "Analyze photo")
    wf.link("Analyze photo", "Check photo")
    wf.link("Check photo", "Store analysis")
    wf.link("Store analysis", "Record steps")
    wf.link("Record steps", "Result")
    wf.link("Reject upload", "Result")
    return wf


EXTRACT_CONTEXT_SQL = """select l.id as listing_id, l.description as text, l.jurisdiction_code,
  to_char((now() at time zone j.timezone)::date, 'YYYY-MM-DD') as today, app.extraction_context(l.jurisdiction_code) as ctx,
  (select value #>> '{}' from app.settings where key = 'services.text_url') as text_url,
  (select coalesce(jsonb_agg(m.analysis->'vision' order by m.created_at), '[]'::jsonb) from app.listing_media m
    where m.listing_id = l.id and m.kind = 'photo' and m.analysis ? 'vision') as photos
from app.listings l join app.jurisdictions j on j.code = l.jurisdiction_code where l.id = $1::uuid"""


def listing_extract():
    """A1 extraction (spec 8.4 wf.listing.extract, 9.3 P3): listing text -> checked structured fields.
    Input {listing_id, job_id?, model?, version?}; output see listing_extract_result.js."""
    wf = WF(LISTING_EXTRACT_WF, "wf.listing.extract", tags=["agent", "intake"], settings={"saveDataSuccessExecution": "all"})
    wf.node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1, {"inputSource": "passthrough"}, [0, 0])
    pg_node(wf, "Context", EXTRACT_CONTEXT_SQL, "={{ [ $json.listing_id ] }}", [220, 0], on_error=None)
    if_node(wf, "Has text?", "={{ !!($json.text || '').trim() }}", [440, 0])
    # Language and PII counts of the listing text (Text service); a failure does not stop the extraction.
    http_node(wf, "Text analysis", "POST", "={{ String($json.text_url).replace(/\\/+$/, '') + '/v1/analyze' }}", [660, -100],
              body="={{ JSON.stringify({ text: $json.text, mask: true, use_ner: true }) }}",
              fmt="json", full=True, never_error=True, timeout="={{ 20000 }}", svc=True, on_error="continueRegularOutput")
    code_node(wf, "Call input", "listing_extract_vars.js", [880, -100])
    exec_wf(wf, "Extract", LLM_CALL_WF, "wf.llm.call", pos=[1100, -100])
    code_node(wf, "Check listing", "listing_extract_post.js", [1320, -100])
    if_node(wf, "Store?", "={{ $json.store }}", [1540, -100])
    pg_node(wf, "Store extraction", "select app.store_listing_extraction($1::uuid, $2::jsonb) as r", "={{ $json.params }}",
            [1760, -200], on_error=None, retries=1)
    pg_node(wf, "Record steps", "select app.record_job_steps(nullif($1, '')::uuid, 'wf.listing.extract', $2, $3::jsonb) as execution_id",
            "={{ [ $('Start').first().json.job_id || '', $execution.id, JSON.stringify($('Check listing').first().json.steps) ] }}",
            [1980, -100], on_error="continueRegularOutput")
    code_node(wf, "Result", "listing_extract_result.js", [2200, 0])
    wf.link("Start", "Context")
    wf.link("Context", "Has text?")
    wf.link("Has text?", "Text analysis", 0)
    wf.link("Has text?", "Result", 1)
    wf.link("Text analysis", "Call input")
    wf.link("Call input", "Extract")
    wf.link("Extract", "Check listing")
    wf.link("Check listing", "Store?")
    wf.link("Store?", "Store extraction", 0)
    wf.link("Store?", "Record steps", 1)
    wf.link("Store extraction", "Record steps")
    wf.link("Record steps", "Result")
    return wf


def listing_analyze():
    """Job worker for POST /v1/listings/:id/analyze: photos (4.3), then the text extraction P3 (4.4).
    Retries transient failures (spec 5.6)."""
    E = "continueErrorOutput"
    wf = WF(ANALYZE_WF, "wf.listing.analyze", tags=["worker", "intake"], settings={"saveDataSuccessExecution": "all"})
    wf.node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1, {"inputSource": "passthrough"}, [0, 0])
    pg_node(wf, "Start job", ANALYZE_START_SQL, "={{ [ $json.id ] }}", [220, 0], on_error=None, always_output=True)
    code_node(wf, "Plan", "analyze_plan.js", [440, 0], on_error=E)
    code_node(wf, "Job failed", "analyze_failed.js", [660, 400])
    if_node(wf, "Any photo?", "={{ !$json.none }}", [660, 0])
    wf.node("Loop files", "n8n-nodes-base.splitInBatches", 3, {"batchSize": 1, "options": {}}, [880, -100])
    exec_wf(wf, "Intake photo", INTAKE_PHOTOS_WF, "wf.intake.photos", wait=True, pos=[1100, 0], on_error=E)
    code_node(wf, "Summarize", "analyze_summary.js", [1100, -300], on_error=E)
    http_node(wf, "Delete raw uploads", "POST", "={{ $json.delete_url }}", [1320, -300],
              body="={{ JSON.stringify({ keys: $json.delete_keys.length ? $json.delete_keys : ['none/none'] }) }}",
              fmt="text", full=True, never_error=True, timeout="={{ 30000 }}", svc=True, on_error="continueRegularOutput")
    wf.node("Extract input", "n8n-nodes-base.code", 2, {"mode": "runOnceForAllItems", "language": "javaScript", "jsCode":
            "// wf.listing.analyze > \"Extract input\"\nconst s = $('Summarize').first().json;\n"
            "return [{ json: { listing_id: s.output.listing_id, job_id: s.job_id } }];\n"}, [1540, -300])
    exec_wf(wf, "Extract listing", LISTING_EXTRACT_WF, "wf.listing.extract", wait=True, pos=[1760, -300], on_error=E)
    # Automatic publication for tests and demos (D-083): only after a successful extraction; the function checks the setting.
    if_node(wf, "Extracted?", "={{ $json.status === 'extracted' }}", [1980, -450])
    pg_node(wf, "Auto publish", "select app.listing_auto_publish($1::uuid) as r", "={{ [ $json.listing_id ] }}", [2200, -550],
            on_error="continueRegularOutput")
    if_node(wf, "Embed now?", "={{ !!($json.r && $json.r.published && $json.r.embed_text) }}", [2420, -550])
    code_node(wf, "Embedding request", "analyze_embed_request.js", [2640, -650])
    http_node(wf, "Embed listing", "POST", "={{ $json.url }}", [2860, -650], body="={{ JSON.stringify($json.body) }}",
              fmt="json", full=True, never_error=True, timeout="={{ 60000 }}", on_error="continueRegularOutput")
    code_node(wf, "Embedding rows", "analyze_embed_store.js", [3080, -650])
    if_node(wf, "Store vector?", "={{ !$json.skip }}", [3300, -650])
    pg_node(wf, "Store vector", "select app.store_listing_embeddings($1, $2::jsonb) as stored", "={{ $json.params }}",
            [3520, -700], on_error="continueRegularOutput")
    code_node(wf, "Finish input", "analyze_finish.js", [3740, -300], on_error=E)
    pg_node(wf, "Finish job", JOB_FINISH_SQL, "={{ $json.params }}", [3960, -300], on_error=None, retries=2)
    pg_node(wf, "Finish failed job", JOB_FINISH_SQL, "={{ $json.params }}", [880, 400], on_error=None, retries=2)
    wf.link("Start", "Start job")
    wf.link("Start job", "Plan")
    wf.link("Plan", "Any photo?", 0)
    wf.link("Plan", "Job failed", 1)
    wf.link("Any photo?", "Loop files", 0)
    wf.link("Any photo?", "Summarize", 1)
    wf.link("Loop files", "Summarize", 0)      # done: every result
    wf.link("Loop files", "Intake photo", 1)   # one file at a time
    wf.link("Intake photo", "Loop files", 0)
    wf.link("Intake photo", "Job failed", 1)
    wf.link("Summarize", "Delete raw uploads", 0)
    wf.link("Summarize", "Job failed", 1)
    wf.link("Delete raw uploads", "Extract input")
    wf.link("Extract input", "Extract listing")
    wf.link("Extract listing", "Extracted?", 0)
    wf.link("Extracted?", "Auto publish", 0)
    wf.link("Extracted?", "Finish input", 1)
    wf.link("Auto publish", "Embed now?")
    wf.link("Embed now?", "Embedding request", 0)
    wf.link("Embed now?", "Finish input", 1)
    wf.link("Embedding request", "Embed listing")
    wf.link("Embed listing", "Embedding rows")
    wf.link("Embedding rows", "Store vector?")
    wf.link("Store vector?", "Store vector", 0)
    wf.link("Store vector?", "Finish input", 1)
    wf.link("Store vector", "Finish input")
    wf.link("Extract listing", "Job failed", 1)
    wf.link("Finish input", "Finish job", 0)
    wf.link("Finish input", "Job failed", 1)
    wf.link("Job failed", "Finish failed job")
    return wf


def jobs_dispatch():
    """Scheduled every minute: the reaper (stuck jobs) and the retries that are due (spec 5.6)."""
    wf = WF("fsJobsDispatch01", "wf.jobs.dispatch", tags=["worker", "jobs"])
    wf.node("Every minute", "n8n-nodes-base.scheduleTrigger", 1.2, {"rule": {"interval": [{"field": "minutes", "minutesInterval": 1}]}}, [0, 0])
    pg_node(wf, "Reap", "select count(*) as reaped from app.jobs_reap()", None, [220, 0], on_error=None)
    pg_node(wf, "Due", "select id, type from app.jobs_due(5)", None, [440, 0], on_error=None)
    code_node(wf, "Dispatch", "jobs_dispatch.js", [660, 0])
    exec_wf(wf, "Start analyze", ANALYZE_WF, "wf.listing.analyze", wait=False, pos=[880, 0], each=True)
    wf.link("Every minute", "Reap")
    wf.link("Reap", "Due")
    wf.link("Due", "Dispatch")
    wf.link("Dispatch", "Start analyze")
    return wf

# ---------- Telegram channel (D-079) -------------------------------------------------
TG_CHANNEL_WF = "fsChannelTgram01"
TG_API_WF = "fsChannelTgApi01"
TG_CRED = {"telegramApi": {"id": "fsCredTelegram01", "name": "Telegram bot"}}
TG_HOOK = "5d0c7a1e-8a51-4c43-9d6e-6b1f3f0a0e01"     # internal: /webhook/telegram/update, not under /v1 (the proxy never maps it)
TG_CONTEXT_SQL = """with fresh as (
  insert into app.telegram_updates (bot, update_id) values ($3, $1) on conflict do nothing returning update_id),
trimmed as (delete from app.telegram_updates where received_at < now() - interval '2 days')
select exists (select 1 from fresh) as fresh, u.id as user_id, u.role, u.jurisdiction_code,
  coalesce((select jsonb_object_agg(c.purpose, c.granted) from (select distinct on (purpose) purpose, granted
              from app.consents where user_id = u.id order by purpose, granted_at desc, id desc) c), '{}'::jsonb) as consents,
  (select x.rid from (select e.request_id as rid, e.started_at as t from ai.executions e
                       where e.user_id = u.id and e.workflow = 'wf.orchestrator'
                      union all select j.id, j.created_at from app.jobs j where j.requested_by = u.id and j.type = 'listing_analyze') x
    order by x.t desc limit 1) as last_request_id,
  (select jsonb_object_agg(key, value) from app.settings where key like 'telegram.%') as cfg,
  (select value #>> '{}' from app.settings where key = 'services.api_url') as api_url
from (select 1) one left join app.users u on u.external_auth_id = $2 and u.deleted_at is null"""


def tg_node(wf, name, params, pos):
    return wf.node(name, "n8n-nodes-base.telegram", 1.2, params, pos, credentials=TG_CRED)


def tg_send(wf, name, pos, chat="={{ $json.chat_id }}", text="={{ $json.text }}"):
    return tg_node(wf, name, {"resource": "message", "operation": "sendMessage", "chatId": chat, "text": text,
                              "additionalFields": {"appendAttribution": False, "parse_mode": "HTML"}}, pos)


def tg_api():
    """Sub-workflow: one signed call to the public API as the 'telegram' client (D-079). The body is the JSON string that was
    signed; n8n parses and re-serialises it, which gives the same bytes for JSON.stringify output (checked by the contract
    tests: any difference fails the signature). Sent as "raw", the response came back as an unread stream (F-059).
    Input {method, path, user_id?, body?, idem?}; output {status, body, request_id, error_code}."""
    wf = WF(TG_API_WF, "wf.channel.telegram.api", tags=["channel", "telegram"], settings={"saveDataSuccessExecution": "all"})
    wf.node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1, {"inputSource": "passthrough"}, [0, 0])
    code_node(wf, "Prepare", "tg_api_prepare.js", [220, 0])
    pg_node(wf, "Sign", "with r as (select gen_random_uuid()::text as rid)"
            " select r.rid, sec.sign_internal('telegram', $1, $2, r.rid, nullif($3, ''), nullif($4, ''), $5) as s,"
            " (select value #>> '{}' from app.settings where key = 'services.api_url') as api_url from r",
            "={{ [ $json.method, $json.path, $json.user_id, $json.idem, $json.body_text ] }}", [440, 0], on_error=None)
    code_node(wf, "Request", "tg_api_request.js", [660, 0])
    if_node(wf, "With body?", "={{ $json.has_body }}", [880, 0])
    common = {"url": "={{ $json.url }}", "method": "={{ $json.method }}", "sendHeaders": True, "specifyHeaders": "json",
              "jsonHeaders": "={{ JSON.stringify($json.headers) }}",
              "options": {"timeout": 300000, "response": {"response": {"fullResponse": True, "neverError": True, "responseFormat": "json"}}}}
    wf.node("Call API with body", "n8n-nodes-base.httpRequest", 4.2,
            {**common, "sendBody": True, "contentType": "json", "specifyBody": "json", "jsonBody": "={{ $json.body_text }}"},
            [1100, -100], onError="continueRegularOutput")
    wf.node("Call API", "n8n-nodes-base.httpRequest", 4.2, common, [1100, 100], onError="continueRegularOutput")
    code_node(wf, "Result", "tg_api_result.js", [1320, 0])
    for a, b in (("Start", "Prepare"), ("Prepare", "Sign"), ("Sign", "Request"), ("Request", "With body?"),
                 ("Call API with body", "Result"), ("Call API", "Result")):
        wf.link(a, b)
    wf.link("With body?", "Call API with body", 0)
    wf.link("With body?", "Call API", 1)
    return wf


def tg_channel():
    """wf.channel.telegram (spec 8.4): one Telegram update handed over by the long-polling relay (D-079).
    Consent first; then commands, the assistant, listings with a photo, traces for admins."""
    wf = WF(TG_CHANNEL_WF, "wf.channel.telegram", tags=["channel", "telegram"], settings={"saveDataSuccessExecution": "all"})
    wf.node("Webhook", "n8n-nodes-base.webhook", 2.1, {"httpMethod": "POST", "path": "telegram/update", "authentication": "headerAuth",
            "responseMode": "onReceived", "options": {}}, [0, 0], webhookId=TG_HOOK, credentials=SVC_CRED)
    code_node(wf, "Parse update", "tg_parse.js", [220, 0])
    pg_node(wf, "Context", TG_CONTEXT_SQL, "={{ [ $json.update_id, $json.ext_id, $json.bot ] }}", [440, 0], on_error=None)
    code_node(wf, "Plan", "tg_plan.js", [660, 0])
    wf.node("Action", "n8n-nodes-base.switch", 3.2, {"mode": "expression", "numberOutputs": 8, "output": "={{ $json.route }}",
                                                   "options": {}}, [880, 0])
    tg_send(wf, "Send message", [3300, 0])
    # 1 consent request with two buttons
    tg_node(wf, "Ask for consent", {"resource": "message", "operation": "sendMessage", "chatId": "={{ $json.chat_id }}",
            "text": "={{ $json.text }}", "replyMarkup": "inlineKeyboard",
            "inlineKeyboard": {"rows": [{"row": {"buttons": [
                {"text": "={{ $json.accept_label }}", "additionalFields": {"callback_data": "consent:yes"}},
                {"text": "={{ $json.refuse_label }}", "additionalFields": {"callback_data": "consent:no"}}]}}]},
            "additionalFields": {"appendAttribution": False, "parse_mode": "HTML"}}, [1100, -700])
    # 2 consent given / 3 refused or withdrawn
    for r, y in ((2, -500), (3, -300)):
        tg_node(wf, f"Answer button {r}", {"resource": "callback", "operation": "answerQuery", "queryId": "={{ $json.callback_id }}",
                "additionalFields": {}}, [1100, y])
        wf.nodes[-1]["onError"] = "continueRegularOutput"     # /stop has no button to answer
    code_node(wf, "Call: sync user", "tg_call.js", [1320, -500], subst={"__CALL__": "sync user"})
    exec_wf(wf, "API: sync user", TG_API_WF, "wf.channel.telegram.api", pos=[1540, -500])
    code_node(wf, "Call: record consent", "tg_call.js", [1760, -500], subst={"__CALL__": "record consent"})
    exec_wf(wf, "API: record consent", TG_API_WF, "wf.channel.telegram.api", pos=[1980, -500])
    code_node(wf, "Done: consent", "tg_simple_done.js", [2200, -500], subst={"__NAME__": "Done: consent"})
    if_node(wf, "Has account?", "={{ !!$('Plan').first().json.user_id }}", [1320, -300])
    code_node(wf, "Call: withdraw consent", "tg_call.js", [1540, -350], subst={"__CALL__": "record consent"})
    exec_wf(wf, "API: withdraw consent", TG_API_WF, "wf.channel.telegram.api", pos=[1760, -350])
    code_node(wf, "Done: withdrawn", "tg_simple_done.js", [1980, -350], subst={"__NAME__": "Done: withdrawn"})
    code_node(wf, "No account", "tg_simple_done.js", [1540, -250], subst={"__NAME__": "No account"})
    # 4 country
    code_node(wf, "Call: set country", "tg_call.js", [1100, -150], subst={"__CALL__": "sync user"})
    exec_wf(wf, "API: set country", TG_API_WF, "wf.channel.telegram.api", pos=[1320, -150])
    code_node(wf, "Done: country", "tg_simple_done.js", [1540, -150], subst={"__NAME__": "Done: country"})
    # 5 assistant
    tg_node(wf, "Typing", {"resource": "message", "operation": "sendChatAction", "chatId": "={{ $json.chat_id }}", "action": "typing"}, [1100, 0])
    wf.nodes[-1]["onError"] = "continueRegularOutput"
    code_node(wf, "Call: ask assistant", "tg_call.js", [1320, 0], subst={"__CALL__": "ask assistant"})
    exec_wf(wf, "API: ask assistant", TG_API_WF, "wf.channel.telegram.api", pos=[1540, 0])
    code_node(wf, "Format answer", "tg_answer_format.js", [1760, 0])
    # 6 trace
    code_node(wf, "Call: trace", "tg_call.js", [1100, 150], subst={"__CALL__": "trace"})
    exec_wf(wf, "API: trace", TG_API_WF, "wf.channel.telegram.api", pos=[1320, 150])
    code_node(wf, "Format trace", "tg_trace_format.js", [1540, 150])
    # 7 listing: create, photo (download, presign, upload), analyze, wait for the job, read the listing
    tg_node(wf, "Typing (listing)", {"resource": "message", "operation": "sendChatAction", "chatId": "={{ $json.chat_id }}",
            "action": "typing"}, [1100, 400])
    wf.nodes[-1]["onError"] = "continueRegularOutput"
    code_node(wf, "Call: create listing", "tg_call.js", [1320, 400], subst={"__CALL__": "create listing"})
    exec_wf(wf, "API: create listing", TG_API_WF, "wf.channel.telegram.api", pos=[1540, 400])
    if_node(wf, "Created?", "={{ $json.status === 201 }}", [1760, 400])
    code_node(wf, "Listing error", "tg_error_reply.js", [1980, 650], subst={"__NAME__": "Listing error"})
    if_node(wf, "Photo?", "={{ !!$('Plan').first().json.photo_file_id }}", [1980, 400])
    tg_node(wf, "Download photo", {"resource": "file", "operation": "get", "fileId": "={{ $('Plan').first().json.photo_file_id }}",
            "download": True, "additionalFields": {}}, [2200, 300])
    code_node(wf, "Call: presign", "tg_call.js", [2420, 300], subst={"__CALL__": "presign"})
    exec_wf(wf, "API: presign", TG_API_WF, "wf.channel.telegram.api", pos=[2640, 300])
    code_node(wf, "Upload request", "tg_upload_request.js", [2860, 300])
    wf.node("Upload photo", "n8n-nodes-base.httpRequest", 4.2, {
        "method": "PUT", "url": "={{ $json.url }}", "sendHeaders": True, "specifyHeaders": "json",
        "jsonHeaders": "={{ JSON.stringify($json.headers) }}", "sendBody": True, "contentType": "binaryData", "inputDataFieldName": "data",
        "options": {"timeout": 120000, "response": {"response": {"fullResponse": True, "neverError": True, "responseFormat": "text",
                                                                  "outputPropertyName": "data"}}}}, [3080, 300])
    code_node(wf, "Call: analyze", "tg_call.js", [2200, 500], subst={"__CALL__": "analyze"})
    exec_wf(wf, "API: analyze", TG_API_WF, "wf.channel.telegram.api", pos=[2420, 500])
    if_node(wf, "Accepted?", "={{ $json.status === 202 }}", [2640, 500])
    wf.node("Wait notice", "n8n-nodes-base.code", 2, {"mode": "runOnceForAllItems", "language": "javaScript", "jsCode": code("tg_wait_notice.js")}, [2860, 500])
    tg_send(wf, "Send wait notice", [3080, 500])
    wf.node("Wait 10 s", "n8n-nodes-base.wait", 1.1, {"resume": "timeInterval", "amount": 10, "unit": "seconds"}, [3300, 500],
            webhookId="5d0c7a1e-8a51-4c43-9d6e-6b1f3f0a0e02")
    code_node(wf, "Call: job", "tg_call.js", [3520, 500], subst={"__CALL__": "job"})
    exec_wf(wf, "API: job", TG_API_WF, "wf.channel.telegram.api", pos=[3740, 500])
    code_node(wf, "Job state", "tg_job_state.js", [3960, 500])
    wf.node("Finished?", "n8n-nodes-base.switch", 3.2, {"mode": "expression", "numberOutputs": 3, "output": "={{ $json.state }}",
                                                      "options": {}}, [4180, 500])
    code_node(wf, "Call: get listing", "tg_call.js", [4400, 400], subst={"__CALL__": "get listing"})
    exec_wf(wf, "API: get listing", TG_API_WF, "wf.channel.telegram.api", pos=[4620, 400])
    code_node(wf, "Format listing", "tg_listing_format.js", [4840, 500])
    tg_send(wf, "Send listing", [5060, 500])

    for a, b in (("Webhook", "Parse update"), ("Parse update", "Context"), ("Context", "Plan"), ("Plan", "Action")):
        wf.link(a, b)
    wf.link("Action", "Send message", 0)
    wf.link("Action", "Ask for consent", 1)
    wf.link("Action", "Answer button 2", 2)
    wf.link("Action", "Answer button 3", 3)
    wf.link("Action", "Call: set country", 4)
    wf.link("Action", "Typing", 5)
    wf.link("Action", "Call: trace", 6)
    wf.link("Action", "Typing (listing)", 7)
    for a, b in (("Answer button 2", "Call: sync user"), ("Call: sync user", "API: sync user"), ("API: sync user", "Call: record consent"),
                 ("Call: record consent", "API: record consent"), ("API: record consent", "Done: consent"), ("Done: consent", "Send message"),
                 ("Answer button 3", "Has account?"), ("Call: withdraw consent", "API: withdraw consent"),
                 ("API: withdraw consent", "Done: withdrawn"), ("Done: withdrawn", "Send message"), ("No account", "Send message"),
                 ("Call: set country", "API: set country"), ("API: set country", "Done: country"), ("Done: country", "Send message"),
                 ("Typing", "Call: ask assistant"), ("Call: ask assistant", "API: ask assistant"), ("API: ask assistant", "Format answer"),
                 ("Format answer", "Send message"),
                 ("Call: trace", "API: trace"), ("API: trace", "Format trace"), ("Format trace", "Send message"),
                 ("Typing (listing)", "Call: create listing"), ("Call: create listing", "API: create listing"),
                 ("API: create listing", "Created?"), ("Listing error", "Send message"),
                 ("Download photo", "Call: presign"), ("Call: presign", "API: presign"), ("API: presign", "Upload request"),
                 ("Upload request", "Upload photo"), ("Upload photo", "Call: analyze"),
                 ("Call: analyze", "API: analyze"), ("API: analyze", "Accepted?"), ("Wait notice", "Send wait notice"),
                 ("Send wait notice", "Wait 10 s"), ("Wait 10 s", "Call: job"), ("Call: job", "API: job"), ("API: job", "Job state"),
                 ("Job state", "Finished?"), ("Call: get listing", "API: get listing"), ("API: get listing", "Format listing"),
                 ("Format listing", "Send listing")):
        wf.link(a, b)
    wf.link("Has account?", "Call: withdraw consent", 0)
    wf.link("Has account?", "No account", 1)
    wf.link("Created?", "Photo?", 0)
    wf.link("Created?", "Listing error", 1)
    wf.link("Photo?", "Download photo", 0)
    wf.link("Photo?", "Call: analyze", 1)
    wf.link("Accepted?", "Wait notice", 0)
    wf.link("Accepted?", "Listing error", 1)
    wf.link("Finished?", "Call: get listing", 0)
    wf.link("Finished?", "Wait 10 s", 1)
    wf.link("Finished?", "Format listing", 2)
    return wf



BUILDS = {
    "workflows": [gateway, health, users_sync, error_handler, admin_kb_ingest, kb_ingest, kb_ingest_source,
                  jobs_get, admin_eval_runs_create, eval_retrieval, admin_eval_runs_get,
                  llm_call, eval_prompts, profile_extract, match_search, match_tool_search, match_tool_listing, match_agent, api_search, api_profiles_extract, api_profiles_me,
                  orchestrator, admin_eval_prompt_runs_create, listings_embed, admin_listings_embed, fx_refresh, admin_fx_refresh,
                  api_listings_create, api_listings_get, api_listings_presign, api_listings_analyze, intake_photos,
                  listing_extract, listing_analyze, jobs_dispatch, api_me_consents, api_admin_traces_get, tg_api, tg_channel],
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
