#!/usr/bin/env python3
"""Forge shared library: state, locking, usage parsing, summaries. Python 3.8+, stdlib only."""
import datetime
import difflib
import fnmatch
import glob
import json
import os
import re
import subprocess
import sys
import time

VERSION = "1.1.0"
PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

STEPS = [
    "Project map", "Enhance the prompt", "Plan", "Approval gate", "Execute",
    "Token accounting", "Testing", "Dev handoff", "Final dashboard + summary",
]
LEVELS = ("lite", "full", "ultra")
STATUSES = ("pending", "approved", "running", "done", "blocked")
COMPLEXITY = ("S", "M", "L", "complex")
DEFAULT_DNR = [
    "node_modules", "dist", "build", "out", ".next", ".nuxt", "coverage", "__pycache__",
    ".venv", "venv", "target", "vendor", ".git", ".claude/forge",
    "*.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "go.sum",
    "*.min.js", "*.min.css", "*.map", "*.png", "*.jpg", "*.jpeg", "*.gif", "*.ico",
    "*.woff", "*.woff2", "*.pdf", "*.zip",
]
OVERHEAD_TOKENS = 2500     # agent boot cost: system prompt + tools + brief
TOK_PER_RANGE_LINE = 12    # tokens per line when only a line range is read
TOK_PER_DIFF_LINE = 14
SHORTCUT_RE = re.compile(r"(?:#|//|/\*|--|<!--|;|\*)\s*shortcut:\s*(\S.*)")


# ---------------------------------------------------------------- basics
def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def slugify(s):
    s = re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")
    return s[:48] or "feature"


def run_git(args, cwd, timeout=20):
    try:
        r = subprocess.run(["git"] + args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout
    except Exception:
        return 1, ""


def forge_dir(root):
    return os.path.join(root, ".claude", "forge")


def state_path(root):
    return os.path.join(forge_dir(root), "state.json")


def find_root(start=None):
    """Project root that holds .claude/forge/state.json (worktree-aware), else None."""
    cands = [c for c in (start, os.environ.get("CLAUDE_PROJECT_DIR"), os.getcwd()) if c]
    for c in cands:
        d = os.path.abspath(c)
        while True:
            if os.path.isfile(state_path(d)):
                return d
            p = os.path.dirname(d)
            if p == d:
                break
            d = p
    for c in cands:
        rc, out = run_git(["rev-parse", "--git-common-dir"], c)
        if rc == 0 and out.strip():
            d = os.path.dirname(os.path.abspath(os.path.join(c, out.strip())))
            if os.path.isfile(state_path(d)):
                return d
    return None


def init_root(start=None):
    c = start or os.getcwd()
    rc, out = run_git(["rev-parse", "--show-toplevel"], c)
    return os.path.abspath(out.strip()) if rc == 0 and out.strip() else os.path.abspath(c)


def git_head(root):
    rc, out = run_git(["rev-parse", "HEAD"], root)
    if rc == 0 and out.strip():
        return out.strip()
    import hashlib
    files = sorted(tracked_files(root))
    return "nogit-" + hashlib.sha1("\n".join(files).encode()).hexdigest()[:12]


def tracked_files(root):
    rc, out = run_git(["ls-files"], root)
    if rc == 0 and out.strip():
        return [l for l in out.splitlines() if l]
    res = []
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in (".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build")]
        for fn in fns:
            res.append(os.path.relpath(os.path.join(dp, fn), root))
        if len(res) > 20000:
            break
    return res


# ---------------------------------------------------------------- state
def new_state(feature="", request="", keep=None):
    keep = keep or {}
    return {
        "version": 1,
        "feature": feature, "slug": slugify(feature), "request": request,
        "created": now(), "updated": now(), "finished": False,
        "step": 0, "ponytail_level": keep.get("ponytail_level", "full"),
        "test_mode": keep.get("test_mode", "end"),
        "approval": {"state": "none", "approved": []},
        "map": keep.get("map", {"head": "", "generated": "", "repo_tokens": 0}),
        "do_not_read": keep.get("do_not_read", list(DEFAULT_DNR)),
        "enhanced": {}, "skipped": [],
        "phases": [], "tickets": {},
        "tests": {"status": "none", "summary": ""},
        "session": None, "overhead": {}, "agents": {},
        "blockers": [], "events": [],
    }


