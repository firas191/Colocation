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


# ---------- P2: search, listing page, favourites, proposals ----------------------------------------------------------
def platform_head(name, method, path, *, consents=None, idempotent=None, tags=("api", "v1", "platform")):
    """Webhook, route, gateway and 'Gateway ok?' (false -> Envelope) of a platform endpoint written node by node."""
    wid, hook = ids(name)
    wf = B.WF(wid, name, tags=list(tags))
    B.webhook(wf, method, path, hook, [0, 0])
    route = {"method": method, "template": "/" + path, "require_user": True,
             "idempotent": method in ("POST", "PUT", "PATCH", "DELETE") if idempotent is None else idempotent,
             "required_consents": B.USER_CONSENTS if consents is None else consents, "roles": []}
    B.route_node(wf, route, [220, 0])
    B.gateway_call(wf, [440, 0])
    B.if_node(wf, "Gateway ok?", "={{ $json.ok }}", [660, 0])
    wf.link("Webhook", "Route")
    wf.link("Route", "Gateway")
    wf.link("Gateway", "Gateway ok?")
    wf.link("Gateway ok?", "Envelope", 1)
    return wf


def presign_node(wf, name, pos):
    """Signed GET URLs for processed photos from the Media service (POST /v1/storage/presign-get). Never fails the
    request: without an answer the result node leaves the photos out and warns photos_unavailable."""
    return B.http_node(wf, name, "POST", "={{ $json.url }}", pos, body="={{ JSON.stringify($json.body) }}", fmt="json",
                       full=True, never_error=True, timeout="={{ 10000 }}", svc=True, on_error="continueRegularOutput")


MEDIA_CFG = ("(select jsonb_object_agg(key, value #>> '{}') from app.settings"
             " where key in ('services.media_url', 'media.photo_url_ttl_s')) as cfg")


def search_v2():
    """GET /v2/search (PLATFORM_SPEC 3.2): the v1 search plus filters, map area, ids, pages and cover photos.
    GET /v1/search is not changed (D-095)."""
    wf = platform_head("wf.api.search_v2", "GET", "v2/search", tags=("api", "v2", "platform"))
    B.code_node(wf, "Validate query", "search2_validate.js", [880, -100])
    B.if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    B.pg_node(wf, "Profile",
              "select (select jsonb_build_object('jurisdiction_code', jurisdiction_code, 'budget_max_minor', budget_max_minor,"
              " 'currency', currency, 'budget_period', budget_period, 'radius_m', search_radius_m,"
              " 'lat', st_y(anchor_point::geometry), 'lng', st_x(anchor_point::geometry))"
              " from app.profiles where user_id = app.try_uuid($1) and $2::boolean) as profile,"
              " (select jsonb_object_agg(key, value #>> '{}') from app.settings where key in ('ollama.base_url',"
              " 'ollama.embed_model', 'llm.keep_alive', 'services.media_url', 'media.photo_url_ttl_s')) as cfg",
              "={{ [ $json.params[0], String($json.params[1]) ] }}", [1320, -200], on_error=None)
    B.code_node(wf, "Search input", "search2_input.js", [1540, -200])
    B.if_node(wf, "Has jurisdiction?", "={{ !$json.no_jurisdiction }}", [1760, -200])
    B.code_node(wf, "No jurisdiction", "search2_nojur.js", [1980, 0])
    B.if_node(wf, "Text query?", "={{ $json.embed }}", [1980, -300])
    B.http_node(wf, "Embed query", "POST", "={{ $json.url }}", [2200, -400], body="={{ JSON.stringify($json.body) }}",
                fmt="json", full=True, never_error=True, timeout="={{ 30000 }}", on_error="continueRegularOutput")
    B.code_node(wf, "Query vector", "search2_vector.js", [2420, -400])
    B.code_node(wf, "No text", "search2_novector.js", [2420, -200])
    B.code_node(wf, "Query input", "search2_query_input.js", [2640, -300])
    B.pg_node(wf, "Search", "select app.search_public_v2($1::jsonb) as r", "={{ $json.params }}", [2860, -300], on_error=None)
    B.code_node(wf, "Photo request", "search2_photos.js", [3080, -300])
    B.pg_node(wf, "Favourites", "select api.favourite_flags($1::uuid, $2::jsonb) as f",
              "={{ [ $('Validate query').first().json.gw.ctx.user_id, $json.ids ] }}", [3300, -300], on_error=None)
    wf.node("Signing input", "n8n-nodes-base.code", 2, {"mode": "runOnceForAllItems", "language": "javaScript",
            "jsCode": "// the request built by Photo request\nreturn [{ json: $('Photo request').first().json }];"}, [3520, -300])
    presign_node(wf, "Cover URLs", [3740, -300])
    B.code_node(wf, "Build result", "search2_result.js", [3960, -300])
    B.respond_tail(wf, 4180)
    for a, b in (("Validate query", "Valid?"), ("Profile", "Search input"), ("Search input", "Has jurisdiction?"),
                 ("Embed query", "Query vector"), ("Query vector", "Query input"), ("No text", "Query input"),
                 ("Query input", "Search"), ("Search", "Photo request"), ("Photo request", "Favourites"),
                 ("Favourites", "Signing input"), ("Signing input", "Cover URLs"), ("Cover URLs", "Build result"),
                 ("Build result", "Envelope"), ("No jurisdiction", "Envelope")):
        wf.link(a, b)
    wf.link("Gateway ok?", "Validate query", 0)
    wf.link("Valid?", "Profile", 0)
    wf.link("Valid?", "Envelope", 1)
    wf.link("Has jurisdiction?", "Text query?", 0)
    wf.link("Has jurisdiction?", "No jurisdiction", 1)
    wf.link("Text query?", "Embed query", 0)
    wf.link("Text query?", "No text", 1)
    return wf


