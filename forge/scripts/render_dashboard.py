#!/usr/bin/env python3
"""state.json -> dashboard.html (self-contained, no CDN) and terminal view. Stdlib only."""
import html
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import forge_lib as F  # noqa: E402

e = html.escape


def n(x):
    return "{:,}".format(int(x))


def pct(a, b):
    return max(0, min(100, round(100 * a / b))) if b else 0


def signed(x):
    return ("+" if x > 0 else "") + n(x)


def bar(p, cls=""):
    return '<div class="bar %s"><i style="width:%d%%"></i></div>' % (cls, p)


CSS = """
:root{--bg:#f5f6f9;--card:#fff;--ink:#1b2130;--mut:#6a7388;--line:#e2e5ec;--acc:#5468ff;--ok:#1d9a55;--warn:#d68a00;--bad:#d44;--run:#2b7de9;--xp:#f0ab1c}
@media(prefers-color-scheme:dark){:root{--bg:#10131a;--card:#1a1e28;--ink:#e8ebf3;--mut:#9aa2b6;--line:#2a3042;--acc:#7b8bff;--ok:#3ccf82;--warn:#f0b43a;--bad:#ff6b6b;--run:#5aa2ff;--xp:#f5c242}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:0}h2{font-size:15px;margin:0 0 8px}small,.mut{color:var(--mut)}
.top{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
.badge{display:inline-block;padding:2px 9px;border-radius:99px;border:1px solid var(--line);background:var(--card);font-size:12px;margin-left:4px}
.badge.pt{border-color:var(--acc);color:var(--acc);font-weight:600}
.steps{display:flex;gap:4px;margin:12px 0;flex-wrap:wrap}
.step{flex:1;min-width:92px;padding:5px 7px;border-radius:8px;background:var(--card);border:1px solid var(--line);font-size:11px;color:var(--mut)}
.step.done{color:var(--ok);border-color:var(--ok)}.step.cur{background:var(--acc);color:#fff;border-color:var(--acc);font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px}
.grid{display:grid;grid-template-columns:2fr 1fr;gap:12px}@media(max-width:900px){.grid{grid-template-columns:1fr}}
.bar{height:12px;border-radius:99px;background:var(--line);overflow:hidden}.bar i{display:block;height:100%;background:var(--acc);transition:width .4s}
.bar.xp i{background:linear-gradient(90deg,var(--xp),#ff8a3d)}.bar.ok i{background:var(--ok)}.bar.over i{background:var(--bad)}
.score{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.pill{padding:4px 10px;border-radius:10px;background:var(--bg);border:1px solid var(--line);font-size:12px}
.pill.on{border-color:var(--ok);color:var(--ok);font-weight:600}
.alert{border:1px solid var(--bad);background:color-mix(in srgb,var(--bad) 10%,var(--card));border-radius:10px;padding:8px 12px;margin-bottom:12px}
.hold{border:1px solid var(--warn);background:color-mix(in srgb,var(--warn) 12%,var(--card));border-radius:10px;padding:8px 12px;margin-bottom:12px}
.lanes{display:flex;gap:10px;flex-wrap:wrap}.lane{flex:1;min-width:250px}.lane>b{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em}
details.t{border:1px solid var(--line);border-radius:9px;margin:6px 0;background:var(--bg)}
details.t summary{cursor:pointer;padding:7px 9px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;list-style:none}
details.t summary::-webkit-details-marker{display:none}
.chip{font-size:11px;padding:1px 8px;border-radius:99px;color:#fff;background:var(--mut)}
.chip.approved{background:var(--acc)}.chip.running{background:var(--run);animation:p 1.2s infinite}.chip.done{background:var(--ok)}.chip.blocked{background:var(--bad)}
@keyframes p{50%{opacity:.55}}
.ttl{flex:1;min-width:120px}.tn{font-variant-numeric:tabular-nums;font-size:12px}
.add{color:var(--ok)}.rem{color:var(--bad)}.body{padding:2px 12px 10px;font-size:13px}.body code{background:var(--card);padding:0 4px;border-radius:4px}
table{width:100%;border-collapse:collapse}td{padding:3px 0;font-variant-numeric:tabular-nums}td:last-child{text-align:right}
.big{font-size:22px;font-weight:700}.est{color:var(--warn);font-size:11px}
.split{display:flex;height:10px;border-radius:99px;overflow:hidden;background:var(--line)}.split i{display:block}
ul{margin:4px 0;padding-left:18px}
"""

JS = """(function(){var K='forge-open',S='forge-scroll';
function save(){try{var a=[];document.querySelectorAll('details[data-id]').forEach(function(d){if(d.open)a.push(d.dataset.id)});sessionStorage.setItem(K,JSON.stringify(a))}catch(e){}}
try{var o=JSON.parse(sessionStorage.getItem(K)||'[]');document.querySelectorAll('details[data-id]').forEach(function(d){if(o.indexOf(d.dataset.id)>-1)d.open=true;d.addEventListener('toggle',save)});
window.scrollTo(0,+sessionStorage.getItem(S)||0)}catch(e){}
setInterval(function(){if(document.hidden)return;try{sessionStorage.setItem(S,window.scrollY)}catch(e){}location.reload()},3000)})();"""