def normalize(st):
    base = new_state()
    for k, v in base.items():
        st.setdefault(k, v)
    return st


def load(root):
    try:
        with open(state_path(root), encoding="utf-8") as f:
            return normalize(json.load(f))
    except (OSError, ValueError):
        return None


def save(root, st):
    p = state_path(root)
    tmp = p + ".tmp%d" % os.getpid()
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, indent=1)
    os.replace(tmp, p)


class Lock:
    def __init__(self, path):
        self.path = path

    def __enter__(self):
        deadline = time.time() + 10
        while True:
            try:
                self.fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                return self
            except FileExistsError:
                try:
                    if time.time() - os.path.getmtime(self.path) > 15:
                        os.unlink(self.path)
                        continue
                except OSError:
                    pass
                if time.time() > deadline:
                    raise TimeoutError("forge state lock busy")
                time.sleep(0.05)

    def __exit__(self, *a):
        try:
            os.close(self.fd)
            os.unlink(self.path)
        except OSError:
            pass


def update(root, fn, render=True):
    """Locked read-modify-write of state.json, then re-render the dashboard."""
    with Lock(os.path.join(forge_dir(root), ".lock")):
        st = load(root)
        if st is None:
            raise SystemExit("Forge is not initialised here. Run /forge-init.")
        res = fn(st)
        st["updated"] = now()
        save(root, st)
    if render:
        try:
            import render_dashboard
            render_dashboard.write(root, st)
        except Exception as e:  # dashboard must never break the workflow
            sys.stderr.write("forge: render failed: %s\n" % e)
    return res


def log(st, msg):
    st["events"] = (st["events"] + [{"t": now(), "msg": msg}])[-30:]


def is_active(st):
    return bool(st and st.get("feature") and not st.get("finished"))


# ---------------------------------------------------------------- do-not-read
def norm_rel(p):
    p = os.path.normpath(p).replace(os.sep, "/")
    while p.startswith("./"):
        p = p[2:]
    return re.sub(r"^\.claude/worktrees/[^/]+/", "", p)


def rel_to(path, bases):
    if not os.path.isabs(path):
        return norm_rel(path)
    for b in bases:
        if b and (path == b or path.startswith(b.rstrip(os.sep) + os.sep)):
            return norm_rel(os.path.relpath(path, b))
    return None


def is_dnr(rel, patterns):
    rel = rel.strip("/")
    parts = rel.split("/")
    for pat in patterns:
        pat = pat.strip("/")
        if "/" in pat:
            if rel == pat or rel.startswith(pat + "/"):
                return pat
        elif any(fnmatch.fnmatch(x, pat) for x in parts):
            return pat
    return None


# ---------------------------------------------------------------- usage
def parse_usage(path):
    """Sum usage over a transcript JSONL. Last record per message id wins. None if no usage."""
    if not path or not os.path.isfile(path):
        return None
    by_id = {}
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                m = o.get("message") if isinstance(o, dict) else None
                u = m.get("usage") if isinstance(m, dict) else None
                if isinstance(u, dict):
                    by_id[m.get("id") or o.get("uuid") or i] = u
    except OSError:
        return None
    if not by_id:
        return None
    t = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}
    for u in by_id.values():
        t["input"] += int(u.get("input_tokens") or 0)
        t["output"] += int(u.get("output_tokens") or 0)
        t["cache_read"] += int(u.get("cache_read_input_tokens") or 0)
        t["cache_write"] += int(u.get("cache_creation_input_tokens") or 0)
    t["turns"] = len(by_id)
    t["exact"] = True
    return t


def fresh(a):
    """Fresh tokens: input + cache writes + output. Cache reads are shown separately."""
    return (a["input"] + a["cache_write"] + a["output"]) if a else None


def ticket_from_transcript(path):
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            m = re.search(r"FORGE-TICKET:\s*([A-Za-z0-9_-]+)", f.read(65536))
        return m.group(1) if m else None
    except OSError:
        return None


