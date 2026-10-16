"""Platform workflows (docs/PLATFORM_SPEC.md): endpoints of the website's features.

Imported by n8n/build.py. Every platform endpoint is its own n8n workflow with the same shape:

    Webhook -> Route -> Gateway (wf.gateway.auth) -> Validate (platform_validate.js, the endpoint's spec)
            -> Call: api.<function>(user, input) -> Build result -> Envelope -> Finish -> Respond

The function runs in PostgreSQL as app_rls, with the caller set first, so row-level security filters every row
(migration 0022, D-096). Workflows that do more than one call (notifications to other users, storage, jobs, agents)
are written out in full below their endpoint.
"""
import hashlib
import json
import uuid

import build as B

PLATFORM_NS = uuid.UUID("0b8f4f1e-6a77-4c2b-9a51-2f0b6c3d7e10")


def ids(name):
    """Stable workflow id (16 characters, like the hand-written ones) and webhook id for a platform workflow."""
    h = hashlib.sha1(name.encode()).hexdigest()
    return "fsPf" + h[:12], str(uuid.uuid5(PLATFORM_NS, "hook/" + name))


def rls_endpoint(name, method, path, fn, *, spec=None, consents=None, roles=(), idempotent=None, with_input=True):
    """A platform endpoint whose work is one api.<fn> call. path without leading slash, n8n style (:id)."""
    wid, hook = ids(name)
    wf = B.WF(wid, name, tags=["api", "v1", "platform"])
    B.webhook(wf, method, path, hook, [0, 0])
    route = {"method": method, "template": "/" + path, "require_user": True,
             "idempotent": method in ("POST", "PUT", "PATCH", "DELETE") if idempotent is None else idempotent,
             "required_consents": B.USER_CONSENTS if consents is None else consents, "roles": list(roles)}
    B.route_node(wf, route, [220, 0])
    B.gateway_call(wf, [440, 0])
    B.if_node(wf, "Gateway ok?", "={{ $json.ok }}", [660, 0])
    B.code_node(wf, "Validate", "platform_validate.js", [880, -100],
                subst={"__SPEC__": json.dumps(spec or {}, ensure_ascii=False)})
    B.if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    if with_input:
        sql = f"select api.{fn}($1::uuid, $2::jsonb) as r"
        repl = "={{ [ $json.gw.ctx.user_id, JSON.stringify($json.input) ] }}"
    else:
        sql = f"select api.{fn}($1::uuid) as r"
        repl = "={{ [ $json.gw.ctx.user_id ] }}"
    B.pg_node(wf, "Call", sql, repl, [1320, -200], always_output=True)
    B.code_node(wf, "Build result", "platform_result.js", [1540, -200])
    B.code_node(wf, "Database error", "platform_db_error.js", [1540, 0])
    B.respond_tail(wf, 1760)
    wf.link("Webhook", "Route")
    wf.link("Route", "Gateway")
    wf.link("Gateway", "Gateway ok?")
    wf.link("Gateway ok?", "Validate", 0)
    wf.link("Gateway ok?", "Envelope", 1)
    wf.link("Validate", "Valid?")
    wf.link("Valid?", "Call", 0)
    wf.link("Valid?", "Envelope", 1)
    wf.link("Call", "Build result", 0)
    wf.link("Call", "Database error", 1)
    wf.link("Build result", "Envelope")
    wf.link("Database error", "Envelope")
    return wf


# ---------- P1: accounts and notifications ------------------------------------------------------------------------
PAGE = {"limit": {"type": "int", "min": 1, "max": 50}}


def me_get():
    """GET /v1/me: who the caller is, consents, flags and counts. No consent needed (the website asks for it)."""
    return rls_endpoint("wf.api.me_get", "GET", "v1/me", "me", consents=[], with_input=False)


def profiles_get():
    """GET /v1/profiles/me: the saved search and lifestyle profile (PUT exists since phase 3)."""
    return rls_endpoint("wf.api.profiles_get", "GET", "v1/profiles/me", "profile_get", with_input=False)


def notifications_list():
    return rls_endpoint("wf.api.notifications_list", "GET", "v1/me/notifications", "notifications_list",
                        spec={"query": {**PAGE, "before": {"type": "int", "min": 1}, "unread_only": {"type": "bool"}}})


def notifications_read():
    return rls_endpoint("wf.api.notifications_read", "POST", "v1/me/notifications/read", "notifications_read",
                        spec={"body": {"type": "object", "additionalProperties": False, "properties": {
                            "ids": {"type": "array", "minItems": 1, "maxItems": 200, "items": {"type": "integer", "minimum": 1}},
                            "all": {"type": "boolean", "const": True}}},
                              "require_any": ["ids", "all"]})


WORKFLOWS = [me_get, profiles_get, notifications_list, notifications_read]