def listings_public():
    """GET /v1/listings/{id}/public: a published listing (or the caller's own, any state) with signed photo URLs.
    GET /v1/listings/{id} stays the owner view (D-095)."""
    wf = platform_head("wf.api.listings_public", "GET", "v1/listings/:id/public")
    B.code_node(wf, "Validate", "platform_validate.js", [880, -100], subst={"__SPEC__": json.dumps({"params": {"id": "uuid"}})})
    B.if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    B.pg_node(wf, "Load", "select app.listing_public_view($1::uuid, $2::uuid) as v,"
              " api.favourite_flags($2::uuid, jsonb_build_array($1::text)) as f, " + MEDIA_CFG,
              "={{ [ $json.input.params.id, $json.gw.ctx.user_id ] }}", [1320, -200], on_error=None)
    B.code_node(wf, "Photo request", "listing_public_plan.js", [1540, -200])
    B.if_node(wf, "Found?", "={{ $json.found }}", [1760, -200])
    presign_node(wf, "Photo URLs", [1980, -300])
    B.code_node(wf, "Build result", "listing_public_result.js", [2200, -300])
    B.code_node(wf, "Not found", "listing_public_missing.js", [1980, -100])
    B.respond_tail(wf, 2420)
    wf.link("Gateway ok?", "Validate", 0)
    wf.link("Validate", "Valid?")
    wf.link("Valid?", "Load", 0)
    wf.link("Valid?", "Envelope", 1)
    wf.link("Load", "Photo request")
    wf.link("Photo request", "Found?")
    wf.link("Found?", "Photo URLs", 0)
    wf.link("Found?", "Not found", 1)
    wf.link("Photo URLs", "Build result")
    wf.link("Build result", "Envelope")
    wf.link("Not found", "Envelope")
    return wf


FAV_PARAMS = {"params": {"listing_id": "uuid"}}
EMPTY_BODY = {"type": "object", "additionalProperties": False, "properties": {}}   # PUT and POST carry a JSON object (gateway)


