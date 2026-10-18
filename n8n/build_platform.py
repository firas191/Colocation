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


def trust_phrases():
    """The phrase lists of every pack (kb/packs/<code>/scam_phrases.csv) as JSON for the Code nodes (D-107)."""
    import csv
    root = B.ROOT.parent / "kb" / "packs"
    rows = []
    for d in sorted(root.iterdir()):
        f = d / "scam_phrases.csv"
        if f.is_file():
            with f.open(encoding="utf-8", newline="") as fh:
                rows += [{"pack": d.name, "signal": r["signal"], "lang": r["lang"], "pattern": r["pattern"]} for r in csv.DictReader(fh)]
    return json.dumps(rows, ensure_ascii=False)


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
    qual = fn if "." in fn else f"api.{fn}"
    if with_input:
        sql = f"select {qual}($1::uuid, $2::jsonb) as r"
        repl = "={{ [ $json.gw.ctx.user_id, JSON.stringify($json.input) ] }}"
    else:
        sql = f"select {qual}($1::uuid) as r"
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


# ---------- P3: owners ------------------------------------------------------------------------------------------------
def listings_submit():
    """POST /v1/listings/{id}/submit (PLATFORM_SPEC 3.5): the owner asks to publish a draft. app.listing_submit checks
    what is missing (rent, place on the map, a photo), refuses while an analysis runs, then publishes; the listing is
    embedded at once so a search by meaning finds it. From P8 the trust check (wf.trust.assess) runs first and its
    report decides: published, in review (moderation queue) or rejected (D-107)."""
    wf = platform_head("wf.api.listings_submit", "POST", "v1/listings/:id/submit")
    B.code_node(wf, "Validate", "platform_validate.js", [880, -100], subst={"__SPEC__": json.dumps(
        {"params": {"id": "uuid"}, "body": EMPTY_BODY})})
    B.if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    B.pg_node(wf, "Submit", "select app.listing_submit($1::uuid, $2::uuid) as r",
              "={{ [ $json.gw.ctx.user_id, $json.input.params.id ] }}", [1320, -200], on_error=None)
    # P8 (D-107): the checks passed and the trust check is on (status 100) -> wf.trust.assess, then the same call with
    # the stored report decides: published, in review or rejected
    B.if_node(wf, "Trust check needed?", "={{ $json.r && $json.r.status === 100 }}", [1430, -350])
    wf.node("Trust input", "n8n-nodes-base.code", 2, {"mode": "runOnceForAllItems", "language": "javaScript",
            "jsCode": "// the listing to check and the request it belongs to\nconst v = $('Validate').first().json;\n"
                      "return [{ json: { listing_id: v.input.params.id, request_id: v.gw.ctx.request_id || null } }];"}, [1540, -500])
    B.exec_wf(wf, "Trust check", TRUST_WF, "wf.trust.assess", pos=[1760, -500], on_error="continueRegularOutput")
    B.code_node(wf, "Trust report", "submit_trust_input.js", [1980, -500])
    B.pg_node(wf, "Apply check", "select app.listing_submit($1::uuid, $2::uuid, $3::jsonb) as r", "={{ $json.params }}",
              [2200, -500], on_error=None)
    B.code_node(wf, "Next steps", "submit_plan.js", [1540, -200])
    B.if_node(wf, "Embed?", "={{ $json.embed }}", [1760, -200])
    B.http_node(wf, "Embed listing", "POST", "={{ $json.embed_url }}", [1980, -300], body="={{ JSON.stringify($json.embed_body) }}",
                fmt="json", full=True, never_error=True, timeout="={{ 60000 }}", on_error="continueRegularOutput")
    B.code_node(wf, "Embedding rows", "submit_embed.js", [2200, -300])
    B.if_node(wf, "Store vector?", "={{ !$json.skip }}", [2420, -300])
    B.pg_node(wf, "Store vector", "select app.store_listing_embeddings($1, $2::jsonb) as stored", "={{ $json.params }}",
              [2640, -350], on_error="continueRegularOutput")
    B.code_node(wf, "Build result", "submit_result.js", [2860, -200])
    B.respond_tail(wf, 3080)
    wf.link("Gateway ok?", "Validate", 0)
    wf.link("Validate", "Valid?")
    wf.link("Valid?", "Submit", 0)
    wf.link("Valid?", "Envelope", 1)
    wf.link("Submit", "Trust check needed?")
    wf.link("Trust check needed?", "Trust input", 0)
    wf.link("Trust check needed?", "Next steps", 1)
    for a, b in (("Trust input", "Trust check"), ("Trust check", "Trust report"), ("Trust report", "Apply check"),
                 ("Apply check", "Next steps")):
        wf.link(a, b)
    for a, b in (("Next steps", "Embed?"), ("Embed listing", "Embedding rows"),
                 ("Embedding rows", "Store vector?"), ("Store vector", "Build result"), ("Build result", "Envelope")):
        wf.link(a, b)
    wf.link("Embed?", "Embed listing", 0)
    wf.link("Embed?", "Build result", 1)
    wf.link("Store vector?", "Store vector", 0)
    wf.link("Store vector?", "Build result", 1)
    return wf


LISTING_TRUST_WF = ids("wf.listing.trust")[0]


def listings_submit_v2():
    """POST /v2/listings/{id}/submit (platform P12, D-112): the v1 checks; when the trust check is needed it becomes a
    listing_trust job (app.listing_submit_job, one per listing at a time) run by wf.listing.trust, and the answer is
    202 with the job to poll. trust.enabled off or already published: the v1 200 answer, embedded as in v1."""
    wf = platform_head("wf.api.listings_submit_v2", "POST", "v2/listings/:id/submit", tags=("api", "v2", "platform"))
    B.code_node(wf, "Validate", "platform_validate.js", [880, -100], subst={"__SPEC__": json.dumps(
        {"params": {"id": "uuid"}, "body": EMPTY_BODY})})
    B.if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    B.pg_node(wf, "Submit", "select app.listing_submit_job($1::uuid, $2::uuid, app.try_uuid($3)) as r",
              "={{ [ $json.gw.ctx.user_id, $json.input.params.id, $json.gw.ctx.request_id || '' ] }}", [1320, -200], on_error=None)
    B.if_node(wf, "New job?", "={{ !!($json.r && $json.r.status === 202 && $json.r.created) }}", [1540, -350])
    wf.node("Job id", "n8n-nodes-base.code", 2, {"mode": "runOnceForAllItems", "language": "javaScript",
            "jsCode": "// the job the worker claims\nreturn [{ json: { id: $('Submit').first().json.r.job_id } }];"}, [1760, -450])
    B.exec_wf(wf, "Start check", LISTING_TRUST_WF, "wf.listing.trust", wait=False, pos=[1980, -450])
    B.code_node(wf, "Next steps", "submit_v2_plan.js", [2200, -200])
    B.if_node(wf, "Embed?", "={{ $json.embed }}", [2420, -200])
    B.http_node(wf, "Embed listing", "POST", "={{ $json.embed_url }}", [2640, -300], body="={{ JSON.stringify($json.embed_body) }}",
                fmt="json", full=True, never_error=True, timeout="={{ 60000 }}", on_error="continueRegularOutput")
    B.code_node(wf, "Embedding rows", "submit_embed.js", [2860, -300])
    B.if_node(wf, "Store vector?", "={{ !$json.skip }}", [3080, -300])
    B.pg_node(wf, "Store vector", "select app.store_listing_embeddings($1, $2::jsonb) as stored", "={{ $json.params }}",
              [3300, -350], on_error="continueRegularOutput")
    B.code_node(wf, "Build result", "submit_v2_result.js", [3520, -200])
    B.respond_tail(wf, 3740)
    for a, b in (("Gateway ok?", "Validate"), ("Valid?", "Submit"), ("Job id", "Start check"), ("Start check", "Next steps"),
                 ("Next steps", "Embed?"), ("Embed?", "Embed listing"), ("Embed listing", "Embedding rows"),
                 ("Embedding rows", "Store vector?"), ("Store vector?", "Store vector"), ("Store vector", "Build result"),
                 ("Build result", "Envelope")):
        wf.link(a, b, 0) if a in ("Gateway ok?", "Valid?", "Embed?", "Store vector?") else wf.link(a, b)
    wf.link("Validate", "Valid?")
    wf.link("Valid?", "Envelope", 1)
    wf.link("Submit", "New job?")
    wf.link("New job?", "Job id", 0)
    wf.link("New job?", "Next steps", 1)
    wf.link("Embed?", "Build result", 1)
    wf.link("Store vector?", "Build result", 1)
    return wf


def listing_trust_job():
    """Worker of the listing_trust job (platform P12, D-112), started by POST /v2/listings/{id}/submit and, for a
    retry, by wf.jobs.dispatch: app.job_start, wf.trust.assess, app.listing_submit with the report (published, in
    review or rejected, as in v1), the embedding of a published listing, app.job_finish with the outcome, and the
    Trust agent's steps under the job id (app.record_job_steps)."""
    wf = B.WF(LISTING_TRUST_WF, "wf.listing.trust", tags=["worker", "platform"], settings={"saveDataSuccessExecution": "none"})
    wf.node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1, {"inputSource": "passthrough"}, [0, 0])
    B.pg_node(wf, "Start job", "with j as (select * from app.job_start($1::uuid)) select j.id as job_id, j.input, j.attempts,"
              " j.max_attempts from j", "={{ [ $json.id ] }}", [220, 0], on_error=None, always_output=True)
    B.code_node(wf, "Plan", "trust_job_plan.js", [440, 0])
    B.if_node(wf, "Claimed?", "={{ !$json.none }}", [660, 0])
    wf.node("Trust input", "n8n-nodes-base.code", 2, {"mode": "runOnceForAllItems", "language": "javaScript",
            "jsCode": "// the listing to check; the job id is the request id of the trace\nconst p = $('Plan').first().json;\n"
                      "return [{ json: { listing_id: p.listing_id, request_id: p.job_id } }];"}, [880, -100])
    B.exec_wf(wf, "Trust check", TRUST_WF, "wf.trust.assess", pos=[1100, -100], on_error="continueRegularOutput")
    B.code_node(wf, "Report", "trust_job_apply.js", [1320, -100])
    B.pg_node(wf, "Apply check", "select app.listing_submit($1::uuid, $2::uuid, $3::jsonb) as r", "={{ $json.params }}",
              [1540, -100], on_error=None)
    B.code_node(wf, "Next steps", "trust_job_next.js", [1760, -100])
    B.if_node(wf, "Embed?", "={{ $json.embed }}", [1980, -100])
    B.http_node(wf, "Embed listing", "POST", "={{ $json.embed_url }}", [2200, -200], body="={{ JSON.stringify($json.embed_body) }}",
                fmt="json", full=True, never_error=True, timeout="={{ 60000 }}", on_error="continueRegularOutput")
    B.code_node(wf, "Embedding rows", "trust_job_embed.js", [2420, -200])
    B.if_node(wf, "Store vector?", "={{ !$json.skip }}", [2640, -200])
    B.pg_node(wf, "Store vector", "select app.store_listing_embeddings($1, $2::jsonb) as stored", "={{ $json.params }}",
              [2860, -250], on_error="continueRegularOutput")
    B.code_node(wf, "Finish input", "trust_job_finish.js", [3080, -100])
    B.pg_node(wf, "Finish job", "with f as (select * from app.job_finish($1::uuid, $2, $3::jsonb, $4, $5::boolean))"
              " select f.id, f.status, f.attempts, app.record_job_steps($1::uuid, $6, $7, $8::jsonb) as execution_id from f",
              "={{ $json.params }}", [3300, -100], on_error=None, retries=2)
    for a, b in (("Start", "Start job"), ("Start job", "Plan"), ("Plan", "Claimed?"), ("Trust input", "Trust check"),
                 ("Trust check", "Report"), ("Report", "Apply check"), ("Apply check", "Next steps"), ("Next steps", "Embed?"),
                 ("Embed listing", "Embedding rows"), ("Embedding rows", "Store vector?"), ("Store vector", "Finish input"),
                 ("Finish input", "Finish job")):
        wf.link(a, b)
    wf.link("Claimed?", "Trust input", 0)
    wf.link("Embed?", "Embed listing", 0)
    wf.link("Embed?", "Finish input", 1)
    wf.link("Store vector?", "Store vector", 0)
    wf.link("Store vector?", "Finish input", 1)
    return wf