def ticket_html(t):
    a = t.get("actual")
    est = t["est"]["total"]
    if a:
        u = F.fresh(a)
        used = '<span class="tn">%s / %s <small>(%s)</small></span>' % (n(u), n(est), signed(u - est))
    elif t["status"] == "done":
        used = '<span class="tn"><span class="est">estimated</span> %s</span>' % n(est)
    else:
        used = '<span class="tn mut">est %s</span>' % n(est)
    ln = '<span class="tn"><span class="add">+%d</span> <span class="rem">-%d</span></span>' % (t["lines"]["added"], t["lines"]["removed"])
    deps = (" &larr; " + ", ".join(e(d) for d in t["deps"])) if t["deps"] else ""
    flags = "" if t["parallel_safe"] else ' <span class="badge">not parallel-safe</span>'
    b = ['<p>%s</p>' % e(t["description"])] if t["description"] else []
    for lab, k in (("Edit", "edit"), ("Create", "create"), ("Read", "read"), ("Imitate", "imitate"), ("Symbols", "symbols")):
        if t[k]:
            b.append("<div><b>%s:</b> %s</div>" % (lab, " ".join("<code>%s</code>" % e(x) for x in t[k])))
    if t["touched"]:
        b.append("<div><b>Touched:</b> %s</div>" % " ".join("<code>%s</code>" % e(x) for x in t["touched"]))
    if t["conventions"]:
        b.append("<div><b>Conventions:</b> %s</div>" % e("; ".join(t["conventions"])))
    if t["summary"]:
        b.append("<div><b>Result:</b> %s</div>" % e(t["summary"]))
    if t["closing"]:
        b.append("<div><b>Skipped / risks:</b><ul>%s</ul></div>" % "".join("<li>%s</li>" % e(c) for c in t["closing"]))
    if t["shortcuts"]:
        b.append("<div><b>shortcut:</b><ul>%s</ul></div>" % "".join("<li><code>%s:%d</code> %s</li>" % (e(s["file"]), s["line"], e(s["text"])) for s in t["shortcuts"]))
    if t["gap"]:
        b.append('<div class="rem"><b>Gap/blocker:</b> %s</div>' % e(t["gap"]))
    if t.get("outside_reads"):
        b.append('<div class="est">Read outside pack: %s</div>' % e(", ".join(t["outside_reads"])))
    if a:
        b.append("<div class=mut>in %s out %s cache-read %s cache-write %s &middot; %d turns</div>" % (n(a["input"]), n(a["output"]), n(a["cache_read"]), n(a["cache_write"]), a.get("turns", 0)))
    return ('<details class="t" data-id="%s"><summary><span class="chip %s">%s</span><b>%s</b><span class="ttl">%s<small>%s</small></span>%s %s %s <small>%s &middot; %s</small></summary>'
            '<div class="body">%s</div></details>') % (
        e(t["id"]), t["status"], t["status"], e(t["id"]), e(t["title"]), deps, flags, ln, used, t["complexity"], t["model"], "".join(b) or "<small>no detail yet</small>")


def phase_html(st, p, s):
    ts = [st["tickets"][i] for i in p["tickets"]]
    lanes = {}
    for t in ts:
        lanes.setdefault(t["group"], []).append(t)
    cols = "".join('<div class="lane"><b>lane %s</b>%s</div>' % (e(g), "".join(ticket_html(t) for t in v)) for g, v in lanes.items())
    badge = ' <span class="badge" style="border-color:var(--ok);color:var(--ok)">Phase cleared</span>' if p["cleared"] else ""
    return '<div class="card"><h2>%s &middot; %s%s <small>%d/%d &middot; est %s &middot; used %s</small></h2>%s<div class="lanes" style="margin-top:8px">%s</div></div>' % (
        e(p["id"]), e(p["title"]), badge, p["done"], p["n"], n(p["expected"]), n(p["used"]), bar(p["pct"], "ok" if p["cleared"] else ""), cols or "<small>no tickets</small>")


