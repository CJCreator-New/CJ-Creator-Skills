#!/usr/bin/env python3
"""Forge hook entry. Usage: hook.py <event>. Fails open: any error exits 0 silently."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import forge_lib as F  # noqa: E402

PONYTAIL_AGENTS = ("enhancer", "planner", "dev", "docs")


def out(obj):
    sys.stdout.write(json.dumps(obj))


def hook_out(event, **kw):
    out({"hookSpecificOutput": dict(hookEventName=event, **kw)})


def agent_kind(data):
    name = (data.get("agent_type") or "").split(":")[-1]
    return name[6:] if name.startswith("forge-") else ""


def tool_paths(data):
    ti = data.get("tool_input") or {}
    return [p for p in (ti.get("file_path"), ti.get("path")) if isinstance(p, str) and p]


def pack_paths(t):
    ps = set()
    for k in ("edit", "create", "read", "imitate"):
        for s in t.get(k, []):
            ps.add(F.norm_rel(F.spec_path(s)))
    return ps


def in_pack(rel, pack):
    return rel in pack or any(p.startswith(rel.rstrip("/") + "/") for p in pack)


def session_start(root, st, data):
    fd = F.forge_dir(root)
    launcher = os.path.join(fd, "forge.py")
    if os.path.isdir(fd):
        import forge_cli
        forge_cli.write_launcher(root)
    envf = os.environ.get("CLAUDE_ENV_FILE")
    if envf:
        with open(envf, "a") as f:
            f.write('export FORGE_ROOT="%s"\n' % F.PLUGIN_ROOT)
    if F.is_active(st) and os.path.isfile(launcher):
        sys.stdout.write("Forge run active: '%s', step %s/9. /forge-status shows the dashboard.\n" % (st["feature"], st["step"]))


def subagent_start(root, st, data):
    kind = agent_kind(data)
    if F.is_active(st) and kind in PONYTAIL_AGENTS:
        hook_out("SubagentStart", additionalContext=F.ponytail_text(st["ponytail_level"], compact=True))


def pre_tool(root, st, data):
    if agent_kind(data) != "dev" or not F.is_active(st):
        return
    cwd = data.get("cwd") or root
    ti = data.get("tool_input") or {}
    cands = tool_paths(data)
    extra = ti.get("pattern") if data.get("tool_name") == "Glob" else ti.get("glob")
    if isinstance(extra, str):
        cands.append(extra)
    tid = F.resolve_ticket(st, data)
    t = st["tickets"].get(tid) if tid else None
    pack = pack_paths(t) if t else set()
    warn = []
    for c in cands:
        if not c:
            continue
        rel = F.rel_to(c, [cwd, root])
        if rel is None:
            rel = c.replace("\\", "/").lstrip("/")
            if c.startswith("/"):
                continue  # outside the project: not ours to judge
        if rel in pack:
            continue
        hit = F.is_dnr(rel, st["do_not_read"])
        if hit:
            hook_out("PreToolUse", permissionDecision="deny",
                     permissionDecisionReason="Forge: '%s' is on the do-not-read list (%s). Return a CONTEXT-GAP note instead." % (rel, hit))
            return
        if t and rel and not rel.startswith("*") and not in_pack(rel, pack):
            warn.append(rel)
    if warn and t:
        def mark(s):
            tk = s["tickets"][tid]
            tk["outside_reads"] = (tk.get("outside_reads", []) + warn)[-10:]
        F.update(root, mark)
        hook_out("PreToolUse", additionalContext="Forge: %s is outside your context pack. Stop exploring; if you truly need it, finish with a CONTEXT-GAP note." % ", ".join(warn[:3]))


def post_tool(root, st, data):
    aid = data.get("agent_id")
    if not aid or not F.is_active(st):
        return
    cwd = data.get("cwd") or root
    items = []
    for p in tool_paths(data):
        ap = p if os.path.isabs(p) else os.path.join(cwd, p)
        rel = F.rel_to(ap, [cwd, root])
        if rel and not rel.startswith(".claude/forge"):
            items.append((rel, ap))
    if not items:
        return
    tid = F.resolve_ticket(st, data)

    def rec(s):
        if tid and tid in s["tickets"]:
            t = s["tickets"][tid]
            ab = t.setdefault("touched_abs", {})
            for rel, ap in items:
                ab[rel] = ap
                if rel not in t["touched"]:
                    t["touched"].append(rel)
            s["agents"].setdefault(aid, {})["ticket"] = tid
        else:
            a = s["agents"].setdefault(aid, {})
            a.setdefault("touched", {}).update({rel: ap for rel, ap in items})
    F.update(root, rec)


def subagent_stop(root, st, data):
    if not F.is_active(st):
        return
    kind = agent_kind(data)
    if not kind:
        return
    tp = F.find_agent_transcript(data)
    usage = F.parse_usage(tp)
    aid = data.get("agent_id") or ""

    def rec(s):
        if kind != "dev":
            if usage:
                s["overhead"][kind] = {k: (s["overhead"].get(kind, {}).get(k, 0) + usage[k]) for k in ("input", "output", "cache_read", "cache_write")}
                s["overhead"][kind]["exact"] = True
            return
        tid = F.resolve_ticket(s, data, tp)
        if not tid:
            return
        t = s["tickets"][tid]
        pend = (s["agents"].get(aid) or {}).get("touched", {})
        ab = t.setdefault("touched_abs", {})
        for rel, ap in pend.items():
            ab[rel] = ap
            if rel not in t["touched"]:
                t["touched"].append(rel)
        s["agents"].setdefault(aid, {})["ticket"] = tid
        if usage:
            t["actual"] = usage
        a = r = 0
        for rel in t["touched"]:
            ap = ab.get(rel) or os.path.join(root, rel)
            x, y = F.file_numstat(ap)
            a, r = a + x, r + y
        t["lines"] = {"added": a, "removed": r}
        t["shortcuts"] = F.scan_shortcuts([(rel, ab.get(rel) or os.path.join(root, rel)) for rel in t["touched"]])
    F.update(root, rec)


def stop(root, st, data):
    if not F.is_active(st):
        return
    u = F.parse_usage(data.get("transcript_path"))
    if u:
        F.update(root, lambda s: s.__setitem__("session", u))


HANDLERS = {"session-start": session_start, "subagent-start": subagent_start, "pre-tool": pre_tool,
            "post-tool": post_tool, "subagent-stop": subagent_stop, "stop": stop}


def main():
    try:
        ev = sys.argv[1]
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
        root = F.find_root(data.get("cwd"))
        if not root:
            return
        st = F.load(root)
        if st is None:
            return
        HANDLERS[ev](root, st, data)
    except Exception as e:  # fail open
        sys.stderr.write("forge hook: %s\n" % e)


if __name__ == "__main__":
    main()
    sys.exit(0)