LISTING_STATUSES = ["draft", "processing", "pending_review", "published", "rejected", "archived"]


def me_listings():
    """GET /v1/me/listings: the owner's listings (newest first) with what each still needs, the actions that apply and
    a signed cover photo URL. app.owner_listings stays the owner assistant's numbered view; the numbers here match it."""
    wf = platform_head("wf.api.me_listings", "GET", "v1/me/listings")
    B.code_node(wf, "Validate", "platform_validate.js", [880, -100], subst={"__SPEC__": json.dumps({"query": {
        **PAGE, "cursor": {"type": "string", "max": 60, "pattern": "^[0-9]{1,20}_[0-9a-f-]{36}$"},
        "status": {"type": "enum", "values": LISTING_STATUSES}, "listing_id": {"type": "uuid"}}})})
    B.if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    B.pg_node(wf, "Call", "select app.me_listings($1::uuid, $2::jsonb) as r, " + MEDIA_CFG,
              "={{ [ $json.gw.ctx.user_id, JSON.stringify($json.input) ] }}", [1320, -200], on_error=None)
    B.code_node(wf, "Photo request", "me_listings_photos.js", [1540, -200])
    presign_node(wf, "Cover URLs", [1760, -200])
    B.code_node(wf, "Build result", "me_listings_result.js", [1980, -200])
    B.respond_tail(wf, 2200)
    wf.link("Gateway ok?", "Validate", 0)
    wf.link("Validate", "Valid?")
    wf.link("Valid?", "Call", 0)
    wf.link("Valid?", "Envelope", 1)
    for a, b in (("Call", "Photo request"), ("Photo request", "Cover URLs"), ("Cover URLs", "Build result"),
                 ("Build result", "Envelope")):
        wf.link(a, b)
    return wf


# ---------- P4: messages, blocks, visits, applications, reports (all through the row-level layer, D-103) -------------
UUID_RE = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
DATE_RE = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
TIME_RE = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$"
UUID_S = {"type": "string", "pattern": UUID_RE}
TEXT = {"type": "string", "minLength": 1, "maxLength": 4000}
CURSOR = {"type": "string", "max": 60, "pattern": "^[0-9]{1,20}_[0-9a-f-]{36}$"}


def body(props, required=()):
    return {"type": "object", "additionalProperties": False, "properties": props, "required": list(required)}


def p4_endpoints():
    I = {"params": {"id": "uuid"}}
    return [
        ("wf.api.conversation_start", "POST", "v1/conversations", "conversation_start",
         {"body": body({"listing_id": UUID_S, "text": TEXT}, ("listing_id", "text"))}),
        ("wf.api.conversations_list", "GET", "v1/conversations", "conversations_list", {"query": {**PAGE, "cursor": CURSOR}}),
        ("wf.api.messages_list", "GET", "v1/conversations/:id/messages", "messages_list",
         {**I, "query": {**PAGE, "before": {"type": "int", "min": 1}}}),
        ("wf.api.conversation_read", "POST", "v1/conversations/:id/read", "conversation_read", {**I, "body": EMPTY_BODY}),
        ("wf.api.block_put", "POST", "v1/me/blocks", "block_put", {"body": body({"user_id": UUID_S}, ("user_id",))}),
        ("wf.api.block_delete", "DELETE", "v1/me/blocks/:user_id", "block_delete", {"params": {"user_id": "uuid"}}),
        ("wf.api.blocks_list", "GET", "v1/me/blocks", "blocks_list", {}),
        ("wf.api.visit_slots_get", "GET", "v1/listings/:id/visit-slots", "visit_slots_get", I),
        ("wf.api.visit_slots_put", "PUT", "v1/listings/:id/visit-slots", "visit_slots_put", {**I, "body": body({"slots": {
            "type": "array", "maxItems": 30, "items": body({"starts_at": {"type": "string", "pattern": TIME_RE},
                                                            "ends_at": {"type": "string", "pattern": TIME_RE},
                                                            "capacity": {"type": "integer", "minimum": 1, "maximum": 20}},
                                                           ("starts_at", "ends_at"))}}, ("slots",))}),
        ("wf.api.visit_request", "POST", "v1/visits", "visit_request",
         {"body": body({"slot_id": UUID_S, "note": {"type": "string", "maxLength": 500}}, ("slot_id",))}),
        ("wf.api.visits_list", "GET", "v1/me/visits", "visits_list",
         {"query": {**PAGE, "role": {"type": "enum", "values": ["owner", "seeker"]}, "upcoming": {"type": "bool"}}}),
        ("wf.api.visit_decide", "POST", "v1/visits/:id/decision", "visit_decide", {**I, "body": body({
            "action": {"type": "string", "enum": ["confirm", "propose", "decline", "cancel", "done", "no_show"]},
            "starts_at": {"type": "string", "pattern": TIME_RE}}, ("action",))}),
        ("wf.api.application_create", "POST", "v1/listings/:id/applications", "application_create", {**I, "body": body({
            "message": {"type": "string", "maxLength": 2000}, "move_in_from": {"type": "string", "pattern": DATE_RE},
            "share_profile": {"type": "boolean"}})}),
        ("wf.api.applications_mine", "GET", "v1/me/applications", "applications_mine",
         {"query": {**PAGE, "status": {"type": "enum", "values": ["submitted", "accepted", "declined", "withdrawn", "expired"]}}}),
        ("wf.api.applications_owner", "GET", "v1/owner/applications", "applications_owner",
         {"query": {**PAGE, "status": {"type": "enum", "values": ["submitted", "accepted", "declined", "withdrawn", "expired"]},
                    "listing_id": {"type": "uuid"}}}),
        ("wf.api.application_decide", "POST", "v1/applications/:id/decision", "application_decide", {**I, "body": body({
            "action": {"type": "string", "enum": ["accept", "decline"]},
            "code": {"type": "string", "enum": ["room_taken", "not_a_match", "dates", "other"]}}, ("action",))}),
        ("wf.api.application_withdraw", "POST", "v1/applications/:id/withdraw", "application_withdraw", {**I, "body": EMPTY_BODY}),
        ("wf.api.report_create", "POST", "v1/reports", "report_create", {"body": body({
            "target_type": {"type": "string", "enum": ["listing", "user", "message"]},
            "target_id": {"type": "string", "pattern": "^([0-9a-fA-F-]{36}|[0-9]{1,18})$"},
            "reason": {"type": "string", "enum": ["scam", "wrong_info", "offensive", "discrimination", "spam", "other"]},
            "detail": {"type": "string", "maxLength": 1000}}, ("target_type", "target_id", "reason"))}),
    ]


def _p4(spec):
    name, method, path, fn, rules = spec
    return lambda: rls_endpoint(name, method, path, fn, spec=rules)


def message_send():
    """POST /v1/conversations/{id}/messages {text}: as in P4, plus the phrase rules of the packs over the text (P8,
    D-107): the codes found are stored with the message and shown to the receiver as a warning (rule 2.7: no model)."""
    wf = platform_head("wf.api.message_send", "POST", "v1/conversations/:id/messages")
    B.code_node(wf, "Validate", "platform_validate.js", [880, -100], subst={"__SPEC__": json.dumps(
        {"params": {"id": "uuid"}, "body": body({"text": TEXT}, ("text",))})})
    B.if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    B.code_node(wf, "Scan", "message_scan.js", [1320, -200], subst={"__TRUST_PHRASES__": trust_phrases()})
    B.pg_node(wf, "Call", "select api.message_send($1::uuid, $2::jsonb) as r",
              "={{ [ $json.gw.ctx.user_id, JSON.stringify($json.input) ] }}", [1540, -200], always_output=True)
    B.code_node(wf, "Build result", "platform_result.js", [1760, -200])
    B.code_node(wf, "Database error", "platform_db_error.js", [1760, 0])
    B.respond_tail(wf, 1980)
    wf.link("Gateway ok?", "Validate", 0)
    wf.link("Validate", "Valid?")
    wf.link("Valid?", "Scan", 0)
    wf.link("Valid?", "Envelope", 1)
    wf.link("Scan", "Call")
    wf.link("Call", "Build result", 0)
    wf.link("Call", "Database error", 1)
    wf.link("Build result", "Envelope")
    wf.link("Database error", "Envelope")
    return wf


P4 = [_p4(x) for x in p4_endpoints()] + [message_send]


# ---------- P5: households, money, rent and bills, announcements (row-level layer, D-104) ------------------------------
MINOR = {"type": "integer", "minimum": 1, "maximum": 1000000000000}
HID = {"params": {"id": "uuid"}}


