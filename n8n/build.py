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
        return (SRC / m.group(1)).read_text(encoding="utf-8")

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
def code_node(wf, name, src, pos=None):
    return wf.node(name, "n8n-nodes-base.code", 2, {"mode": "runOnceForAllItems", "language": "javaScript", "jsCode": code(src)}, pos)


def pg_node(wf, name, query, replacement, pos=None, on_error="continueErrorOutput"):
    params = {"operation": "executeQuery", "query": query, "options": {}}
    if replacement:
        params["options"]["queryReplacement"] = replacement
    return wf.node(name, "n8n-nodes-base.postgres", 2.6, params, pos, credentials=PG_CRED, onError=on_error, alwaysOutputData=False)


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


BUILDS = {
    "workflows": [gateway, health, users_sync, error_handler],
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
