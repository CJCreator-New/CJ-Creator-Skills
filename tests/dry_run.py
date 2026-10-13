#!/usr/bin/env python3
"""Dry run on a throwaway repo with a fake feature. No application code is changed by Forge itself;
dev edits are simulated by hooks + fixture transcripts. Usage: python tests/dry_run.py [workdir]"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PLUG = os.path.join(os.path.dirname(HERE), "forge")
SCR = os.path.join(PLUG, "scripts")
work = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="forge-dry-")
os.makedirs(work, exist_ok=True)


def sh(*a, inp=None, cwd=None):
    r = subprocess.run(a, cwd=cwd or work, input=inp, capture_output=True, text=True)
    return r.returncode, r.stdout, r.stderr


def F(*a):
    rc, o, e = sh("python", ".claude/forge/forge.py", *a)
    assert rc == 0, (a, o, e)
    return o


def hook(ev, data):
    rc, o, e = sh("python", os.path.join(SCR, "hook.py"), ev, inp=json.dumps(data))
    assert rc == 0, e
    return o, e


def check(cond, msg):
    print(("  ok  " if cond else " FAIL ") + msg)
    if not cond:
        sys.exit(1)


# --- throwaway repo
sh("git", "init", "-q"); sh("git", "config", "user.email", "t@t"); sh("git", "config", "user.name", "t")
os.makedirs(os.path.join(work, "src"), exist_ok=True)
os.makedirs(os.path.join(work, "node_modules/x"), exist_ok=True)
open(os.path.join(work, "src/greet.py"), "w").write("def greet(name):\n    return 'hi ' + name\n")
open(os.path.join(work, "src/app.py"), "w").write("from greet import greet\nprint(greet('a'))\n")
open(os.path.join(work, "node_modules/x/i.js"), "w").write("x")
sh("git", "add", "src"); sh("git", "commit", "-qm", "init")
print("workdir:", work)

# --- init (as /forge-init does) + launcher
rc, o, e = sh("python", os.path.join(SCR, "forge_cli.py"), "init"); assert rc == 0, e
check(os.path.isfile(os.path.join(work, ".claude/forge/forge.py")), "init wrote launcher")
F("new-run", "Shout greeting", "--request", "make greet shout")
print(F("step", "1").strip())
open(os.path.join(work, ".claude/forge/PROJECT_MAP.md"), "w").write("# Map\nStack: python\nTests: python -m unittest\n")
print(F("map-stamp").strip())
check(json.loads(F("map-status"))["state"] == "fresh", "map fresh after stamp")
F("dnr", "set", "generated/")

# --- enhance + plan
json.dump({"goal": "greet shouts", "acceptance": ["greet('a') == 'HI A'"], "skipped": ["i18n", "options"], "non_goals": [],
           "assumptions": [], "risks": [], "open_questions": [], "context_pack": {}}, open(os.path.join(work, ".claude/forge/work/e.json"), "w"))
F("enhanced", ".claude/forge/work/e.json")
plan = {"phases": [{"id": "P1", "title": "Core"}, {"id": "P2", "title": "Wire"}], "skipped": ["config flag"],
        "tickets": [
            {"id": "P1-T1", "phase": "P1", "title": "Uppercase greet", "description": "return upper()", "edit": ["src/greet.py"],
             "read": ["src/greet.py:1-2"], "group": "A", "complexity": "S", "diff_lines": 2, "tests_later": ["assert in greet test"]},
            {"id": "P1-T2", "phase": "P1", "title": "Doc comment", "edit": ["src/greet.py"], "group": "A", "complexity": "S", "diff_lines": 1},
            {"id": "P2-T1", "phase": "P2", "title": "Use in app", "edit": ["src/app.py"], "read": ["src/app.py"], "deps": ["P1-T1"], "group": "A", "complexity": "complex", "diff_lines": 3}]}
json.dump(plan, open(os.path.join(work, ".claude/forge/work/plan.json"), "w"))
print(F("plan", ".claude/forge/work/plan.json").strip())
st = json.load(open(os.path.join(work, ".claude/forge/state.json")))
check(not st["tickets"]["P1-T1"]["parallel_safe"], "tickets sharing a file are NOT parallel-safe")
check(st["tickets"]["P2-T1"]["model"] == "opus", "complex ticket -> opus")
check(st["approval"]["state"] == "pending", "approval pending before /forge-approve")
check(json.loads(F("ready"))["batch"] == [], "nothing ready before approval")

# --- approve + ready
print(F("approve", "all", "--test-mode", "end").strip())
rd = json.loads(F("ready")); print("ready:", rd)
check(rd["batch"] == ["P1-T1"] and "P1-T2" in rd["deferred"], "overlapping tickets are serialised")
F("ticket", "P1-T1", "running")
print(F("brief", "P1-T1"))

# --- simulate the dev subagent: hooks
base = {"cwd": work, "agent_id": "ag1", "agent_type": "forge:forge-dev"}
tp = os.path.join(work, "agent-ag1.jsonl")
with open(tp, "w") as f:
    f.write(json.dumps({"type": "user", "message": {"role": "user", "content": "FORGE-TICKET: P1-T1\nTitle: x"}}) + "\n")
    for i, (a, b, c, d) in enumerate([(120, 80, 3000, 1500), (40, 60, 4500, 0)]):
        f.write(json.dumps({"type": "assistant", "message": {"id": "m%d" % i, "usage": {"input_tokens": a, "output_tokens": b, "cache_read_input_tokens": c, "cache_creation_input_tokens": d}}}) + "\n")
    f.write(json.dumps({"type": "assistant", "message": {"id": "m1", "usage": {"input_tokens": 40, "output_tokens": 60, "cache_read_input_tokens": 4500, "cache_creation_input_tokens": 0}}}) + "\n")  # duplicate id

o, _ = hook("pre-tool", dict(base, transcript_path=tp, agent_transcript_path=tp, tool_name="Read", tool_input={"file_path": os.path.join(work, "node_modules/x/i.js")}))
check('"deny"' in o, "pre-tool blocks do-not-read path")
o, _ = hook("pre-tool", dict(base, agent_transcript_path=tp, tool_name="Read", tool_input={"file_path": os.path.join(work, "src/app.py")}))
check("outside your context pack" in o, "pre-tool warns outside pack")
o, _ = hook("pre-tool", dict(base, agent_transcript_path=tp, tool_name="Read", tool_input={"file_path": os.path.join(work, "src/greet.py")}))
check(o == "", "pre-tool silent inside pack")
o, _ = hook("pre-tool", dict(base, agent_type="general-purpose", tool_name="Read", tool_input={"file_path": os.path.join(work, "node_modules/x/i.js")}))
check(o == "", "guard ignores non-Forge agents")
o, _ = hook("subagent-start", dict(base, agent_type="forge:forge-dev"))
check("Smallest complete change" in o or "smallest complete change" in o.lower(), "ponytail injected into dev agent")
o, _ = hook("subagent-start", dict(base, agent_type="forge:forge-mapper"))
check(o == "", "ponytail not injected into mapper")

with open(os.path.join(work, "src/greet.py"), "w") as f:  # the "dev edit"
    f.write("def greet(name):\n    # shortcut: ascii only, use casefold for i18n\n    return ('hi ' + name).upper()\n")
hook("post-tool", dict(base, agent_transcript_path=tp, tool_name="Edit", tool_input={"file_path": os.path.join(work, "src/greet.py")}))
hook("subagent-stop", dict(base, agent_transcript_path=tp, transcript_path=tp))
st = json.load(open(os.path.join(work, ".claude/forge/state.json")))
t = st["tickets"]["P1-T1"]
check(t["touched"] == ["src/greet.py"], "touched file recorded against ticket")
check(t["actual"] and t["actual"]["input"] == 160 and t["actual"]["output"] == 140 and t["actual"]["cache_read"] == 7500, "usage summed, duplicate message id counted once: %s" % t["actual"])
check(t["lines"]["added"] >= 1, "lines added/removed recorded: %s" % t["lines"])
check(t["shortcuts"] and t["shortcuts"][0]["line"] == 2, "shortcut: comment captured with line")
F("result", "P1-T1", "--status", "done", "--summary", "greet now shouts", "--closing", "Skipped: i18n casefold.", "--closing", "Risk: non-ASCII names.")
F("ticket", "P1-T2", "running"); F("result", "P1-T2", "--status", "done", "--summary", "comment added")
check(json.loads(F("ready"))["batch"] == ["P2-T1"], "dependent ticket unlocks after dep done")
check(json.load(open(os.path.join(work, ".claude/forge/state.json")))["tickets"]["P1-T2"]["actual"] is None, "no fabricated actuals for unmeasured ticket")

# --- finish
F("tests", "pass", "--summary", "3 passed")
print(F("status"))
check(os.path.isfile(os.path.join(work, ".claude/forge/dashboard.html")), "dashboard.html written")
html = open(os.path.join(work, ".claude/forge/dashboard.html")).read()
check("estimated" in html and "Phase cleared" in html and "Awaiting approval" not in html, "dashboard shows estimated chip + cleared phase")
check(F("claude-md", "check").strip() == "missing", "CLAUDE.md section missing -> offered")
print(F("claude-md", "show")[:400])
print("\nDashboard:", os.path.join(work, ".claude/forge/dashboard.html"))
print("DRY RUN PASSED")