def find_agent_transcript(data):
    p = data.get("agent_transcript_path")
    if p and os.path.isfile(p):
        return p
    aid, tp = data.get("agent_id"), data.get("transcript_path")
    if aid and tp:
        base = os.path.dirname(tp)
        for hit in glob.glob(os.path.join(base, "**", "agent-%s.jsonl" % aid), recursive=True)[:1]:
            return hit
    return None


def resolve_ticket(st, data, transcript=None):
    """Map a hook event to a ticket id: cached agent_id, then FORGE-TICKET in transcript, then sole running."""
    aid = data.get("agent_id")
    cached = (st["agents"].get(aid) or {}).get("ticket") if aid else None
    if cached in st["tickets"]:
        return cached
    tid = ticket_from_transcript(transcript or find_agent_transcript(data))
    if not tid:
        running = [i for i, t in st["tickets"].items() if t["status"] == "running"]
        tid = running[0] if len(running) == 1 else None
    return tid if tid in st["tickets"] else None


# ---------------------------------------------------------------- estimates
def est_spec_tokens(root, spec):
    m = re.match(r"^(.*?):(\d+)-(\d+)$", spec)
    if m:
        return max(1, int(m.group(3)) - int(m.group(2)) + 1) * TOK_PER_RANGE_LINE
    try:
        return os.path.getsize(os.path.join(root, spec)) // 4
    except OSError:
        return 0


def spec_path(spec):
    return re.sub(r":\d+-\d+$", "", spec)


def estimate(root, reads, diff_lines, repo_tokens=0):
    inp = OVERHEAD_TOKENS + sum(est_spec_tokens(root, s) for s in reads)
    out = 300 + int(diff_lines) * TOK_PER_DIFF_LINE
    total = inp + out
    explore = min(150000, max(10000, int(0.12 * repo_tokens))) if repo_tokens else 40000
    return {
        "input": inp, "output": out, "total": total,
        "low": int(total * 0.7), "high": int(total * 1.5),
        "baseline": total + explore,
    }


def repo_tokens(root, dnr):
    n = 0
    for f in tracked_files(root):
        if is_dnr(f, dnr):
            continue
        try:
            n += os.path.getsize(os.path.join(root, f)) // 4
        except OSError:
            pass
    return n


# ---------------------------------------------------------------- git numstat / shortcuts
def file_numstat(abs_path):
    d = os.path.dirname(abs_path)
    if not os.path.isdir(d):
        return (0, 0)
    rc, out = run_git(["diff", "--numstat", "HEAD", "--", abs_path], d)
    if rc == 0 and out.strip():
        a, r, _ = out.split("\t", 2)
        return (int(a) if a.isdigit() else 0, int(r) if r.isdigit() else 0)
    rc2, _ = run_git(["ls-files", "--error-unmatch", abs_path], d)
    if (rc != 0 or rc2 != 0) and os.path.isfile(abs_path):
        try:
            with open(abs_path, encoding="utf-8", errors="replace") as f:
                return (sum(1 for _ in f), 0)
        except OSError:
            pass
    return (0, 0)


def scan_shortcuts(paths):
    """paths: iterable of (display, abs). Returns [{'file','line','text'}]."""
    res = []
    for disp, ap in paths:
        try:
            with open(ap, encoding="utf-8", errors="replace") as f:
                for i, line in enumerate(f, 1):
                    m = SHORTCUT_RE.search(line)
                    if m:
                        res.append({"file": disp, "line": i, "text": m.group(1).strip()[:200]})
        except OSError:
            pass
    return res


def project_shortcuts(root):
    res = []
    for f in tracked_files(root):
        if f.startswith((".claude/", "docs/handoffs/")) or f.endswith(".md"):
            continue
        ap = os.path.join(root, f)
        try:
            if os.path.getsize(ap) > 1_000_000:
                continue
        except OSError:
            continue
        res.extend(scan_shortcuts([(f, ap)]))
    return res


