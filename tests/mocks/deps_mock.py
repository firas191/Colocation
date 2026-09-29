"""Stand-ins for Ollama (/api/tags) and the object-storage health endpoint,
used ONLY in the cloud sandbox where the real services cannot be downloaded.
They exercise the n8n health workflow's logic; they prove nothing about the
real services. Results obtained with them are labelled "mock" in TEST_REPORT.md.

    python3 deps_mock.py ollama 11434 [--no-model]
    python3 deps_mock.py s3 3903
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

kind, port = sys.argv[1], int(sys.argv[2])
no_model = "--no-model" in sys.argv


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if kind == "ollama" and self.path == "/api/tags":
            models = [] if no_model else [{"name": "bge-m3:latest", "model": "bge-m3:latest"}]
            body, ctype = json.dumps({"models": models}).encode(), "application/json"
        elif kind == "s3" and self.path == "/health":
            body, ctype = b"Garage is fully operational (MOCK)", "text/plain"
        else:
            self.send_response(404); self.end_headers(); return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


HTTPServer(("127.0.0.1", port), H).serve_forever()