def p5_endpoints():
    exp_body = body({"amount_minor": MINOR, "label": {"type": "string", "minLength": 1, "maxLength": 120},
                     "category": {"type": "string", "enum": ["rent", "utilities", "internet", "groceries", "household", "other"]},
                     "spent_on": {"type": "string", "pattern": DATE_RE}, "paid_by": UUID_S,
                     "split_mode": {"type": "string", "enum": ["equal", "shares", "exact"]},
                     "participants": {"type": "array", "minItems": 1, "maxItems": 12, "items": UUID_S},
                     "values": {"type": "array", "minItems": 1, "maxItems": 12, "items": {"type": "integer", "minimum": 0, "maximum": 1000000000000}},
                     "preview": {"type": "boolean"}}, ("amount_minor", "label"))
    item = body({"kind": {"type": "string", "enum": ["rent", "bill"]}, "label": {"type": "string", "minLength": 1, "maxLength": 80},
                 "amount_minor": MINOR, "due_day": {"type": "integer", "minimum": 1, "maximum": 28},
                 "remind_days_before": {"type": "integer", "minimum": 0, "maximum": 14}}, ("kind", "label", "due_day"))
    return [
        ("wf.api.household_create", "POST", "v1/households", "household_create", {"body": body({
            "name": {"type": "string", "minLength": 1, "maxLength": 80}, "jurisdiction_code": {"type": "string", "pattern": "^[A-Za-z]{2}$"},
            "listing_id": UUID_S, "address_text": {"type": "string", "maxLength": 300},
            "role": {"type": "string", "enum": ["flatmate", "owner"]}}, ("name", "jurisdiction_code"))}),
        ("wf.api.households_mine", "GET", "v1/me/households", "households_mine", {}),
        ("wf.api.household_get", "GET", "v1/households/:id", "household_get", HID),
        ("wf.api.household_invite", "POST", "v1/households/:id/invites", "household_invite",
         {**HID, "body": body({"role": {"type": "string", "enum": ["flatmate", "owner"]}})}),
        ("wf.api.household_invite_accept", "POST", "v1/household-invites/accept", "household_invite_accept", {"body": body({
            "code": {"type": "string", "pattern": "^[0-9A-Za-z]{4}-?[0-9A-Za-z]{4}-?[0-9A-Za-z]{4}$"}, "invite_id": UUID_S}),
            "require_any": ["code", "invite_id"]}),
        ("wf.api.household_leave", "POST", "v1/households/:id/leave", "household_leave", {**HID, "body": body({
            "acknowledge_balance": {"type": "boolean"}})}),
        ("wf.api.expenses_list", "GET", "v1/households/:id/expenses", "expenses_list", {**HID, "query": PAGE}),
        ("wf.api.expense_create", "POST", "v1/households/:id/expenses", "expense_create", {**HID, "body": exp_body}),
        ("wf.api.expense_delete", "DELETE", "v1/households/:id/expenses/:expense_id", "expense_delete",
         {"params": {"id": "uuid", "expense_id": "uuid"}}),
        ("wf.api.balances_get", "GET", "v1/households/:id/balances", "balances_get", HID),
        ("wf.api.settlement_create", "POST", "v1/households/:id/settlements", "settlement_create", {**HID, "body": body({
            "to_user": UUID_S, "from_user": UUID_S, "amount_minor": MINOR, "settled_on": {"type": "string", "pattern": DATE_RE}},
            ("to_user", "amount_minor"))}),
        ("wf.api.recurring_get", "GET", "v1/households/:id/recurring", "recurring_get", HID),
        ("wf.api.recurring_put", "PUT", "v1/households/:id/recurring", "recurring_put",
         {**HID, "body": body({"items": {"type": "array", "maxItems": 20, "items": item}}, ("items",))}),
        ("wf.api.rent_payment_create", "POST", "v1/households/:id/rent-payments", "rent_payment_create", {**HID, "body": body({
            "period": {"type": "string", "pattern": "^[0-9]{4}-(0[1-9]|1[0-2])$"}, "amount_minor": MINOR,
            "paid_on": {"type": "string", "pattern": DATE_RE}}, ("period", "amount_minor"))}),
        ("wf.api.rent_payments_list", "GET", "v1/households/:id/rent-payments", "rent_payments_list", HID),
        ("wf.api.rent_payment_confirm", "POST", "v1/rent-payments/:id/confirm", "rent_payment_confirm", {**HID, "body": EMPTY_BODY}),
        ("wf.api.announcements_list", "GET", "v1/households/:id/announcements", "announcements_list", HID),
        ("wf.api.announcement_create", "POST", "v1/households/:id/announcements", "announcement_create", {**HID, "body": body({
            "body": {"type": "string", "minLength": 1, "maxLength": 2000}, "pinned": {"type": "boolean"}}, ("body",))}),
    ]


def household_daily():
    """Every day at 05:00 UTC: rent and bill reminders in each household's own date (PLATFORM_SPEC 3.6), from a
    function that acts for nobody and returns only counts (7.1). Chore assignments join it in P6."""
    wf = B.WF("fsHouseholdDly1", "wf.household.daily", tags=["schedule", "platform"])
    wf.node("Every day", "n8n-nodes-base.scheduleTrigger", 1.2,
            {"rule": {"interval": [{"field": "cronExpression", "expression": "0 5 * * *"}]}}, [0, 0])
    B.pg_node(wf, "Reminders", "select home.daily_reminders(null) as r", None, [220, 0], on_error=None, retries=2)
    wf.link("Every day", "Reminders")
    return wf


P5 = [_p4(x) for x in p5_endpoints()]


# ---------- P6: chores, shopping, rules, calendar, issues (D-105) ----------------------------------------------------------
def p6_endpoints():
    title = {"type": "string", "minLength": 1, "maxLength": 80}
    freq = {"type": "string", "enum": ["daily", "weekly", "biweekly", "monthly"]}
    rot = {"type": "array", "minItems": 1, "maxItems": 12, "items": UUID_S}
    rule = body({"category": {"type": "string", "enum": ["quiet", "guests", "cleaning", "kitchen", "smoking", "pets", "other"]},
                 "text": {"type": "string", "minLength": 1, "maxLength": 300}}, ("text",))
    return [
        ("wf.api.chores_list", "GET", "v1/households/:id/chores", "chores_list", HID),
        ("wf.api.chore_create", "POST", "v1/households/:id/chores", "chore_create", {**HID, "body": body({
            "title": title, "frequency": freq, "rotation": rot, "next_due_on": {"type": "string", "pattern": DATE_RE}}, ("title",))}),
        ("wf.api.chore_update", "PATCH", "v1/households/:id/chores/:chore_id", "chore_update", {"params": {"id": "uuid", "chore_id": "uuid"},
            "body": body({"title": title, "frequency": freq, "rotation": rot, "next_due_on": {"type": "string", "pattern": DATE_RE},
                          "active": {"type": "boolean"}})}),
        ("wf.api.chore_done", "POST", "v1/chore-assignments/:id/done", "chore_done", {**HID, "body": EMPTY_BODY}),
        ("wf.api.shopping_list", "GET", "v1/households/:id/shopping", "shopping_list", HID),
        ("wf.api.shopping_add", "POST", "v1/households/:id/shopping", "shopping_add", {**HID, "body": body({
            "label": title, "quantity": {"type": "string", "maxLength": 30}}, ("label",))}),
        ("wf.api.shopping_update", "PATCH", "v1/households/:id/shopping/:item_id", "shopping_update", {"params": {"id": "uuid", "item_id": "uuid"},
            "body": body({"label": title, "quantity": {"type": "string", "maxLength": 30}, "done": {"type": "boolean"}})}),
        ("wf.api.rules_get", "GET", "v1/households/:id/rules", "rules_get", HID),
        ("wf.api.rules_put", "PUT", "v1/households/:id/rules", "rules_put", {**HID, "body": body({
            "items": {"type": "array", "maxItems": 30, "items": rule}}, ("items",))}),
        ("wf.api.calendar_get", "GET", "v1/households/:id/calendar", "calendar_get",
         {**HID, "query": {"from": {"type": "date"}, "to": {"type": "date"}}}),
        ("wf.api.event_create", "POST", "v1/households/:id/events", "event_create", {**HID, "body": body({
            "title": title, "starts_at": {"type": "string", "pattern": TIME_RE}, "ends_at": {"type": "string", "pattern": TIME_RE},
            "all_day": {"type": "boolean"}}, ("title", "starts_at"))}),
        ("wf.api.event_delete", "DELETE", "v1/households/:id/events/:event_id", "event_delete", {"params": {"id": "uuid", "event_id": "uuid"}}),
        ("wf.api.issue_create", "POST", "v1/households/:id/issues", "issue_create", {**HID, "body": body({
            "title": {"type": "string", "minLength": 1, "maxLength": 120}, "description": {"type": "string", "maxLength": 2000},
            "category": {"type": "string", "enum": ["plumbing", "electricity", "heating", "appliance", "internet", "pests", "structure", "other"]},
            "urgency": {"type": "string", "enum": ["low", "normal", "urgent"]}}, ("title",))}),
        ("wf.api.issue_update", "POST", "v1/issues/:id/updates", "issue_update", {**HID, "body": body({
            "status": {"type": "string", "enum": ["acknowledged", "in_progress", "resolved", "closed", "open"]},
            "comment": {"type": "string", "minLength": 1, "maxLength": 1000}}), "require_any": ["status", "comment"]}),
    ]


def issues_list():
    """GET /v1/households/{id}/issues: the issues (api.issues_list, row-level layer), their processed photos as signed
    URLs (keys under media/ only, D-105)."""
    wf = platform_head("wf.api.issues_list", "GET", "v1/households/:id/issues")
    B.code_node(wf, "Validate", "platform_validate.js", [880, -100], subst={"__SPEC__": json.dumps(HID)})
    B.if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    B.pg_node(wf, "Call", "select api.issues_list($1::uuid, $2::jsonb) as r, " + MEDIA_CFG,
              "={{ [ $json.gw.ctx.user_id, JSON.stringify($json.input) ] }}", [1320, -200], on_error=None)
    B.code_node(wf, "Photo request", "issues_photos.js", [1540, -200])
    presign_node(wf, "Photo URLs", [1760, -200])
    B.code_node(wf, "Build result", "issues_result.js", [1980, -200])
    B.respond_tail(wf, 2200)
    wf.link("Gateway ok?", "Validate", 0)
    wf.link("Validate", "Valid?")
    wf.link("Valid?", "Call", 0)
    wf.link("Valid?", "Envelope", 1)
    for a, b in (("Call", "Photo request"), ("Photo request", "Photo URLs"), ("Photo URLs", "Build result"), ("Build result", "Envelope")):
        wf.link(a, b)
    return wf


def issue_photos_presign():
    """POST /v1/issues/{id}/photos/presign {files: [{content_type, bytes}]}: upload slots under uploads/issues/ and
    their presigned PUT URLs (Media service), like the listing photos (D-071, D-105)."""
    wf = platform_head("wf.api.issue_photos_presign", "POST", "v1/issues/:id/photos/presign")
    B.code_node(wf, "Validate", "platform_validate.js", [880, -100], subst={"__SPEC__": json.dumps({**HID, "body": body({
        "files": {"type": "array", "minItems": 1, "maxItems": 6, "items": body({
            "content_type": {"type": "string", "enum": ["image/jpeg", "image/png", "image/webp"]},
            "bytes": {"type": "integer", "minimum": 1, "maximum": 15728640}}, ("content_type", "bytes"))}}, ("files",))})})
    B.if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    B.pg_node(wf, "Slots", "select api.issue_photo_slots($1::uuid, $2::jsonb) as r",
              "={{ [ $json.gw.ctx.user_id, JSON.stringify($json.input) ] }}", [1320, -200], on_error=None)
    B.code_node(wf, "Sign each", "issue_presign_plan.js", [1540, -200])
    B.http_node(wf, "Presign", "POST", "={{ $json.url }}", [1760, -200], body="={{ JSON.stringify($json.body) }}", fmt="json",
                full=True, never_error=True, timeout="={{ 15000 }}", svc=True, on_error="continueRegularOutput")
    B.code_node(wf, "Build result", "issue_presign_result.js", [1980, -200])
    B.respond_tail(wf, 2200)
    wf.link("Gateway ok?", "Validate", 0)
    wf.link("Validate", "Valid?")
    wf.link("Valid?", "Slots", 0)
    wf.link("Valid?", "Envelope", 1)
    for a, b in (("Slots", "Sign each"), ("Sign each", "Presign"), ("Presign", "Build result"), ("Build result", "Envelope")):
        wf.link(a, b)
    return wf


