"""Stand-ins for Ollama, the object-storage health endpoint and Text Embeddings
Inference, used ONLY in the cloud sandbox where the real services cannot be
downloaded. They exercise the n8n workflows' plumbing (requests, batching,
offsets, storage); they prove nothing about the real services or about
retrieval quality. Results obtained with them are labelled "mock" in
docs/TEST_REPORT.md.

    python3 deps_mock.py ollama 11434 [--no-model]
    python3 deps_mock.py s3 3903
    python3 deps_mock.py tei 8090 [--char-offsets] [--embed-delay-ms N]

Mock chat (/api/chat, only for "ollama"): answers P1 router and P2 profile requests with a
fixed keyword rule, enough to exercise wf.llm.call, the evaluation runner and the endpoints.
Markers in the user's message drive failure paths: [mock:invalid-once] (bad JSON, then valid
on retry), [mock:invalid] (bad JSON twice), [mock:schema] (JSON that breaks the schema),
[mock:down] (HTTP 500), [mock:leak] (repeats the system prompt's reference code),
[mock:slow] (5 s delay), [mock:thinking] (empty answer after thinking). Unknown models get 404 like Ollama. GET /_mock/chat/last returns
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
    kind = "P2" if ("budget_max_minor" in props or "budget_max" in props) else "P1"
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
    if "[mock:invalid]" in low or ("[mock:invalid-once]" in low and not retry):
        content = "Sure! Here is the answer: {intent: search"
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
    return 200, {"model": body.get("model"), "message": {"role": "assistant", "content": content}, "done": True,
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

    def do_GET(self):
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
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
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
