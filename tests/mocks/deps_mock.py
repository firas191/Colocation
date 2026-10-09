"""Stand-ins for Ollama, the object-storage health endpoint and Text Embeddings
Inference, used ONLY in the cloud sandbox where the real services cannot be
downloaded. They exercise the n8n workflows' plumbing (requests, batching,
offsets, storage); they prove nothing about the real services or about
retrieval quality. Results obtained with them are labelled "mock" in
docs/TEST_REPORT.md.

    python3 deps_mock.py ollama 11434 [--no-model]
    python3 deps_mock.py s3 3903
    python3 deps_mock.py tei 8090 [--char-offsets] [--embed-delay-ms N]
    python3 deps_mock.py telegram 8098

Mock Telegram Bot API ("telegram"): getUpdates with long polling (up to 2 s here), sendMessage, sendChatAction,
answerCallbackQuery, editMessageText, getFile and file downloads under /file/bot<token>/. Tests queue user updates with
POST /_mock/telegram/updates, register file bytes with POST /_mock/telegram/files/<file_id>, and read what the bot
sent with GET /_mock/telegram/sent?since=<n>. Any token is accepted.

Mock chat (/api/chat, only for "ollama"): answers P1 router, P2 profile, P3 listing and P7 photo requests with a
fixed keyword rule, enough to exercise wf.llm.call, the evaluation runner and the endpoints.
Markers in the user's message drive failure paths: [mock:invalid-once] (bad JSON, then valid
on retry), [mock:invalid] (bad JSON twice), [mock:schema] (JSON that breaks the schema),
[mock:down] (HTTP 500), [mock:leak] (repeats the system prompt's reference code),
[mock:slow] (5 s delay), [mock:thinking] (empty answer after thinking), [mock:long] (answer cut at the
token limit, done_reason "length"), [mock:scale] (P3: rent
multiplied by 1000, a scale error for the range check). Unknown models get 404 like Ollama. GET /_mock/chat/last returns
the last chat request body.

GET /_mock/stats returns the highest number of /embed or /api/embed requests
that were in flight at the same time (sandbox evidence for F-033).

Mock embeddings: a bag of hashed lower-case words in 1024 dimensions, L2
normalised, so texts sharing words are close. Mock tokenizer: one token per run
of non-space characters, offsets in UTF-8 bytes (or characters with
--char-offsets) to exercise both offset conventions.
"""
import hashlib
import json
import math
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

kind, port = sys.argv[1], int(sys.argv[2])
no_model = "--no-model" in sys.argv
char_offsets = "--char-offsets" in sys.argv
embed_delay = int(sys.argv[sys.argv.index("--embed-delay-ms") + 1]) / 1000 if "--embed-delay-ms" in sys.argv else 0
stats = {"in_flight": 0, "max_in_flight": 0, "embed_requests": 0, "chat_requests": 0}
CHAT_MODELS = {"qwen3.5:4b", "granite4.2:3b", "phi4-mini:3.8b"}
last_chat = {}
stats_lock = threading.Lock()
tg = {"updates": [], "next_id": int(time.time()), "sent": [], "files": {}, "msg_id": 1}  # ids never restart, as on Telegram
tg_cond = threading.Condition()


def tg_method(path):
    m = re.match(r"^/bot[^/]+/(\w+)", path.split("?")[0])
    return m.group(1) if m else None


def embed_begin():
    with stats_lock:
        stats["in_flight"] += 1
        stats["embed_requests"] += 1
        stats["max_in_flight"] = max(stats["max_in_flight"], stats["in_flight"])
    time.sleep(embed_delay)


def embed_end():
    with stats_lock:
        stats["in_flight"] -= 1