def favourite_put():
    """PUT /v1/me/favourites/{listing_id}: save a published listing (idempotent)."""
    return rls_endpoint("wf.api.favourite_put", "PUT", "v1/me/favourites/:listing_id", "favourite_put",
                        spec={**FAV_PARAMS, "body": EMPTY_BODY})


def favourite_delete():
    """DELETE /v1/me/favourites/{listing_id}: remove it (idempotent; also for a listing no longer published)."""
    return rls_endpoint("wf.api.favourite_delete", "DELETE", "v1/me/favourites/:listing_id", "favourite_delete", spec=FAV_PARAMS)


def favourites_list():
    """GET /v1/me/favourites: the caller's favourites (row-level layer), then their public cards and cover photos."""
    wf = platform_head("wf.api.favourites_list", "GET", "v1/me/favourites")
    B.code_node(wf, "Validate", "platform_validate.js", [880, -100],
                subst={"__SPEC__": json.dumps({"query": {**PAGE, "before": {"type": "int", "min": 1}}})})
    B.if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    B.pg_node(wf, "Call", "select api.favourites_list($1::uuid, $2::jsonb) as r",
              "={{ [ $json.gw.ctx.user_id, JSON.stringify($json.input) ] }}", [1320, -200], on_error=None)
    B.code_node(wf, "Cards input", "favourites_plan.js", [1540, -200])
    B.pg_node(wf, "Cards", "select app.public_cards($1::jsonb) as cards, app.listing_photo_summary($2::uuid[], 1) as covers, "
              + MEDIA_CFG, "={{ $json.ok ? $json.params : ['[]', '{}'] }}", [1760, -200], on_error=None)
    B.code_node(wf, "Photo request", "favourites_photos.js", [1980, -200])
    presign_node(wf, "Cover URLs", [2200, -200])
    B.code_node(wf, "Build result", "favourites_result.js", [2420, -200])
    B.respond_tail(wf, 2640)
    wf.link("Gateway ok?", "Validate", 0)
    wf.link("Validate", "Valid?")
    wf.link("Valid?", "Call", 0)
    wf.link("Valid?", "Envelope", 1)
    for a, b in (("Call", "Cards input"), ("Cards input", "Cards"), ("Cards", "Photo request"), ("Photo request", "Cover URLs"),
                 ("Cover URLs", "Build result"), ("Build result", "Envelope")):
        wf.link(a, b)
    return wf


def listing_change_cancel():
    """POST /v1/listing-changes/{id}/cancel: the website's Cancel button under an owner-assistant proposal (the
    Telegram button keeps its own path). Confirm stays PATCH /v1/listings/{id} with change_id."""
    wf = platform_head("wf.api.listing_change_cancel", "POST", "v1/listing-changes/:id/cancel")
    B.code_node(wf, "Validate", "platform_validate.js", [880, -100], subst={"__SPEC__": json.dumps(
        {"params": {"id": "uuid"}, "body": EMPTY_BODY})})
    B.if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    B.pg_node(wf, "Cancel", "select app.listing_change_cancel_request($1::uuid, $2::uuid) as r",
              "={{ [ $json.gw.ctx.user_id, $json.input.params.id ] }}", [1320, -200], on_error=None)
    B.code_node(wf, "Build result", "change_cancel_result.js", [1540, -200])
    B.respond_tail(wf, 1760)
    wf.link("Gateway ok?", "Validate", 0)
    wf.link("Validate", "Valid?")
    wf.link("Valid?", "Cancel", 0)
    wf.link("Valid?", "Envelope", 1)
    wf.link("Cancel", "Build result")
    wf.link("Build result", "Envelope")
    return wf


WORKFLOWS = [me_get, profiles_get, notifications_list, notifications_read,
             search_v2, listings_public, favourite_put, favourite_delete, favourites_list, listing_change_cancel]