def issue_photos_process():
    """POST /v1/issues/{id}/photos/process: each uploaded photo through the Media service (type and size checks, EXIF
    read then removed, faces and readable text blurred) into media/issues/..., then the raw uploads are deleted."""
    wf = platform_head("wf.api.issue_photos_process", "POST", "v1/issues/:id/photos/process")
    B.code_node(wf, "Validate", "platform_validate.js", [880, -100], subst={"__SPEC__": json.dumps({**HID, "body": EMPTY_BODY})})
    B.if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    B.pg_node(wf, "Pending", "select api.issue_photos_pending($1::uuid, $2::jsonb) as r",
              "={{ [ $json.gw.ctx.user_id, JSON.stringify($json.input) ] }}", [1320, -200], on_error=None)
    B.code_node(wf, "Each photo", "issue_process_plan.js", [1540, -200])
    B.http_node(wf, "Process", "POST", "={{ $json.url }}", [1760, -200], body="={{ JSON.stringify($json.body) }}", fmt="json",
                full=True, never_error=True, timeout="={{ 120000 }}", svc=True, on_error="continueRegularOutput")
    B.code_node(wf, "Results", "issue_process_results.js", [1980, -200])
    B.pg_node(wf, "Store", "select api.issue_photo_store($1::uuid, $2::jsonb) as r", "={{ $json.params }}", [2200, -200], on_error=None)
    B.http_node(wf, "Delete raw", "POST", "={{ $('Results').first().json.delete_url }}", [2420, -200],
                body="={{ JSON.stringify({ keys: $('Results').first().json.raw_keys }) }}", fmt="json", full=True, never_error=True,
                timeout="={{ 30000 }}", svc=True, on_error="continueRegularOutput")
    B.code_node(wf, "Build result", "issue_process_result.js", [2640, -200])
    B.respond_tail(wf, 2860)
    wf.link("Gateway ok?", "Validate", 0)
    wf.link("Validate", "Valid?")
    wf.link("Valid?", "Pending", 0)
    wf.link("Valid?", "Envelope", 1)
    for a, b in (("Pending", "Each photo"), ("Each photo", "Process"), ("Process", "Results"), ("Results", "Store"),
                 ("Store", "Delete raw"), ("Delete raw", "Build result"), ("Build result", "Envelope")):
        wf.link(a, b)
    return wf


def household_daily():
    """Every day at 05:00 UTC, in each household's own date (PLATFORM_SPEC 3.6): rent and bill reminders (P5) and the
    chore assignments (P6) and the saved-search alerts (P7), from functions that act for nobody and return only counts (7.1)."""
    wf = B.WF("fsHouseholdDly1", "wf.household.daily", tags=["schedule", "platform"])
    wf.node("Every day", "n8n-nodes-base.scheduleTrigger", 1.2,
            {"rule": {"interval": [{"field": "cronExpression", "expression": "0 5 * * *"}]}}, [0, 0])
    B.pg_node(wf, "Reminders", "select home.daily_reminders(null) as r", None, [220, 0], on_error=None, retries=2)
    B.pg_node(wf, "Chores", "select home.daily_chores(null) as r", None, [440, 0], on_error=None, retries=2)
    B.pg_node(wf, "Saved-search alerts", "select social.daily_alerts() as r", None, [660, 0], on_error=None, retries=2)
    wf.link("Every day", "Reminders")
    wf.link("Reminders", "Chores")
    wf.link("Chores", "Saved-search alerts")
    return wf


P6 = [_p4(x) for x in p6_endpoints()] + [issues_list, issue_photos_presign, issue_photos_process, household_daily]

# ---------- P7: flatmates, rooms posted by a household, saved searches (D-106) ----------------------------------------
JUR = {"type": "string", "max": 2, "pattern": "^[A-Z]{2}$"}


def p7_endpoints():
    return [
        ("wf.api.flatmate_profile_get", "GET", "v1/me/flatmate-profile", "flatmate_profile_get", {}),
        ("wf.api.flatmate_profile_put", "PUT", "v1/me/flatmate-profile", "flatmate_profile_put", {"body": body({
            "visible": {"type": "boolean"}, "headline": {"type": "string", "maxLength": 80}, "bio": {"type": "string", "maxLength": 600},
            "seeking": {"type": "string", "enum": ["room", "flatmate", "both"]},
            "areas": {"type": "array", "maxItems": 5, "items": {"type": "string", "minLength": 1, "maxLength": 60}},
            "move_in_from": {"type": "string", "pattern": DATE_RE}}, ("visible",))}),
        ("wf.api.flatmates_list", "GET", "v1/flatmates", "flatmates_list", {"query": {
            **PAGE, "cursor": {"type": "int", "min": 0, "max": 100000}, "seeking": {"type": "enum", "values": ["room", "flatmate"]},
            "jurisdiction": JUR}}),
        ("wf.api.flatmate_get", "GET", "v1/flatmates/:user_id", "flatmate_get", {"params": {"user_id": "uuid"}}),
        ("wf.api.saved_searches_list", "GET", "v1/me/saved-searches", "saved_searches_list", {}),
        ("wf.api.saved_search_delete", "DELETE", "v1/me/saved-searches/:id", "saved_search_delete", HID),
    ]


def saved_search_create():
    """POST /v1/me/saved-searches {name, query, alert}: the query is checked by the /v2/search rules and kept with the
    function's parameters, so the daily alert (social.daily_alerts) runs the same search (D-106)."""
    wf = platform_head("wf.api.saved_search_create", "POST", "v1/me/saved-searches")
    B.code_node(wf, "Validate", "platform_validate.js", [880, -100], subst={"__SPEC__": json.dumps({"body": body({
        "name": {"type": "string", "minLength": 1, "maxLength": 60}, "alert": {"type": "string", "enum": ["none", "daily"]},
        "query": {"type": "object", "additionalProperties": {"type": "string", "maxLength": 400}}},
        ("name", "query"))})})
    B.if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    B.code_node(wf, "Search parameters", "saved_search_params.js", [1320, -200])
    B.if_node(wf, "Search valid?", "={{ $json.ok }}", [1540, -200])
    B.pg_node(wf, "Call", "select api.saved_search_create($1::uuid, $2::jsonb) as r",
              "={{ [ $json.gw.ctx.user_id, JSON.stringify($json.input) ] }}", [1760, -300], always_output=True)
    B.code_node(wf, "Build result", "platform_result.js", [1980, -300])
    B.code_node(wf, "Database error", "platform_db_error.js", [1980, -100])
    B.respond_tail(wf, 2200)
    wf.link("Gateway ok?", "Validate", 0)
    wf.link("Validate", "Valid?")
    wf.link("Valid?", "Search parameters", 0)
    wf.link("Valid?", "Envelope", 1)
    wf.link("Search parameters", "Search valid?")
    wf.link("Search valid?", "Call", 0)
    wf.link("Search valid?", "Envelope", 1)
    wf.link("Call", "Build result", 0)
    wf.link("Call", "Database error", 1)
    wf.link("Build result", "Envelope")
    wf.link("Database error", "Envelope")
    return wf


def room_post():
    """POST /v1/households/{id}/room-posts {title?, text?}: a member starts the draft listing of the household's free room
    (home.room_post: checks membership, one open listing per household, links it). The draft is then finished on the
    owner pages like any other listing."""
    wf = platform_head("wf.api.room_post", "POST", "v1/households/:id/room-posts")
    B.code_node(wf, "Validate", "platform_validate.js", [880, -100], subst={"__SPEC__": json.dumps({**HID, "body": body({
        "title": {"type": "string", "minLength": 1, "maxLength": 120}, "text": {"type": "string", "maxLength": 4000}})})})
    B.if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    B.pg_node(wf, "Call", "select home.room_post($1::uuid, $2::jsonb) as r",
              "={{ [ $json.gw.ctx.user_id, JSON.stringify($json.input) ] }}", [1320, -200], always_output=True)
    B.code_node(wf, "Build result", "platform_result.js", [1540, -200])
    B.code_node(wf, "Database error", "platform_db_error.js", [1540, 0])
    B.respond_tail(wf, 1760)
    wf.link("Gateway ok?", "Validate", 0)
    wf.link("Validate", "Valid?")
    wf.link("Valid?", "Call", 0)
    wf.link("Valid?", "Envelope", 1)
    wf.link("Call", "Build result", 0)
    wf.link("Call", "Database error", 1)
    wf.link("Build result", "Envelope")
    wf.link("Database error", "Envelope")
    return wf


P7 = [_p4(x) for x in p7_endpoints()] + [saved_search_create, room_post]

# ---------- P8: trust and safety (D-107) ---------------------------------------------------------------------------------
TRUST_WF = ids("wf.trust.assess")[0]
TRUST_TOOL_WF = ids("wf.trust.tool")[0]
TRUST_TOOLS = [
    ("text_signals", "What the platform's phrase lists found in the listing text: payment before a visit, payment services, "
                     "pressure, owner abroad. No input."),
    ("listing_fields", "The listing's fields: rent per month, deposit, place, furnished, number of photos, issues found by the "
                       "analysis. No input."),
    ("price_benchmark", "The listing's monthly rent against the median of comparable published listings (same country, city "
                        "and kind), or insufficient_data. No input."),
    ("photo_duplicates", "How many of the listing's photos another owner's listing also uses. No input."),
    ("owner_history", "The owner's account age in days, listings, listings in the last days, earlier publications, reports and "
                      "rejections. No input."),
]


def trust_tool():
    """The Trust agent's tools (one sub-workflow, the tool name as input): facts from app.trust_facts and the phrase
    lists. The agent never gets another user's text."""
    wf = B.WF(TRUST_TOOL_WF, "wf.trust.tool", tags=["agent", "platform"])
    wf.node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1, B.tool_inputs([("tool", "string"), ("listing_id", "string")]), [0, 0])
    B.pg_node(wf, "Facts", "select app.trust_facts(app.try_uuid($1)) as f", "={{ [ $json.listing_id || '' ] }}", [220, 0], on_error=None)
    B.code_node(wf, "Tool answer", "trust_tool_answer.js", [440, 0], subst={"__TRUST_PHRASES__": trust_phrases()})
    wf.link("Start", "Facts")
    wf.link("Facts", "Tool answer")
    return wf


