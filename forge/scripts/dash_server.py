#!/usr/bin/env python3
"""Forge dashboard server: the live dashboard on 127.0.0.1, plus two writes from the page (a ticket
detail and a message for the orchestrator). Stdlib only.

Run as `dash_server.py <project-root>`. It exits when .claude/forge/dashboard.json is removed or
replaced (see stop), or after MAX_HOURS. Writes need the token the served page carries, and the
Host header must be localhost, which blocks other sites and DNS rebinding."""
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import forge_lib as F  # noqa: E402
import render_dashboard as R  # noqa: E402

MAX_BODY = 20000
MAX_HOURS = 12
JSON = "application/json"
TEXT = "text/plain; charset=utf-8"


def info_path(root):
    return os.path.join(F.forge_dir(root), "dashboard.json")


def read_info(root):
    try:
        with open(info_path(root), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def alive(info):
    if not info:
        return False
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/fragment" % info["port"], timeout=1) as r:
            return r.status == 200
    except OSError:
        return False


def make_handler(root, token):
    class Handler(BaseHTTPRequestHandler):
        server_version = "Forge"

        def log_message(self, *args):  # keep the terminal quiet
            pass

        def send(self, code, body, ctype="text/html; charset=utf-8"):
            data = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def host_ok(self):
            port = self.server.server_address[1]
            return self.headers.get("Host") in ("127.0.0.1:%d" % port, "localhost:%d" % port)

        def do_GET(self):
            if not self.host_ok():
                return self.send(403, "forbidden", TEXT)
            st = F.load(root)
            if st is None:
                return self.send(404, "forge is not initialised here", TEXT)
            path = urlparse(self.path).path
            if path == "/":
                live = {"port": self.server.server_address[1], "token": token}
                return self.send(200, R.render_html(st, live=live))
            if path == "/fragment":
                return self.send(200, R.render_live(st, live=True))
            self.send(404, "not found", TEXT)

        def do_POST(self):
            if not self.host_ok() or self.headers.get("X-Forge-Token") != token:
                return self.send(403, '{"error":"forbidden"}', JSON)
            if self.path not in ("/api/detail", "/api/prompt"):
                return self.send(404, '{"error":"not found"}', JSON)
            try:
                size = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                size = 0
            if not 0 < size <= MAX_BODY:
                return self.send(400, '{"error":"bad body"}', JSON)
            try:
                data = json.loads(self.rfile.read(size).decode("utf-8"))
            except ValueError:
                return self.send(400, '{"error":"bad json"}', JSON)
            text = str(data.get("text", "")).strip()[:2000]
            if not text:
                return self.send(400, '{"error":"empty"}', JSON)
            ticket = str(data.get("ticket") or "")
            missing = []

            def go(st):
                if self.path == "/api/detail":
                    t = st["tickets"].get(ticket)
                    if t is None:
                        missing.append(ticket)
                        return
                    t.setdefault("details", []).append({"t": F.now(), "text": text})
                    F.log(st, "detail added to %s" % ticket)
                else:
                    st["inbox"].append({"t": F.now(), "text": text, "ticket": ticket or None, "read": False})
                    F.log(st, "message from dashboard")
            F.update(root, go)
            if missing:
                return self.send(404, '{"error":"unknown ticket"}', JSON)
            self.send(200, '{"ok":true}', JSON)
    return Handler


def serve(root):
    """Serve until the info file is removed or replaced, or the time limit passes."""
    if alive(read_info(root)):
        return
    token = secrets.token_urlsafe(16)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(root, token))
    srv.timeout = 1
    me = {"port": srv.server_address[1], "token": token, "pid": os.getpid(), "started": F.now()}
    with open(info_path(root), "w", encoding="utf-8") as f:
        json.dump(me, f)
    deadline = time.time() + MAX_HOURS * 3600
    try:
        while time.time() < deadline:
            info = read_info(root)
            if not info or info.get("pid") != me["pid"]:
                break
            srv.handle_request()
    finally:
        srv.server_close()
        info = read_info(root)
        if info and info.get("pid") == me["pid"]:
            os.remove(info_path(root))


def stop(root):
    try:
        os.remove(info_path(root))
    except OSError:
        pass


def ensure(root):
    """Reuse a running server, or start one detached, and return its info (None if it did not start)."""
    info = read_info(root)
    if alive(info):
        return info
    kw = {"creationflags": 0x00000008 | 0x00000200} if os.name == "nt" else {"start_new_session": True}
    subprocess.Popen([sys.executable, os.path.abspath(__file__), root], stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True, **kw)
    for _ in range(50):
        time.sleep(0.1)
        info = read_info(root)
        if alive(info):
            return info
    return None


def open_for(root):
    """Make sure the dashboard is running, open it in the browser, and return its URL (None on failure)."""
    info = ensure(root)
    if not info:
        return None
    url = "http://127.0.0.1:%d/" % info["port"]
    try:
        webbrowser.open(url)
    except Exception:  # no browser here: the URL is still printed
        pass
    return url


if __name__ == "__main__":
    serve(os.path.abspath(sys.argv[1]))