def embed(text: str) -> list[float]:
    v = [0.0] * 1024
    for w in re.findall(r"\w+", text.lower()):
        h = int.from_bytes(hashlib.sha256(w.encode()).digest()[:4], "big")
        v[h % 1024] += 1.0
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def p7_answer(msgs, props):
    """P7 (photo analysis): the mock cannot see, so the photo's mean colour picks the answer (tests draw plain photos).
    reddish: a person in view and a note about her (the checks must drop it); greenish: invalid JSON on every attempt;
    dark: little visible; anything else: a furnished bedroom. No image at all: not_a_room."""
    import base64
    import io as _io
    imgs = next((m.get("images") for m in msgs if m["role"] == "user" and m.get("images")), None)
    v2 = "field_confidence" in props
    nv = "not_visible" if v2 else None
    out = {"room_type": "bedroom", "beds": 1, "bed_kinds": ["double"], "furniture": ["wardrobe", "desk"],
           "appliances": ["tv", "air_conditioning"], "bathroom_fixtures": [], "windows": 1, "natural_light": "good",
           "condition": "good", "condition_signs": [], "furnished": "yes", "readable_text": False, "people_visible": False}
    desc = "A bright bedroom with a double bed, a wardrobe and a desk."
    issues = []
    if not imgs:
        out.update(room_type="not_a_room", beds=0, bed_kinds=[], furniture=[], appliances=[], windows=0, furnished="no")
        desc, issues = "No photo.", ["no image"]
    else:
        from PIL import Image, ImageStat
        r, g, b = ImageStat.Stat(Image.open(_io.BytesIO(base64.b64decode(imgs[0]))).convert("RGB")).mean
        if g > r + 40 and g > b + 40:
            return None
        if r > g + 40 and r > b + 40:
            out["people_visible"] = True
            desc, issues = "A woman sits on the bed next to the wardrobe.", ["a woman is sitting on the bed"]
        elif max(r, g, b) < 40:
            out.update(beds=nv or 0, bed_kinds=[], furniture=[], appliances=[], windows=nv or 0, natural_light=nv or "none",
                       condition=nv or "fair", furnished=nv or "no", room_type="other_room")
            desc, issues = "A very dark room.", ["photo too dark"]
    if v2:
        out["issues"] = issues
        out["field_confidence"] = {k: 0.8 for k in ("room_type", "beds", "windows", "furnished") if out[k] != "not_visible"}
    else:
        out = {"description": desc, **out}
    return json.dumps(out, ensure_ascii=False)


def _msg_text(m):
    c = m.get("content") or ""
    if isinstance(c, list):
        c = " ".join(x.get("text", "") for x in c if isinstance(x, dict))
    mm = re.search(r"<message>\n?(.*?)\n?</message>", c, re.S)
    return (mm.group(1) if mm else c).strip()