def trust_assess():
    """A4 Trust agent (backend spec 12, PLATFORM_SPEC 4): input {listing_id, request_id}. The database checks
    (duplicates, price benchmark, owner history, EXIF, contact details) and the phrase rules run first; the AI Agent
    node (P4_trust_assessor, local model, five read-only tools) reads the wording and returns signals with quotes;
    code keeps only quoted signals; app.trust_store caps the points and computes the score and the verdict. Output
    {ok, report_id, score, verdict, signals, steps}. The agent has no write tool."""
    wf = B.WF(TRUST_WF, "wf.trust.assess", tags=["agent", "platform"])
    wf.node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1, {"inputSource": "passthrough"}, [0, 0])
    B.pg_node(wf, "Facts", "select app.trust_facts(app.try_uuid($1)) as f, ai.prompt_for('P4_trust_assessor') as p,"
              " (select jsonb_object_agg(key, value #>> '{}') from app.settings where key in ('trust.agent_enabled', 'trust.model',"
              " 'trust.agent_max_iterations', 'trust.num_ctx', 'llm.default_model', 'llm.keep_alive')) as cfg",
              "={{ [ $json.listing_id || '' ] }}", [220, 0], on_error=None)
    B.code_node(wf, "Rules", "trust_input.js", [440, 0], subst={"__TRUST_PHRASES__": trust_phrases()})
    B.if_node(wf, "Listing found?", "={{ $json.ok }}", [660, 0])
    B.if_node(wf, "Agent?", "={{ $json.agent }}", [880, -100])
    wf.node("Trust agent", "@n8n/n8n-nodes-langchain.agent", 3.1, {
        "promptType": "define", "text": "={{ $json.prompt }}", "hasOutputParser": False,
        "options": {"systemMessage": "={{ $json.system }}", "maxIterations": "={{ $json.max_iterations }}",
                    "returnIntermediateSteps": True}}, [1100, -200], onError="continueRegularOutput")
    wf.node("Ollama Chat Model", "@n8n/n8n-nodes-langchain.lmChatOllama", 1, {
        "model": "={{ $('Rules').first().json.model }}",
        "options": {"temperature": 0, "think": False, "keepAlive": "={{ $('Rules').first().json.keep_alive }}",
                    "numCtx": "={{ $('Rules').first().json.num_ctx }}",
                    "numPredict": "={{ $('Rules').first().json.num_predict }}"}},
        [960, 40], credentials=B.OLLAMA_CRED)
    for i, (name, desc) in enumerate(TRUST_TOOLS):
        wf.node(name, "@n8n/n8n-nodes-langchain.toolWorkflow", 2.2, {
            "description": desc, "source": "database",
            "workflowId": {"__rl": True, "value": TRUST_TOOL_WF, "mode": "id", "cachedResultName": "wf.trust.tool"},
            "workflowInputs": B.tool_mapping([("tool", "string", name),
                                              ("listing_id", "string", "={{ $('Rules').first().json.listing_id }}")])},
            [1100 + 140 * i, 40])
        wf.ai_link(name, "Trust agent", "ai_tool")
    B.code_node(wf, "Check answer", "trust_output.js", [1320, 0])
    B.pg_node(wf, "Store", "select app.trust_store($1::uuid, $2::jsonb) as r",
              "={{ [ $json.listing_id, JSON.stringify($json.payload) ] }}", [1540, 0], on_error=None)
    B.code_node(wf, "Result", "trust_result.js", [1760, 0])
    B.code_node(wf, "No listing", "trust_no_listing.js", [880, 200])
    wf.link("Start", "Facts")
    wf.link("Facts", "Rules")
    wf.link("Rules", "Listing found?")
    wf.link("Listing found?", "Agent?", 0)
    wf.link("Listing found?", "No listing", 1)
    # D-114: trust.model detector -> one P8_scam_detector call (Emna Safer's prompt) instead of the agent
    B.if_node(wf, "Detector?", "={{ $json.detector }}", [1100, 150])
    wf.node("Detector input", "n8n-nodes-base.code", 2, {"mode": "runOnceForAllItems", "language": "javaScript",
            "jsCode": "// wf.llm.call input for P8_scam_detector, prepared by Rules\nreturn [{ json: $('Rules').first().json.detector_input }];"},
            [1320, 250])
    B.exec_wf(wf, "Detector", B.LLM_CALL_WF, "wf.llm.call", pos=[1540, 250], on_error="continueRegularOutput")
    wf.link("Agent?", "Trust agent", 0)
    wf.link("Agent?", "Detector?", 1)
    wf.link("Detector?", "Detector input", 0)
    wf.link("Detector?", "Check answer", 1)
    wf.link("Detector input", "Detector")
    wf.link("Detector", "Check answer")
    wf.link("Trust agent", "Check answer")
    wf.link("Check answer", "Store")
    wf.link("Store", "Result")
    wf.ai_link("Ollama Chat Model", "Trust agent", "ai_languageModel")
    return wf


def ops_benchmarks():
    """Every day at 04:30 UTC: the price benchmarks again from the published listings (backend spec 12.3)."""
    wf = B.WF(ids("wf.ops.benchmarks")[0], "wf.ops.benchmarks", tags=["schedule", "platform"])
    wf.node("Every day", "n8n-nodes-base.scheduleTrigger", 1.2,
            {"rule": {"interval": [{"field": "cronExpression", "expression": "30 4 * * *"}]}}, [0, 0])
    B.pg_node(wf, "Benchmarks", "select app.refresh_price_benchmarks() as r", None, [220, 0], on_error=None, retries=2)
    wf.link("Every day", "Benchmarks")
    return wf


STAFF = ("moderator", "admin")


def moderation_list():
    return rls_endpoint("wf.api.moderation_list", "GET", "v1/admin/moderation", "app.moderation_list", roles=STAFF, spec={"query": {
        **PAGE, "cursor": {"type": "int", "min": 0, "max": 100000},
        "status": {"type": "enum", "values": ["open", "approved", "rejected", "all"]}}})


def moderation_decide():
    return rls_endpoint("wf.api.moderation_decide", "POST", "v1/admin/moderation/:id/decision", "app.moderation_decide", roles=STAFF,
                        spec={"params": {"id": "int"}, "body": body({
                            "action": {"type": "string", "enum": ["approve", "reject", "dismiss", "hide_message", "warn"]},
                            "note": {"type": "string", "maxLength": 1000},
                            "code": {"type": "string", "enum": ["scam", "stolen_photos", "wrong_info", "offensive", "discrimination",
                                                                "spam", "other"]}}, ("action",))})


P8 = [trust_tool, trust_assess, ops_benchmarks, moderation_list, moderation_decide]

# ---------- P9: documents and legal help (D-108) ----------------------------------------------------------------------
DOC_TOOL_WF = ids("wf.documents.tool")[0]
DOC_KINDS = ["flatmate_agreement", "inventory_entry", "inventory_exit", "rent_receipt", "house_rules", "living_plan"]
DOC_CFG = ("(select jsonb_object_agg(key, value #>> '{}') from app.settings where key in ('services.media_url',"
           " 'media.photo_url_ttl_s')) as cfg")


def doc_templates():
    """kb/templates/<CODE>/<kind>.json as JSON for the Code nodes (D-108)."""
    root = B.ROOT.parent / "kb" / "templates"
    out = []
    for d in sorted(p for p in root.iterdir() if p.is_dir()):
        for f in sorted(d.glob("*.json")):
            out.append(json.loads(f.read_text(encoding="utf-8")))
    return json.dumps(out, ensure_ascii=False)


def document_templates():
    """GET /v1/document-templates?jurisdiction=XX: the document types a country offers, their slots and sources."""
    wf = platform_head("wf.api.document_templates", "GET", "v1/document-templates")
    B.code_node(wf, "Validate", "platform_validate.js", [880, -100], subst={"__SPEC__": json.dumps({"query": {"jurisdiction": JUR}})})
    B.if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    B.code_node(wf, "Build result", "doc_templates_list.js", [1320, -200], subst={"__DOC_TEMPLATES__": doc_templates()})
    B.respond_tail(wf, 1540)
    wf.link("Gateway ok?", "Validate", 0)
    wf.link("Validate", "Valid?")
    wf.link("Valid?", "Build result", 0)
    wf.link("Valid?", "Envelope", 1)
    wf.link("Build result", "Envelope")
    return wf


def documents_create():
    """POST /v1/households/{id}/documents {kind, language, values | payment_id | draft_id}: the template of the
    household's country filled from the database facts and the person's values (or a confirmed draft of the Document
    agent), rendered to PDF by the Media service (documents/...), stored. 201 with the document; 422 lists the missing
    slots; GET /v1/documents/{id} gives the download link."""
    wf = platform_head("wf.api.documents_create", "POST", "v1/households/:id/documents")
    B.code_node(wf, "Validate", "platform_validate.js", [880, -100], subst={"__SPEC__": json.dumps({**HID, "body": body({
        "kind": {"type": "string", "enum": DOC_KINDS}, "language": {"type": "string", "enum": ["fr", "ar", "en"]},
        "values": {"type": "object"}, "payment_id": UUID_S, "draft_id": UUID_S}), "require_any": ["kind", "draft_id"]})})
    B.if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    B.pg_node(wf, "Draft", "select case when $3 <> '' then api.document_draft_get($1::uuid, jsonb_build_object('household_id', $2, 'draft_id', $3)) end as r",
              "={{ [ $json.gw.ctx.user_id, $json.input.params.id, $json.input.body.draft_id || '' ] }}", [1320, -200], on_error=None)
    B.pg_node(wf, "Facts", "select api.document_facts($1::uuid, $2::jsonb) as r, gen_random_uuid() as new_id, " + DOC_CFG,
              "={{ [ $('Validate').first().json.gw.ctx.user_id, JSON.stringify({ params: $('Validate').first().json.input.params,"
              " body: { kind: ($json.r && $json.r.data ? $json.r.data.kind : $('Validate').first().json.input.body.kind),"
              " payment_id: $('Validate').first().json.input.body.payment_id } }) ] }}", [1540, -200], on_error=None)
    B.code_node(wf, "Fill", "doc_fill.js", [1760, -200], subst={"__DOC_TEMPLATES__": doc_templates()})
    B.if_node(wf, "Filled?", "={{ $json.ok }}", [1980, -200])
    B.http_node(wf, "Render", "POST", "={{ $json.url }}", [2200, -300], body="={{ JSON.stringify($json.body) }}", fmt="json",
                full=True, never_error=True, timeout="={{ 60000 }}", svc=True, on_error="continueRegularOutput")
    B.code_node(wf, "Store input", "doc_store_input.js", [2420, -300])
    B.pg_node(wf, "Store", "select api.document_store($1::uuid, $2::jsonb) as r", "={{ $json.params }}", [2640, -300], on_error=None)
    B.code_node(wf, "Build result", "doc_create_result.js", [2860, -300])
    B.respond_tail(wf, 3080)
    wf.link("Gateway ok?", "Validate", 0)
    wf.link("Validate", "Valid?")
    wf.link("Valid?", "Draft", 0)
    wf.link("Valid?", "Envelope", 1)
    for a, b in (("Draft", "Facts"), ("Facts", "Fill"), ("Fill", "Filled?"), ("Render", "Store input"), ("Store input", "Store"),
                 ("Store", "Build result"), ("Build result", "Envelope")):
        wf.link(a, b)
    wf.link("Filled?", "Render", 0)
    wf.link("Filled?", "Envelope", 1)
    return wf