# ---------------------------------------------------------------- ponytail text
def ponytail_text(level):
    p = os.path.join(PLUGIN_ROOT, "ponytail", "SKILL.md")
    try:
        txt = open(p, encoding="utf-8").read()
    except OSError:
        return ""
    txt = re.sub(r"^---.*?---\s*", "", txt, count=1, flags=re.S)
    txt = txt.split("## Levels")[0].replace("# Ponytail", "# Ponytail (Forge)", 1)
    txt = re.sub(r"Active for the whole session.*\n", "", txt)
    lv = {
        "lite": "lite: build what was asked; name the smaller option in one line and let the user pick.",
        "full": "full: apply the rules above.",
        "ultra": "ultra: also question the request; push back on any part the need does not justify.",
    }.get(level, "full")
    return txt.strip() + "\n\nActive level: " + lv + "\n"


# ---------------------------------------------------------------- summaries
def summarize(st):
    T = st["tickets"]
    tl = list(T.values())
    n = len(tl)
    done = [t for t in tl if t["status"] == "done"]
    scope = [t for t in tl if t["status"] != "pending"] or tl
    expected = sum(t["est"]["total"] for t in scope)
    with_act = [t for t in tl if t.get("actual")]
    used = sum(fresh(t["actual"]) for t in with_act)
    unmeasured = sum(t["est"]["total"] for t in done if not t.get("actual"))
    io = {k: sum(t["actual"][k] for t in with_act) for k in ("input", "output", "cache_read", "cache_write")}
    meas_done = [t for t in done if t.get("actual")]
    var = sum(fresh(t["actual"]) - t["est"]["total"] for t in meas_done)
    saved = sum(t["est"]["baseline"] - fresh(t["actual"]) for t in meas_done)
    proj_saved = sum(t["est"]["baseline"] - t["est"]["total"] for t in scope)
    oh = {k: v for k, v in st["overhead"].items()}
    oh_total = sum(fresh(v) for v in oh.values())
    phases = []
    cleared = 0
    for p in st["phases"]:
        pt = [t for t in tl if t["phase"] == p["id"]]
        d = sum(1 for t in pt if t["status"] == "done")
        ok = bool(pt) and d == len(pt)
        cleared += ok
        phases.append({
            "id": p["id"], "title": p["title"], "n": len(pt), "done": d,
            "pct": round(100 * d / len(pt)) if pt else 0, "cleared": ok,
            "expected": sum(t["est"]["total"] for t in pt),
            "used": sum(fresh(t["actual"]) for t in pt if t.get("actual")),
            "tickets": [t["id"] for t in pt],
        })
    tests_green = st["tests"]["status"] == "pass"
    shipped = bool(n) and len(done) == n and tests_green
    budget_kept = None
    if meas_done and len(meas_done) == len(done):
        budget_kept = sum(fresh(t["actual"]) for t in meas_done) <= sum(t["est"]["total"] for t in meas_done)
    xp = 10 * len(done) + 25 * cleared + (20 if tests_green else 0) + (15 if budget_kept else 0) + (50 if shipped else 0)
    level = 1 + xp // 60
    titles = ["Apprentice", "Smith", "Journeyman", "Artisan", "Master", "Grandmaster"]
    if st.get("finished"):
        pct = 100
    elif n:
        pct = round(100 * len(done) / n)
    else:
        pct = round(100 * max(0, st["step"] - 1) / 9)
    return {
        "n": n, "done": len(done), "pct": pct, "phases": phases, "cleared": cleared,
        "expected": expected, "used": used, "remaining": expected - used,
        "unmeasured": unmeasured, "io": io, "var": var, "saved": saved,
        "proj_saved": proj_saved, "overhead": oh, "overhead_total": oh_total,
        "tests_green": tests_green, "shipped": shipped, "budget_kept": budget_kept,
        "xp": xp, "level": level, "title": titles[min(level - 1, 5)],
        "next_xp": level * 60,
        "est_low": sum(t["est"]["low"] for t in scope), "est_high": sum(t["est"]["high"] for t in scope),
        "lines_add": sum(t["lines"]["added"] for t in tl), "lines_rem": sum(t["lines"]["removed"] for t in tl),
    }


def unified_diff(old, new, name):
    return "".join(difflib.unified_diff(old.splitlines(1), new.splitlines(1), "a/" + name, "b/" + name))