def agent_answer(body):
    """Mock of the model inside the A3 Match agent (an /api/chat call with tools, D-084). It cannot reason: it calls
    search_listings with the user's text (with the previous user message appended for a follow-up such as "moins
    cher" or "cheaper"), listing_details for "numéro N" / "the second one", and after a tool answers with a sentence
    built from the tool result. Markers: [mock:agentdown] HTTP 500, [mock:notool] answers without a tool,
    [mock:badnumber] adds a price that no tool gave, [mock:loop] calls the search again after every result,
    [mock:markdown] answers with a long Markdown list."""
    msgs = body.get("messages") or []
    users = [m for m in msgs if m.get("role") == "user"]
    cur = _msg_text(users[-1]) if users else ""
    prev = [_msg_text(m) for m in users[:-1]]
    low = cur.lower()
    if "[mock:agentdown]" in low:
        return 500, {"error": "mock failure"}
    last_user = max(i for i, m in enumerate(msgs) if m.get("role") == "user") if users else -1
    tool_msgs = [m for m in msgs[last_user + 1:] if m.get("role") == "tool"]
    en = bool(re.search(r"\b(room|looking|cheaper|the|second|near)\b", low))

    def call(name, args):
        return {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": name, "arguments": args}}]}

    if tool_msgs and "[mock:loop]" not in low:
        try:
            obs = json.loads(tool_msgs[-1].get("content") or "{}")
        except ValueError:
            obs = {}
        if isinstance(obs, list):                 # the workflow tool returns its items as a list
            obs = obs[0] if obs and isinstance(obs[0], dict) else {}
        if isinstance(obs.get("results"), list):
            n = obs.get("found") or 0
            text = (f"I found {n} listings." if en else f"J'ai trouvé {n} annonces.")
            if obs["results"]:
                r = obs["results"][0]
                text += (f" Number 1 is {r.get('rent')} {r.get('currency')}." if en else f" La 1 est à {r.get('rent')} {r.get('currency')}.")
        elif obs.get("found") is True:
            text = (f"Listing {obs.get('number')}: {obs.get('rent')} {obs.get('currency')}, {obs.get('neighbourhood') or obs.get('city')}."
                    if not en else f"Listing {obs.get('number')}: {obs.get('rent')} {obs.get('currency')}.")
        else:
            text = "I cannot find that number." if en else "Je ne trouve pas ce numéro."
        if "[mock:badnumber]" in low:
            text += " La moins chère est à 999 DT."
        if "[mock:markdown]" in low and isinstance(obs.get("results"), list) and obs["results"]:
            r = obs["results"][0]
            text = ("Voici les résultats de votre recherche :\n\n" + "\n".join(
                f"*   **Résultat {i}** : une chambre à {r.get('city')}, {r.get('rent')} {r.get('currency')} par mois, "
                f"proche de ce que vous cherchez et disponible rapidement." for i in range(1, 6)))
        return 200, {"role": "assistant", "content": text}
    if "[mock:notool]" in low:
        return 200, {"role": "assistant", "content": "Je peux vous aider à chercher une chambre."}
    dm = re.search(r"(?:num[ée]ro|number|n°)\s*(\d+)", low)
    if dm or re.search(r"deuxi[eè]me|second", low):
        return 200, call("listing_details", {"number": int(dm.group(1)) if dm else 2})
    request = cur
    if prev and re.search(r"moins cher|cheaper|plus proche|closer", low):
        request = f"{cur} {prev[-1]}"
    return 200, call("search_listings", {"request": request})


def agent_stream(body, message):
    """Ollama's streaming /api/chat answer (NDJSON), as the n8n Ollama Chat Model node asks for it."""
    n_in = sum(len(str(m.get("content") or "")) for m in body.get("messages") or []) // 4
    chunk = {"model": body.get("model"), "created_at": "2026-10-09T00:00:00Z", "message": message, "done": False}
    end = {"model": body.get("model"), "created_at": "2026-10-09T00:00:01Z", "message": {"role": "assistant", "content": ""},
           "done": True, "done_reason": "stop", "total_duration": 120_000_000, "load_duration": 1_000_000,
           "prompt_eval_count": n_in, "eval_count": len(json.dumps(message)) // 4, "eval_duration": 90_000_000}
    return (json.dumps(chunk) + "\n" + json.dumps(end) + "\n").encode()


def chat_answer(body):
    """(status, response body) for a mock /api/chat call."""
    msgs = body.get("messages") or []
    system = msgs[0]["content"] if msgs else ""
    user = next((m["content"] for m in msgs if m["role"] == "user"), "")
    m = re.search(r"<message>\n(.*)\n</message>", user, re.S)
    text = m.group(1) if m else user
    low = text.lower()
    retry = len(msgs) > 2
    fmt = body.get("format") or {}
    props = fmt.get("properties") or {}
    kind = ("P7" if "people_visible" in props else "P3" if "rent_scope" in props
            else "P2" if ("budget_max_minor" in props or "budget_max" in props) else "P1")
    major = "budget_max" in props          # P2 v3: amounts in main units (D-066)
    if body.get("model") not in CHAT_MODELS:
        return 404, {"error": f"model \"{body.get('model')}\" not found, try pulling it first"}
    if "[mock:down]" in low:
        return 500, {"error": "mock failure"}
    if "[mock:slow]" in low:
        time.sleep(5)
    if "[mock:thinking]" in low:     # a model that thinks and leaves the answer empty (F-048)
        return 200, {"model": body.get("model"), "message": {"role": "assistant", "content": "", "thinking": "Let me think. " * 40},
                     "done": True, "prompt_eval_count": 50, "eval_count": 200, "total_duration": 120_000_000}
    if "[mock:long]" in low:          # an answer cut at num_predict, on both attempts (F-058)
        return 200, {"model": body.get("model"), "message": {"role": "assistant", "content": '{"kind": "room", "issues": ["a very long note'},
                     "done": True, "done_reason": "length", "prompt_eval_count": 50, "eval_count": 500, "total_duration": 120_000_000}
    if kind == "P7":
        content = p7_answer(msgs, props)
        if content is None:
            content = "I see a room: {room_type: bedroom"
    elif "[mock:invalid]" in low or ("[mock:invalid-once]" in low and not retry):
        content = "Sure! Here is the answer: {intent: search"
    elif kind == "P3":
        out = {"kind": "room", "rent_amount": None, "rent_currency": None, "rent_period": None, "rent_scope": None,
               "deposit_amount": None, "deposit_currency": None, "bills_included": None, "available_from": None,
               "bedrooms": None, "furnished": None, "amenities": [], "house_rules": {}, "address_text": None,
               "city": None, "neighbourhood": None, "issues": [], "field_confidence": {}}
        mm = re.search(r"(\d+)(?:[.,]000)?\s*(dt|dinars?|€|eur|euros?|£)", low)
        if mm:
            cur = {"dt": "TND", "dinar": "TND", "dinars": "TND", "€": "EUR", "eur": "EUR", "euro": "EUR", "euros": "EUR", "£": "GBP"}[mm.group(2)]
            amount = int(mm.group(1)) * (1000 if "[mock:scale]" in low else 1)
            out.update(rent_amount=amount, rent_currency=cur, rent_period="week" if re.search(r"pw|per week|/semaine", low) else "month",
                       rent_scope="per_room", field_confidence={"rent_amount": 0.9})
        sm = re.search(r"s\+(\d)", low)
        if sm:
            out["bedrooms"] = int(sm.group(1))
        if re.search(r"meublée?|furnished|mfarech", low):
            out["furnished"] = True
        if re.search(r"charges comprises|\bcc\b|bills included", low):
            out["bills_included"] = True
        if "wifi" in low:
            out["amenities"].append("wifi")
        if re.search(r"non[- ]fumeur|no smoking", low):
            out["house_rules"]["smoking"] = "no"
        if "[mock:schema]" in low:
            out["rent_amount"] = "cheap"
        if "[mock:date]" in low:          # a model that fills in a date, said in the text or not (D-083)
            out["available_from"] = "2026-11-01"
        pl = re.search(r"\[mock:place=([^\]]+)\]", text)
        if pl:
            out["neighbourhood"] = pl.group(1)
        content = json.dumps(out, ensure_ascii=False)
    elif kind == "P1":
        if "[mock:schema]" in low:
            intent = "buy_house"
        elif re.search(r"contrat|agreement|convention", low):
            intent = "generate_document"
        elif re.search(r"arnaque|scam", low):
            intent = "report_problem"
        elif re.search(r"caution|deposit|préavis|notice", low):
            intent = "legal_question"
        elif re.search(r"à louer|a louer|flatmate|colocataire", low):
            intent = "post_listing"
        elif re.search(r"cherche|looking for|room|chambre|n7eb", low):
            intent = "search_listings"
        else:
            intent = "smalltalk_or_unsupported"
        arabic = bool(re.search(r"[\u0600-\u06ff]", text))
        lang = "ar" if arabic else ("fr" if re.search(r"\b(je|une|chambre|le|la)\b", low) else "en")
        unclear = "[mock:unclear]" in low
        canary = re.search(r"RTR-CANARY-\w+", system)
        q = (canary.group(0) if canary else None) if "[mock:leak]" in low else ("Pouvez-vous préciser ?" if unclear else None)
        out = {"intent": intent, "language": lang, "script": "arabic" if arabic else "latin",
               "jurisdiction_hint": "TN" if re.search(r"tunis|ariana|ennasr|marsa|dt\b|dinar", low) else None,
               "confidence": 0.3 if unclear else 0.9, "needs_clarification": unclear, "clarifying_question": q}
        content = json.dumps(out, ensure_ascii=False)
    else:
        jur = re.search(r"Account jurisdiction: ([A-Z]{2})", user)
        out = {"jurisdiction_code": None, "budget_min_minor": None, "budget_max_minor": None, "currency": None,
               "budget_period": None, "anchor_label": None, "max_commute_min": None, "move_in_from": None,
               "min_stay_months": None, "declared_preferences": {}, "languages": [], "unparsed": [], "field_confidence": {}}
        mm = re.search(r"(\d+)\s*(dt|dinars?|€|eur|euros?|£)", low)
        if mm:
            cur = {"dt": "TND", "dinar": "TND", "dinars": "TND", "€": "EUR", "eur": "EUR", "euro": "EUR", "euros": "EUR", "£": "GBP"}[mm.group(2)]
            out.update(budget_max_minor=int(mm.group(1)) * (1000 if cur == "TND" else 100), currency=cur, budget_period="month")
        if "[mock:schema]" in low:
            out["budget_max_minor"] = "cheap"
        if "[mock:gender]" in low:
            out["declared_preferences"]["gender"] = "female"   # not allowed by the schema
        if "[mock:nocurrency]" in low:
            out.update(budget_max_minor=450000, currency=None, budget_period=None)
        if major:
            exp = 3 if out["currency"] == "TND" or (out["currency"] is None and "[mock:nocurrency]" in low) else 2
            for k in ("budget_min_minor", "budget_max_minor"):
                v = out.pop(k)
                out[k[:-6]] = v / 10 ** exp if isinstance(v, int) else v
            out = {"jurisdiction_code": out.pop("jurisdiction_code"), "budget_min": out.pop("budget_min"),
                   "budget_max": out.pop("budget_max"), **out}
        pm = re.search(r"(?:près de|pres de|near) ([\w' -]+?)(?:,|$)", text, re.I)
        if pm:
            out["anchor_label"] = pm.group(1).strip()
        if re.search(r"non[- ]fumeur|non-smoker", low):
            out["declared_preferences"]["smoking"] = "no"
        if re.search(r"j'ai un chat|i have a cat", low):
            out["declared_preferences"]["pets"] = "yes"
        if re.search(r"tunis|ariana|ennasr|marsa", low):
            out["jurisdiction_code"] = "TN"
        content = json.dumps(out, ensure_ascii=False)
    n_in = sum(len(m_["content"]) for m_ in msgs) // 4
    return 200, {"model": body.get("model"), "message": {"role": "assistant", "content": content}, "done": True, "done_reason": "stop",
                 "prompt_eval_count": n_in, "eval_count": len(content) // 4, "total_duration": 120_000_000,
                 "load_duration": 1_000_000, "eval_duration": 90_000_000, "mock": True}


def tokenize(text: str):
    out = []
    for m in re.finditer(r"\S+", text):
        if char_offsets:
            s, e = m.start(), m.end()
        else:
            s, e = len(text[:m.start()].encode()), len(text[:m.end()].encode())
        out.append({"id": 1, "text": m.group(0), "special": False, "start": s, "stop": e})
    return out


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def tg_get(self):
        from urllib.parse import parse_qs, urlsplit
        u = urlsplit(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path == "/_mock/telegram/sent":
            with tg_cond:
                return self.reply(200, tg["sent"][int(q.get("since", 0)):])
        m = re.match(r"^/file/bot[^/]+/(.+)$", u.path)
        if m:
            fid = m.group(1).rsplit("/", 1)[-1].split(".")[0]
            data = tg["files"].get(fid)
            return self.reply(200, data, "application/octet-stream") if data else self.reply(404, {"ok": False})
        if tg_method(u.path) == "getUpdates":
            offset = int(q.get("offset", 0) or 0)
            deadline = time.time() + min(float(q.get("timeout", 0) or 0), 2.0)
            with tg_cond:
                while True:
                    tg["updates"] = [x for x in tg["updates"] if x["update_id"] >= offset]
                    if tg["updates"] or time.time() >= deadline:
                        return self.reply(200, {"ok": True, "result": list(tg["updates"])})
                    tg_cond.wait(max(0.0, deadline - time.time()))
        return self.tg_call(tg_method(u.path), q)

    def tg_call(self, method, params):
        if not method:
            return self.reply(404, {"ok": False, "description": "Not Found"})
        with tg_cond:
            tg["sent"].append({"method": method, "params": params})
            tg["msg_id"] += 1
            mid = tg["msg_id"]
        if method == "getFile":
            fid = params.get("file_id")
            return self.reply(200, {"ok": True, "result": {"file_id": fid, "file_path": f"photos/{fid}.jpg",
                                                           "file_size": len(tg["files"].get(fid, b""))}})
        if method in ("sendMessage", "editMessageText", "sendPhoto"):
            return self.reply(200, {"ok": True, "result": {"message_id": mid, "chat": {"id": params.get("chat_id")},
                                                           "date": int(time.time()), "text": params.get("text")}})
        return self.reply(200, {"ok": True, "result": True})

    def do_GET(self):
        if kind == "telegram":
            return self.tg_get()
        if self.path == "/_mock/stats":
            return self.reply(200, stats)
        if self.path == "/_mock/chat/last":
            return self.reply(200, last_chat)
        if self.path == "/_mock/reset":
            with stats_lock:
                stats.update(max_in_flight=0, embed_requests=0, chat_requests=0)
            return self.reply(200, stats)
        if kind == "ollama" and self.path == "/api/tags":
            models = [] if no_model else [{"name": n, "model": n} for n in ["bge-m3:latest", *sorted(CHAT_MODELS)]]
            return self.reply(200, {"models": models})
        if kind == "s3" and self.path == "/health":
            return self.reply(200, b"Garage is fully operational (MOCK)", "text/plain")
        if kind == "tei" and self.path == "/health":
            return self.reply(200, b"", "text/plain")
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if kind == "telegram":
            if self.path.startswith("/_mock/telegram/files/"):
                tg["files"][self.path.rsplit("/", 1)[-1]] = raw
                return self.reply(200, {"ok": True})
            if self.path == "/_mock/telegram/updates":
                with tg_cond:
                    tg["next_id"] += 1
                    upd = {"update_id": tg["next_id"], **json.loads(raw)}
                    tg["updates"].append(upd)
                    tg_cond.notify_all()
                return self.reply(200, upd)
            ctype = self.headers.get("Content-Type", "")
            if "json" in ctype:
                params = json.loads(raw or b"{}")
            else:
                from urllib.parse import parse_qs
                params = {k: v[0] for k, v in parse_qs(raw.decode(errors="replace")).items()}
            return self.tg_call(tg_method(self.path), params)
        body = json.loads(raw or b"{}")
        if kind == "ollama" and self.path == "/api/embed":
            inputs = body.get("input")
            inputs = [inputs] if isinstance(inputs, str) else inputs
            embed_begin()
            try:
                return self.reply(200, {"model": body.get("model"), "embeddings": [embed(t) for t in inputs], "mock": True})
            finally:
                embed_end()
        if kind == "ollama" and self.path == "/api/chat":
            with stats_lock:
                stats["chat_requests"] += 1
            last_chat.clear()
            last_chat.update(body)
            if body.get("tools"):                     # the A3 Match agent (AI Agent node, streaming)
                if body.get("model") not in CHAT_MODELS:
                    return self.reply(404, {"error": f"model \"{body.get('model')}\" not found, try pulling it first"})
                code, msg = agent_answer(body)
                if code != 200:
                    return self.reply(code, msg)
                if body.get("stream", True):
                    return self.reply(200, agent_stream(body, msg), "application/x-ndjson")
                return self.reply(200, {"model": body.get("model"), "message": msg, "done": True, "done_reason": "stop",
                                        "prompt_eval_count": 50, "eval_count": 20})
            code, ans = chat_answer(body)
            return self.reply(code, ans)
        if kind == "tei" and self.path == "/embed":
            inputs = body.get("inputs")
            inputs = [inputs] if isinstance(inputs, str) else inputs
            embed_begin()
            try:
                return self.reply(200, [embed(t) for t in inputs])
            finally:
                embed_end()
        if kind == "tei" and self.path == "/tokenize":
            inputs = body.get("inputs")
            inputs = [inputs] if isinstance(inputs, str) else inputs
            return self.reply(200, [tokenize(t) for t in inputs])
        self.reply(404, {"error": "not found"})


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True


Server(("127.0.0.1", port), H).serve_forever()