def document_get():
    """GET /v1/documents/{id}: the document (members of its household) with a signed download link (900 s)."""
    wf = platform_head("wf.api.document_get", "GET", "v1/documents/:id")
    B.code_node(wf, "Validate", "platform_validate.js", [880, -100], subst={"__SPEC__": json.dumps(HID)})
    B.if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    B.pg_node(wf, "Call", "select api.document_get($1::uuid, $2::jsonb) as r, " + DOC_CFG,
              "={{ [ $json.gw.ctx.user_id, JSON.stringify($json.input) ] }}", [1320, -200], on_error=None)
    B.code_node(wf, "Sign request", "doc_sign_request.js", [1540, -200])
    presign_node(wf, "Download URL", [1760, -200])
    B.code_node(wf, "Build result", "doc_get_result.js", [1980, -200])
    B.respond_tail(wf, 2200)
    wf.link("Gateway ok?", "Validate", 0)
    wf.link("Validate", "Valid?")
    wf.link("Valid?", "Call", 0)
    wf.link("Valid?", "Envelope", 1)
    for a, b in (("Call", "Sign request"), ("Sign request", "Download URL"), ("Download URL", "Build result"), ("Build result", "Envelope")):
        wf.link(a, b)
    return wf


def documents_list():
    return rls_endpoint("wf.api.documents_list", "GET", "v1/households/:id/documents", "documents_list", spec=HID)


DOC_TOOLS = [
    ("household_facts", "What the platform knows about the home: country, flatmates, owner member, whether the address is known, "
                        "house rules, document kinds offered. No input."),
    ("template_slots", "For one document kind: the values the platform fills and the values to ask the person (to_ask), with "
                       "their types. Input: kind."),
    ("propose_document", "Store a proposal the person will check and confirm. Input: kind, language (fr, ar or en) and values, a "
                         "JSON object with only the values of to_ask the person gave. Returns what is still missing."),
]


def documents_tool():
    """The Document agent's tools (one sub-workflow; the tool name, the model's arguments, and the person and household
    the request belongs to, which the model does not choose)."""
    wf = B.WF(DOC_TOOL_WF, "wf.documents.tool", tags=["agent", "platform"])
    wf.node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1, B.tool_inputs([("tool", "string"), ("kind", "string"), ("args", "string"),
            ("user_id", "string"), ("household_id", "string"), ("language", "string")]), [0, 0])
    B.pg_node(wf, "Facts", "select api.document_facts(app.try_uuid($1), jsonb_build_object('params', jsonb_build_object('id', $2),"
              " 'body', jsonb_build_object('kind', 'house_rules'))) as r", "={{ [ $json.user_id || '', $json.household_id || '' ] }}",
              [220, 0], on_error=None)
    B.code_node(wf, "Plan", "doc_tool_plan.js", [440, 0], subst={"__DOC_TEMPLATES__": doc_templates()})
    B.if_node(wf, "Store?", "={{ $json.store }}", [660, 0])
    B.pg_node(wf, "Draft", "select api.document_draft_put($1::uuid, $2::jsonb) as r", "={{ $json.params }}", [880, -100], on_error=None)
    B.code_node(wf, "Tool answer", "doc_tool_answer.js", [1100, 0])
    wf.link("Start", "Facts")
    wf.link("Facts", "Plan")
    wf.link("Plan", "Store?")
    wf.link("Store?", "Draft", 0)
    wf.link("Store?", "Tool answer", 1)
    wf.link("Draft", "Tool answer")
    return wf


def documents_assistant():
    """POST /v1/households/{id}/documents/assistant {text}: the Document agent A6 (AI Agent node, P9_document_agent,
    local model, Postgres chat memory per person and household, three tools). It only proposes: the answer carries the
    stored draft, and the person confirms it with POST /v1/households/{id}/documents {draft_id} (D-108)."""
    wf = platform_head("wf.api.documents_assistant", "POST", "v1/households/:id/documents/assistant")
    B.code_node(wf, "Validate", "platform_validate.js", [880, -100], subst={"__SPEC__": json.dumps({**HID, "body": body({
        "text": {"type": "string", "minLength": 1, "maxLength": 2000}}, ("text",))})})
    B.if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    B.pg_node(wf, "Context", "select api.document_facts($1::uuid, jsonb_build_object('params', $2::jsonb, 'body', jsonb_build_object('kind', 'house_rules'))) as r,"
              " ai.prompt_for('P9_document_agent') as p, (select jsonb_object_agg(key, value #>> '{}') from app.settings where key in"
              " ('documents.agent_enabled', 'documents.agent_max_iterations', 'documents.agent_memory_turns', 'documents.num_ctx',"
              " 'llm.default_model', 'llm.keep_alive')) as cfg",
              "={{ [ $json.gw.ctx.user_id, JSON.stringify($json.input.params) ] }}", [1320, -200], on_error=None)
    B.code_node(wf, "Agent input", "doc_agent_input.js", [1540, -200], subst={"__DOC_TEMPLATES__": doc_templates()})
    B.if_node(wf, "Agent?", "={{ $json.ok }}", [1760, -200])
    wf.node("Document agent", "@n8n/n8n-nodes-langchain.agent", 3.1, {
        "promptType": "define", "text": "={{ $json.prompt }}", "hasOutputParser": False,
        "options": {"systemMessage": "={{ $json.system }}", "maxIterations": "={{ $json.max_iterations }}",
                    "returnIntermediateSteps": True}}, [1980, -300], onError="continueRegularOutput")
    ai = "$('Agent input').first().json"
    wf.node("Ollama Chat Model", "@n8n/n8n-nodes-langchain.lmChatOllama", 1, {
        "model": "={{ %s.model }}" % ai,
        "options": {"temperature": 0, "think": False, "keepAlive": "={{ %s.keep_alive }}" % ai, "numCtx": "={{ %s.num_ctx }}" % ai,
                    "numPredict": "={{ %s.num_predict }}" % ai}}, [1840, -60], credentials=B.OLLAMA_CRED)
    wf.node("Chat memory", "@n8n/n8n-nodes-langchain.memoryPostgresChat", 1.3, {
        "sessionIdType": "customKey", "sessionKey": "={{ %s.session_id }}" % ai, "tableName": "agent_memory.chat_histories",
        "contextWindowLength": "={{ %s.memory_turns }}" % ai}, [1980, -60], credentials=B.PG_CRED)
    for i, (name, desc) in enumerate(DOC_TOOLS):
        fields = [("tool", "string", name),
                  ("kind", "string", "={{ $fromAI('kind', 'The document kind', 'string') }}" if name != "household_facts" else ""),
                  ("args", "string", "={{ JSON.stringify({ kind: $fromAI('kind', 'The document kind', 'string'), language: $fromAI('language',"
                   " 'fr, ar or en', 'string'), values: $fromAI('values', 'JSON object with the values the person gave', 'string') }) }}"
                   if name == "propose_document" else ""),
                  ("user_id", "string", "={{ %s.user_id }}" % ai), ("household_id", "string", "={{ %s.household_id }}" % ai),
                  ("language", "string", "={{ %s.language }}" % ai)]
        wf.node(name, "@n8n/n8n-nodes-langchain.toolWorkflow", 2.2, {
            "description": desc, "source": "database",
            "workflowId": {"__rl": True, "value": DOC_TOOL_WF, "mode": "id", "cachedResultName": "wf.documents.tool"},
            "workflowInputs": B.tool_mapping(fields)}, [2120 + 140 * i, -60])
        wf.ai_link(name, "Document agent", "ai_tool")
    B.code_node(wf, "Check answer", "doc_agent_output.js", [2200, -300])
    B.pg_node(wf, "Last draft", "select api.document_draft_last($1::uuid, $2::jsonb) as r", "={{ $json.params }}", [2420, -300], on_error=None)
    B.code_node(wf, "Build result", "doc_agent_result.js", [2640, -300])
    B.respond_tail(wf, 2860)
    wf.link("Gateway ok?", "Validate", 0)
    wf.link("Validate", "Valid?")
    wf.link("Valid?", "Context", 0)
    wf.link("Valid?", "Envelope", 1)
    wf.link("Context", "Agent input")
    wf.link("Agent input", "Agent?")
    wf.link("Agent?", "Document agent", 0)
    wf.link("Agent?", "Envelope", 1)
    for a, b in (("Document agent", "Check answer"), ("Check answer", "Last draft"), ("Last draft", "Build result"), ("Build result", "Envelope")):
        wf.link(a, b)
    wf.ai_link("Ollama Chat Model", "Document agent", "ai_languageModel")
    wf.ai_link("Chat memory", "Document agent", "ai_memory")
    return wf


def legal_ask():
    """POST /v1/legal/ask {text, jurisdiction?}: straight to the Legal agent A5, without the P1 router (PLATFORM_SPEC 3.8,
    backend spec 6.3). Same masking and the same checks as the assistant's legal answers (D-087)."""
    wf = platform_head("wf.api.legal_ask", "POST", "v1/legal/ask")
    B.code_node(wf, "Validate body", "orch_validate.js", [880, -100])
    B.if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    B.pg_node(wf, "Context", "select (select value #>> '{}' from app.settings where key = 'services.text_url') as text_url,"
              " coalesce((select value #>> '{}' from app.settings where key = 'legal.agent_enabled'), 'false') = 'true' as legal_enabled",
              None, [1320, -200], on_error=None)
    B.if_node(wf, "Agent on?", "={{ $json.legal_enabled }}", [1430, -200])
    B.http_node(wf, "Text analysis", "POST", "={{ $('Context').first().json.text_url.replace(/\\/+$/, '') + '/v1/analyze' }}", [1540, -300],
                body="={{ JSON.stringify({ text: $('Validate body').first().json.text, mask: true, use_ner: true }) }}",
                fmt="json", full=True, never_error=True, timeout="={{ 10000 }}", svc=True, on_error="continueRegularOutput")
    B.code_node(wf, "Legal request", "legal_ask_input.js", [1760, -300])
    B.exec_wf(wf, "Legal agent", B.LEGAL_AGENT_WF, "wf.legal.agent", pos=[1980, -300], on_error="continueRegularOutput")
    B.code_node(wf, "Legal answer", "legal_ask_result.js", [2200, -300])
    B.code_node(wf, "Agent off", "legal_ask_off.js", [1540, -100])
    B.respond_tail(wf, 2420)
    wf.link("Gateway ok?", "Validate body", 0)
    wf.link("Validate body", "Valid?")
    wf.link("Valid?", "Context", 0)
    wf.link("Valid?", "Envelope", 1)
    wf.link("Context", "Agent on?")
    wf.link("Agent on?", "Text analysis", 0)
    wf.link("Agent on?", "Agent off", 1)
    for a, b in (("Text analysis", "Legal request"), ("Legal request", "Legal agent"), ("Legal agent", "Legal answer"),
                 ("Legal answer", "Envelope"), ("Agent off", "Envelope")):
        wf.link(a, b)
    return wf


P9 = [document_templates, documents_create, document_get, documents_list, documents_tool, documents_assistant, legal_ask]

