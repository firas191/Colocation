"""SMTP sink with a small part of Mailpit's HTTP API, for the cloud sandbox only (Mailpit runs in docker compose on
the owner's PC). The website's e2e tests read the sign-up and reset mails through the same calls on both:

    python3 mail_sink.py 1025 8025
    GET    /api/v1/messages            {"total", "messages": [{"ID", "To": [{"Address"}], "Subject", "Created"}]}, newest first
    GET    /api/v1/message/<ID>        {"ID", "Subject", "Text", "HTML", "To"}
    DELETE /api/v1/messages            delete all
"""
import email
import email.policy
import json
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from aiosmtpd.controller import Controller

smtp_port, http_port = int(sys.argv[1]), int(sys.argv[2])
messages = []
lock = threading.Lock()


class Handler:
    async def handle_DATA(self, server, session, envelope):
        msg = email.message_from_bytes(envelope.content, policy=email.policy.default)
        text = msg.get_body(preferencelist=("plain",))
        html = msg.get_body(preferencelist=("html",))
        with lock:
            messages.insert(0, {"ID": uuid.uuid4().hex, "Subject": str(msg["subject"] or ""),
                                "To": [{"Name": "", "Address": a} for a in envelope.rcpt_tos],
                                "Created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                "Text": text.get_content() if text else "", "HTML": html.get_content() if html else ""})
        return "250 OK"


class Api(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        with lock:
            if self.path.startswith("/api/v1/messages"):
                return self.send(200, {"total": len(messages), "messages": [
                    {k: m[k] for k in ("ID", "Subject", "To", "Created")} for m in messages]})
            if self.path.startswith("/api/v1/message/"):
                mid = self.path.rsplit("/", 1)[1]
                m = next((x for x in messages if x["ID"] == mid), None)
                return self.send(200, m) if m else self.send(404, {"error": "not found"})
        self.send(404, {"error": "not found"})

    def do_DELETE(self):
        with lock:
            messages.clear()
        self.send(200, {})


Controller(Handler(), hostname="127.0.0.1", port=smtp_port).start()
ThreadingHTTPServer(("127.0.0.1", http_port), Api).serve_forever()
