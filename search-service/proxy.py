import hmac
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = "http://127.0.0.1:8081"
TOKEN = os.environ.get("SEARXNG_TOKEN", "")
PORT = int(os.environ.get("PORT", "10000"))


class Handler(BaseHTTPRequestHandler):
    server_version = "ARGUSSearch/1.0"

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/health":
            self.health()
            return
        if parsed.path != "/search":
            self.reply(404, {"error": "not found"})
            return
        supplied = self.headers.get("Authorization", "")
        expected = f"Bearer {TOKEN}"
        if not TOKEN or not hmac.compare_digest(supplied, expected):
            self.reply(401, {"error": "unauthorized"})
            return
        params = urllib.parse.parse_qs(parsed.query)
        query = (params.get("q") or [""])[0].strip()
        if not query or len(query) > 500:
            self.reply(400, {"error": "q is required and must be at most 500 characters"})
            return
        allowed = {"q", "categories", "language", "time_range", "safesearch", "pageno"}
        clean = {key: values[-1] for key, values in params.items() if key in allowed}
        clean["format"] = "json"
        self.forward("/search?" + urllib.parse.urlencode(clean))

    def health(self):
        try:
            with urllib.request.urlopen(UPSTREAM + "/", timeout=3) as response:
                healthy = 200 <= response.status < 500
            self.reply(200 if healthy else 503, {"ok": healthy})
        except Exception:
            self.reply(503, {"ok": False})

    def forward(self, path):
        try:
            request = urllib.request.Request(UPSTREAM + path, headers={"Accept": "application/json", "User-Agent": "ARGUS-Search-Gateway/1.0"})
            with urllib.request.urlopen(request, timeout=20) as response:
                body = response.read(2_000_000)
                self.send_response(response.status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as error:
            self.reply(error.code, {"error": "search upstream error"})
        except Exception:
            self.reply(502, {"error": "search upstream unavailable"})

    def reply(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print("search-gateway:", fmt % args, flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