# ---------- P10: moving out and privacy (D-109) ---------------------------------------------------------------------
def p10_endpoints():
    DU = {"params": {"id": "uuid", "user_id": "uuid"}}
    ded = {"type": "array", "maxItems": 20, "items": body({"reason": {"type": "string", "minLength": 1, "maxLength": 200},
                                                          "amount_minor": {"type": "integer", "minimum": 0, "maximum": 1000000000000}},
                                                         ("reason", "amount_minor"))}
    return [
        ("wf.api.deposits_list", "GET", "v1/households/:id/deposits", "deposits_list", HID),
        ("wf.api.deposit_put", "PUT", "v1/households/:id/deposits/:user_id", "deposit_put", {**DU, "body": body({
            "amount_minor": MINOR, "paid_on": {"type": "string", "pattern": DATE_RE}, "held_by": {"type": "string", "enum": ["owner", "flatmates"]},
            "returned_minor": {"type": "integer", "minimum": 0, "maximum": 1000000000000}, "returned_on": {"type": "string", "pattern": DATE_RE},
            "deductions": ded}, ("amount_minor",))}),
        ("wf.api.moveout_get", "GET", "v1/households/:id/move-out", "moveout_get", HID),
        ("wf.api.moveout_start", "POST", "v1/households/:id/move-out", "moveout_start", {**HID, "body": body({
            "planned_on": {"type": "string", "pattern": DATE_RE}}, ("planned_on",))}),
        ("wf.api.moveout_item", "PATCH", "v1/households/:id/move-out/:item", "moveout_item", {"params": {"id": "uuid", "item": "string"},
            "body": body({"done": {"type": "boolean"}})}),
        ("wf.api.document_comparison", "GET", "v1/documents/:id/comparison", "document_comparison", HID),
    ]


def me_delete():
    """DELETE /v1/me?confirm=DELETE: the caller's account is erased (app.erase_user and the platform's triggers; files
    queued for deletion). No consent needed: withdrawing consent must not block leaving (D-109)."""
    return rls_endpoint("wf.api.me_delete", "DELETE", "v1/me", "app.me_erase", consents=[],
                        spec={"query": {"confirm": {"type": "enum", "values": ["DELETE"]}}})


def ops_retention():
    """Every day at 03:30 UTC (backend spec 13.5, 13.6): app.retention_run (drafts, read notifications, alert records,
    stored idempotent answers, with the ages in settings retention.*), then the file deletions queued by erasures, each
    sent to the Media service and marked done (failed ones are retried, up to five attempts)."""
    wf = B.WF(ids("wf.ops.retention")[0], "wf.ops.retention", tags=["schedule", "platform"])
    wf.node("Every day", "n8n-nodes-base.scheduleTrigger", 1.2,
            {"rule": {"interval": [{"field": "cronExpression", "expression": "30 3 * * *"}]}}, [0, 0])
    B.pg_node(wf, "Retention", "select app.retention_run(null) as r", None, [220, 0], on_error=None, retries=2)
    B.pg_node(wf, "File jobs", "select app.media_deletions_take(20) as jobs, " + DOC_CFG, None, [440, 0], on_error=None)
    B.code_node(wf, "Each job", "retention_jobs.js", [660, 0])
    B.http_node(wf, "Delete files", "POST", "={{ $json.url }}", [880, 0], body="={{ JSON.stringify($json.body) }}", fmt="json",
                full=True, never_error=True, timeout="={{ 60000 }}", svc=True, on_error="continueRegularOutput")
    wf.node("Results", "n8n-nodes-base.code", 2, {"mode": "runOnceForAllItems", "language": "javaScript",
            "jsCode": B.code("retention_done.js")}, [1100, 0])
    B.pg_node(wf, "Mark done", "select app.media_deletions_done($1::jsonb) as r", "={{ [ $json.results ] }}", [1320, 0], on_error=None)
    for a, b in (("Every day", "Retention"), ("Retention", "File jobs"), ("File jobs", "Each job"), ("Each job", "Delete files"),
                 ("Delete files", "Results"), ("Results", "Mark done")):
        wf.link(a, b)
    return wf


P10 = [_p4(x) for x in p10_endpoints()] + [me_delete, ops_retention]


# ---------- P11: notification channels and admin (D-110) ------------------------------------------------------------
SMTP_CRED = {"smtp": {"id": "fsCredSmtp000001", "name": "Mail (SMTP)"}}
ADMIN = ("admin",)


def notify_texts():
    """notifications.types of web/messages/<locale>.json: the sentences the website shows, for e-mail and Telegram."""
    root = B.ROOT.parent / "web" / "messages"
    return json.dumps({l: json.loads((root / f"{l}.json").read_text(encoding="utf-8"))["notifications"]["types"]
                       for l in ("fr", "en", "ar")}, ensure_ascii=False)


def p11_endpoints():
    return [
        ("wf.api.notify_prefs_get", "GET", "v1/me/notification-preferences", "notify_prefs_get", {}),
        ("wf.api.notify_prefs_put", "PUT", "v1/me/notification-preferences", "notify_prefs_put", {"body": body({
            "email": {"type": "boolean"}, "telegram": {"type": "boolean"},
            "muted": {"type": "array", "maxItems": 60, "items": {"type": "string", "pattern": "^[a-z][a-z0-9_]{2,60}$"}}})}),
        ("wf.api.telegram_link_create", "POST", "v1/me/telegram-link", "telegram_link_create", {"body": EMPTY_BODY}),
        ("wf.api.telegram_unlink", "DELETE", "v1/me/telegram-link", "telegram_unlink", {}),
    ]


def admin_endpoints():
    staff = ("moderator", "admin")
    return [
        rls_endpoint("wf.api.admin_settings_list", "GET", "v1/admin/settings", "app.admin_settings_list", roles=ADMIN, consents=[], spec={}),
        rls_endpoint("wf.api.admin_setting_put", "PUT", "v1/admin/settings/:key", "app.admin_setting_put", roles=ADMIN, consents=[],
                     spec={"params": {"key": "string"}, "body": body({"value": {}}, ("value",))}),
        rls_endpoint("wf.api.admin_users_list", "GET", "v1/admin/users", "app.admin_users_list", roles=ADMIN, consents=[],
                     spec={"query": {"q": {"type": "string", "max": 100}}}),
        rls_endpoint("wf.api.admin_user_role", "PUT", "v1/admin/users/:id/role", "app.admin_user_role", roles=ADMIN, consents=[],
                     spec={**HID, "body": body({"role": {"type": "string", "enum": ["user", "owner", "moderator", "admin"]}}, ("role",))}),
        rls_endpoint("wf.api.admin_prompts", "GET", "v1/admin/prompts", "app.admin_prompts", roles=staff, consents=[], spec={}),
        rls_endpoint("wf.api.admin_eval_runs_list", "GET", "v1/admin/eval/runs", "app.admin_eval_runs", roles=staff, consents=[], spec={}),
        rls_endpoint("wf.api.admin_kb_sources", "GET", "v1/admin/kb/sources", "app.admin_kb_sources", roles=staff, consents=[],
                     spec={"query": {"jurisdiction": JUR}}),
    ]


def notify_dispatch():
    """Every minute (PLATFORM_SPEC 3.11): new notifications become deliveries for the channels each person allows
    (e-mail to their address, Telegram to the linked chat), each sent with the website's sentence and a link; results
    go back to the database, which retries after 1, 2, 4 and 8 minutes and marks the fifth failure (D-110)."""
    wf = B.WF(ids("wf.notify.dispatch")[0], "wf.notify.dispatch", tags=["schedule", "platform"])
    wf.node("Every minute", "n8n-nodes-base.scheduleTrigger", 1.2,
            {"rule": {"interval": [{"field": "cronExpression", "expression": "* * * * *"}]}}, [0, 0])
    B.pg_node(wf, "Take", "select app.deliveries_take(50) as r", None, [220, 0], on_error=None, retries=2)
    B.code_node(wf, "Compose", "notify_compose.js", [440, 0], subst={"__NOTIFY_TEXTS__": notify_texts()})
    for i, (ch, label) in enumerate((("email", "E-mail"), ("telegram", "Telegram"))):
        y = -150 + 300 * i
        wf.node(f"{label} items", "n8n-nodes-base.code", 2, {"mode": "runOnceForAllItems", "language": "javaScript",
                "jsCode": f"// the deliveries of this channel\nreturn $input.all().filter((i) => i.json.channel === '{ch}');"}, [660, y])
        if ch == "email":
            wf.node("Send e-mail", "n8n-nodes-base.emailSend", 2.1, {
                "fromEmail": "={{ $json.from }}", "toEmail": "={{ $json.email }}", "subject": "={{ $json.subject }}",
                "emailFormat": "text", "text": "={{ $json.body }}", "options": {"appendAttribution": False}},
                [880, y], credentials=SMTP_CRED, onError="continueRegularOutput")
            send = "Send e-mail"
        else:
            B.tg_send(wf, "Send Telegram", [880, y], chat="={{ $json.chat_id }}", text="={{ $json.telegram }}")
            wf.nodes[-1]["onError"] = "continueRegularOutput"
            send = "Send Telegram"
        B.code_node(wf, f"{label} results", "notify_results.js", [1100, y], subst={"__SOURCE__": f"{label} items"})
        B.pg_node(wf, f"Mark {label}", "select app.deliveries_done($1::jsonb) as r", "={{ [ $json.results ] }}", [1320, y], on_error=None)
        wf.link("Compose", f"{label} items")
        wf.link(f"{label} items", send)
        wf.link(send, f"{label} results")
        wf.link(f"{label} results", f"Mark {label}")
    wf.link("Every minute", "Take")
    wf.link("Take", "Compose")
    return wf


def telegram_link():
    """Sub-workflow for the bot (wf.channel.telegram, Firas's file): input {code, chat_id} from "/lier CODE"; output
    {ok, display_name} or {ok: false, error_code: unknown_code | used | expired}. The bot calls it with an Execute
    Workflow node; nothing else here touches the bot (D-110)."""
    wf = B.WF(ids("wf.telegram.link")[0], "wf.telegram.link", tags=["telegram", "platform"])
    wf.node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1, B.tool_inputs([("code", "string"), ("chat_id", "number")]), [0, 0])
    B.pg_node(wf, "Redeem", "select app.telegram_link_redeem($1, $2::bigint) as r",
              "={{ [ String($json.code || ''), Number($json.chat_id) || 0 ] }}", [220, 0], on_error=None)
    wf.node("Result", "n8n-nodes-base.code", 2, {"mode": "runOnceForAllItems", "language": "javaScript",
            "jsCode": "// the redeem answer as it is\nreturn [{ json: $input.first().json.r || { ok: false, error_code: 'failed' } }];"}, [440, 0])
    wf.link("Start", "Redeem")
    wf.link("Redeem", "Result")
    return wf


P11 = [_p4(x) for x in p11_endpoints()] + [notify_dispatch, telegram_link] + [(lambda w=w: w) for w in admin_endpoints()]

# ---------- P12: Yosr's roommate matching, rebuilt on the platform (D-115) ------------------------------------------------
LIFESTYLE_SPEC = {"type": "object", "additionalProperties": False, "properties": {
    "smoking": {"type": "string", "enum": ["yes", "no"]}, "pets": {"type": "string", "enum": ["yes", "no"]},
    "guests": {"type": "string", "enum": ["yes", "no"]}, "quiet_hours": {"type": "string", "enum": ["yes", "no"]},
    "schedule": {"type": "string", "enum": ["early", "late", "irregular"]},
    "cleanliness": {"type": "string", "enum": ["high", "medium", "relaxed"]}}}