def tokens_html(s):
    io = s["io"]
    tot = max(1, io["input"] + io["output"] + io["cache_write"])
    over = s["used"] > s["expected"] > 0
    rows = [
        ("Expected", n(s["expected"])), ("Range", "%s - %s" % (n(s["est_low"]), n(s["est_high"]))),
        ("Used (measured)", n(s["used"])), ("Remaining", signed(s["remaining"]) if s["remaining"] < 0 else n(s["remaining"])),
        ("Variance (done)", signed(s["var"])), ("Input / output", "%s / %s" % (n(io["input"]), n(io["output"]))),
        ("Cache read / write", "%s / %s" % (n(io["cache_read"]), n(io["cache_write"]))),
    ]
    if s["unmeasured"]:
        rows.append(("Unmeasured (est.)", n(s["unmeasured"])))
    for k, v in s["overhead"].items():
        rows.append(("Overhead: " + k, n(F.fresh(v))))
    return ('<div class="card"><h2>Tokens</h2>%s<div class="split" style="margin:8px 0"><i style="width:%d%%;background:var(--acc)"></i><i style="width:%d%%;background:var(--xp)"></i><i style="width:%d%%;background:var(--run)"></i></div>'
            '<table>%s</table><hr style="border:0;border-top:1px solid var(--line)"><small>Tokens saved vs unguided baseline <span class="est">(estimate)</span></small><div class="big">%s</div>'
            '<small>projected for plan: %s <span class="est">(estimate)</span></small>'
            '<p class="mut" style="font-size:11px;margin:6px 0 0">Used = input + cache-write + output from transcripts; cache reads shown separately. Baseline = estimate + heuristic exploration cost (12%% of repo tokens, 10k-150k).</p></div>') % (
        bar(pct(s["used"], s["expected"]), "over" if over else ""),
        pct(io["input"], tot), pct(io["output"], tot), pct(io["cache_write"], tot),
        "".join("<tr><td class=mut>%s</td><td>%s</td></tr>" % (e(a), e(b)) for a, b in rows), n(s["saved"]), n(s["proj_saved"]))


def render_html(st):
    s = F.summarize(st)
    step = st["step"]
    stepper = "".join('<div class="step %s">%d. %s</div>' % ("cur" if i + 1 == step else ("done" if i + 1 < step or st["finished"] else ""), i + 1, e(nm)) for i, nm in enumerate(F.STEPS))
    ap = st["approval"]["state"]
    hold = ""
    if ap == "pending" and st["tickets"]:
        hold = '<div class="hold"><b>Awaiting approval.</b> Nothing runs until you run <code>/forge-approve all</code>, <code>phase N</code> or ticket IDs.</div>'
    block = '<div class="alert"><b>Blockers</b><ul>%s</ul></div>' % "".join("<li>%s</li>" % e(b) for b in st["blockers"]) if st["blockers"] else ""
    budget = s["budget_kept"]
    score = "".join('<span class="pill %s">%s</span>' % (c, t) for c, t in (
        ("on" if s["done"] else "", "Tickets cleared %d/%d" % (s["done"], s["n"])),
        ("on" if s["tests_green"] else "", "Tests green" + (" &#10003;" if s["tests_green"] else " (%s)" % e(st["tests"]["status"]))),
        ("on" if budget else "", "&#127942; Budget kept" if budget else "Budget kept: %s" % ("over" if budget is False else "n/a")),
        ("on" if s["shipped"] else "", "Feature shipped" if s["shipped"] else "Not shipped yet"),
        ("", "+%d / -%d lines" % (s["lines_add"], s["lines_rem"]))))
    skipped = ('<div class="card"><h2>Skipped / not requested</h2><ul>%s</ul></div>' % "".join("<li>%s</li>" % e(x) for x in st["skipped"])) if st["skipped"] else ""
    phases = "".join(phase_html(st, p, s) for p in s["phases"]) or '<div class="card"><small>No plan yet.</small></div>'
    events = '<div class="card"><h2>Activity</h2><ul>%s</ul></div>' % "".join("<li><small>%s</small> %s</li>" % (e(x["t"][11:19]), e(x["msg"])) for x in reversed(st["events"][-8:])) if st["events"] else ""
    return """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Forge - %(f)s</title><style>%(css)s</style></head><body><div class="wrap">
<div class="top"><div><h1>&#9874; Forge <small>%(f)s</small></h1></div><div><span class="badge pt">ponytail: %(lv)s</span><span class="badge">tests: %(tm)s</span><span class="badge">approval: %(ap)s</span><span class="badge">%(pct)d%% complete</span></div></div>
<div class="steps">%(steps)s</div>%(block)s%(hold)s
<div class="card"><div class="top"><b>Level %(lvl)d &middot; %(title)s</b><small>%(xp)d XP</small></div>%(xpbar)s<div class="score">%(score)s</div></div>
<div class="grid"><div>%(phases)s</div><div>%(tok)s%(skipped)s%(events)s</div></div>
<p class="mut" style="font-size:11px">Updated %(up)s &middot; auto-refresh 3s</p></div><script>%(js)s</script></body></html>""" % dict(
        f=e(st["feature"] or "no active run"), css=CSS, js=JS, lv=e(st["ponytail_level"]), tm=e(st["test_mode"]), ap=e(ap), pct=s["pct"],
        steps=stepper, block=block, hold=hold, lvl=s["level"], title=e(s["title"]), xp=s["xp"], xpbar=bar(pct(s["xp"] % 60, 60), "xp"),
        score=score, phases=phases, tok=tokens_html(s), skipped=skipped, events=events, up=e(st["updated"]))


def terminal(st):
    import tui
    return tui.render_text(st, 100)


def write(root, st):
    p = os.path.join(F.forge_dir(root), "dashboard.html")
    tmp = p + ".tmp%d" % os.getpid()
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(render_html(st))
    os.replace(tmp, p)
    return p


if __name__ == "__main__":
    r = F.find_root()
    if not r:
        sys.exit("forge: not initialised here")
    st = F.load(r)
    write(r, st)
    print(terminal(st))
