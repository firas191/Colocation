"""Stand-ins for Ollama, the object-storage health endpoint and Text Embeddings
Inference, used ONLY in the cloud sandbox where the real services cannot be
downloaded. They exercise the n8n workflows' plumbing (requests, batching,
offsets, storage); they prove nothing about the real services or about
retrieval quality. Results obtained with them are labelled "mock" in
docs/TEST_REPORT.md.

    python3 deps_mock.py ollama 11434 [--no-model]
    python3 deps_mock.py s3 3903
    python3 deps_mock.py tei 8090 [--char-offsets] [--embed-delay-ms N]

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
stats = {"in_flight": 0, "max_in_flight": 0, "embed_requests": 0}
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
        if self.path == "/_mock/reset":
            with stats_lock:
                stats.update(max_in_flight=0, embed_requests=0)
            return self.reply(200, stats)
        if kind == "ollama" and self.path == "/api/tags":
            models = [] if no_model else [{"name": "bge-m3:latest", "model": "bge-m3:latest"}]
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