def p12_endpoints():
    return [
        ("wf.api.contact_request_create", "POST", "v1/flatmates/:user_id/contact-requests", "contact_request_create", {
            "params": {"user_id": "uuid"}, "body": body({"note": {"type": "string", "maxLength": 500}})}),
        ("wf.api.contact_requests_list", "GET", "v1/me/contact-requests", "contact_requests_list", {"query": {
            "direction": {"type": "enum", "values": ["received", "sent"]}}}),
        ("wf.api.contact_request_decide", "POST", "v1/contact-requests/:id/decision", "contact_request_decide", {
            "params": {"id": "uuid"}, "body": body({"action": {"type": "string", "enum": ["accept", "refuse", "cancel"]}}, ("action",))}),
        ("wf.api.flatmate_apply", "POST", "v1/me/flatmate-profile/apply", "app.flatmate_onboarding_apply", {"body": body({
            "lifestyle": LIFESTYLE_SPEC, "budget_min": {"type": "number", "minimum": 0, "maximum": 1000000},
            "budget_max": {"type": "number", "minimum": 0, "maximum": 1000000},
            "languages": {"type": "array", "maxItems": 7, "items": {"type": "string", "enum": ["ar", "aeb", "fr", "en", "de", "es", "it"]}},
            "headline": {"type": "string", "maxLength": 80}, "seeking": {"type": "string", "enum": ["room", "flatmate", "both"]},
            "areas": {"type": "array", "maxItems": 5, "items": {"type": "string", "minLength": 1, "maxLength": 60}},
            "move_in_from": {"type": "string", "pattern": DATE_RE}, "visible": {"type": "boolean"}})}),
        # D-118: the places of a country's gazetteer (the website's city filter)
        ("wf.api.places_list", "GET", "v1/places", "places_list", {"query": {
            "jurisdiction": JUR, "kind": {"type": "enum", "values": ["city", "district", "neighbourhood", "campus", "station", "landmark"]},
            "lang": {"type": "enum", "values": ["fr", "en", "ar"]}}}),
    ]


def flatmate_explain():
    """POST /v1/flatmates/{user_id}/explanation {language}: the compatibility score of P7 with one or two sentences.
    The model (P12_match_explainer, one call) reads only the factor states, never the other person's answers; code checks
    its sentence (no number but the score, no topic that was not given) and writes its own when the check fails or the
    model is off (D-115, after Yosr's matching, where a model gave the reason)."""
    wf = platform_head("wf.api.flatmate_explain", "POST", "v1/flatmates/:user_id/explanation")
    B.code_node(wf, "Validate", "platform_validate.js", [880, -100], subst={"__SPEC__": json.dumps({
        "params": {"user_id": "uuid"}, "body": body({"language": {"type": "string", "enum": ["fr", "en", "ar"]}})})})
    B.if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    B.pg_node(wf, "Facts", "select api.flatmate_explain_facts($1::uuid, $2::jsonb) as r",
              "={{ [ $json.gw.ctx.user_id, JSON.stringify($json.input) ] }}", [1320, -200], on_error=None)
    B.code_node(wf, "Plan", "explain_plan.js", [1540, -200])
    B.if_node(wf, "Model?", "={{ $json.model }}", [1760, -200])
    wf.node("Explainer input", "n8n-nodes-base.code", 2, {"mode": "runOnceForAllItems", "language": "javaScript",
            "jsCode": "// wf.llm.call input prepared by Plan\nreturn [{ json: $('Plan').first().json.llm }];"}, [1980, -300])
    B.exec_wf(wf, "Explainer", B.LLM_CALL_WF, "wf.llm.call", pos=[2200, -300], on_error="continueRegularOutput")
    B.code_node(wf, "Build result", "explain_result.js", [2420, -200])
    B.respond_tail(wf, 2640)
    wf.link("Gateway ok?", "Validate", 0)
    wf.link("Validate", "Valid?")
    wf.link("Valid?", "Facts", 0)
    wf.link("Valid?", "Envelope", 1)
    wf.link("Facts", "Plan")
    wf.link("Plan", "Model?")
    wf.link("Model?", "Explainer input", 0)
    wf.link("Model?", "Build result", 1)
    wf.link("Explainer input", "Explainer")
    wf.link("Explainer", "Build result")
    wf.link("Build result", "Envelope")
    return wf


FLATMATE_TOOL_WF = ids("wf.flatmate.tool")[0]
FLATMATE_TOOLS = [
    ("my_profile", "What the platform already knows about the person (lifestyle answers, budget, areas, move-in date, "
                   "headline) and the list of what is still missing. No input."),
    ("propose_profile", "Check the answers the person gave, before they confirm them on the page. Input: values, a JSON object "
                        "with only the fields the person answered: lifestyle {smoking, pets, guests, quiet_hours: yes|no; "
                        "schedule: early|late|irregular; cleanliness: high|medium|relaxed}, budget_min, budget_max (numbers), "
                        "areas (list), move_in_from (YYYY-MM-DD), headline, seeking (room|flatmate|both). Returns the checked "
                        "values and errors. Nothing is saved."),
]


def flatmate_tool():
    """The profile agent's tools (one sub-workflow; the person is the request's, never the model's choice)."""
    wf = B.WF(FLATMATE_TOOL_WF, "wf.flatmate.tool", tags=["agent", "platform"])
    wf.node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1, B.tool_inputs([("tool", "string"), ("values", "string"),
            ("user_id", "string")]), [0, 0])
    B.pg_node(wf, "State", "select app.flatmate_onboarding_state(app.try_uuid($1)) as st", "={{ [ $json.user_id || '' ] }}",
              [220, 0], on_error=None)
    B.code_node(wf, "Tool answer", "flatmate_tool_answer.js", [440, 0])
    wf.link("Start", "State")
    wf.link("State", "Tool answer")
    return wf


def flatmate_assistant():
    """POST /v1/me/flatmate-profile/assistant {text}: the profile agent A7 (AI Agent node, P13_flatmate_onboarding, local
    model, Postgres chat memory per person, two tools). It only proposes: the answer carries the checked proposal, and the
    person saves it with POST /v1/me/flatmate-profile/apply (D-115, from Yosr's onboarding agent)."""
    wf = platform_head("wf.api.flatmate_assistant", "POST", "v1/me/flatmate-profile/assistant")
    B.code_node(wf, "Validate", "platform_validate.js", [880, -100], subst={"__SPEC__": json.dumps({"body": body({
        "text": {"type": "string", "minLength": 1, "maxLength": 2000}}, ("text",))})})
    B.if_node(wf, "Valid?", "={{ $json.ok }}", [1100, -100])
    B.pg_node(wf, "Context", "select app.flatmate_onboarding_state($1::uuid) as st, ai.prompt_for('P13_flatmate_onboarding') as p,"
              " (select jsonb_object_agg(key, value #>> '{}') from app.settings where key like 'flatmate_agent.%'"
              " or key in ('llm.default_model', 'llm.keep_alive')) as cfg",
              "={{ [ $json.gw.ctx.user_id ] }}", [1320, -200], on_error=None)
    B.code_node(wf, "Agent input", "flatmate_agent_input.js", [1540, -200])
    B.if_node(wf, "Agent?", "={{ $json.ok }}", [1760, -200])
    wf.node("Profile agent", "@n8n/n8n-nodes-langchain.agent", 3.1, {
        "promptType": "define", "text": "={{ $json.prompt }}", "hasOutputParser": False,
        "options": {"systemMessage": "={{ $json.system }}", "maxIterations": "={{ $json.max_iterations }}",
                    "returnIntermediateSteps": True}}, [1980, -300], onError="continueRegularOutput")
    ai = "$('Agent input').first().json"
    wf.node("Ollama Chat Model", "@n8n/n8n-nodes-langchain.lmChatOllama", 1, {
        "model": "={{ %s.model }}" % ai,
        "options": {"temperature": 0, "think": False, "keepAlive": "={{ %s.keep_alive }}" % ai, "numCtx": "={{ %s.num_ctx }}" % ai,
                    "numPredict": "={{ %s.num_predict }}" % ai}}, [1840, -60], credentials=B.OLLAMA_CRED)
    wf.node("Chat memory", "@n8n/n8n-nodes-langchain.memoryPostgresChat", 1.3, {
        "sessionIdType": "customKey", "sessionKey": "={{ %s.session_id }}" % ai, "tableName": "agent_memory.chat_histories",
        "contextWindowLength": "={{ %s.memory_turns }}" % ai}, [1980, -60], credentials=B.PG_CRED)
    for i, (name, desc) in enumerate(FLATMATE_TOOLS):
        fields = [("tool", "string", name),
                  ("values", "string", "={{ $fromAI('values', 'JSON object with only the fields the person answered', 'string') }}"
                   if name == "propose_profile" else ""),
                  ("user_id", "string", "={{ %s.user_id }}" % ai)]
        wf.node(name, "@n8n/n8n-nodes-langchain.toolWorkflow", 2.2, {
            "description": desc, "source": "database",
            "workflowId": {"__rl": True, "value": FLATMATE_TOOL_WF, "mode": "id", "cachedResultName": "wf.flatmate.tool"},
            "workflowInputs": B.tool_mapping(fields)}, [2120 + 140 * i, -60])
        wf.ai_link(name, "Profile agent", "ai_tool")
    # what the person wrote earlier in this conversation: a proposed amount, place or date must be in it
    B.pg_node(wf, "Session text", "select substring(message->>'content' from '<message>\\n(.*)\\n</message>') as text"
              " from agent_memory.chat_histories where session_id = $1 and message->>'type' = 'human' order by id desc limit 20",
              "={{ [ $('Agent input').first().json.session_id ] }}", [2200, -300], on_error=None, always_output=True)
    B.code_node(wf, "Check answer", "flatmate_agent_output.js", [2420, -300])
    B.respond_tail(wf, 2640)
    wf.link("Gateway ok?", "Validate", 0)
    wf.link("Validate", "Valid?")
    wf.link("Valid?", "Context", 0)
    wf.link("Valid?", "Envelope", 1)
    wf.link("Context", "Agent input")
    wf.link("Agent input", "Agent?")
    wf.link("Agent?", "Profile agent", 0)
    wf.link("Agent?", "Envelope", 1)
    for a, b in (("Profile agent", "Session text"), ("Session text", "Check answer"), ("Check answer", "Envelope")):
        wf.link(a, b)
    wf.ai_link("Ollama Chat Model", "Profile agent", "ai_languageModel")
    wf.ai_link("Chat memory", "Profile agent", "ai_memory")
    return wf


P12 = [_p4(x) for x in p12_endpoints()] + [flatmate_explain, flatmate_tool, flatmate_assistant]


WORKFLOWS = [me_get, profiles_get, notifications_list, notifications_read,
             search_v2, listings_public, favourite_put, favourite_delete, favourites_list, listing_change_cancel,
             listings_submit, me_listings, listings_submit_v2, listing_trust_job] + P4 + P5 + P6 + P7 + P8 + P9 + P10 + P11 + P12
