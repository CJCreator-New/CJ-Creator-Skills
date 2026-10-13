#!/usr/bin/env python3
"""state.json -> the Forge dashboard. Two outputs: a static snapshot (dashboard.html) and the live page
that dash_server.py serves. The live page refreshes only its data panels every 3s, so the message box
and the add-detail sheet keep what you typed. Stdlib only."""
import datetime
import html
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import forge_lib as F  # noqa: E402
import tui  # noqa: E402

e = html.escape


def n(x):
    return "{:,}".format(int(x))


def pct(a, b):
    return max(0, min(100, round(100 * a / b))) if b else 0


def signed(x):
    return ("+" if x > 0 else "") + n(x)


def bar(p, cls=""):
    return '<div class="bar %s"><i style="width:%d%%"></i></div>' % (cls, p)


def now_utc():
    return datetime.datetime.now(datetime.timezone.utc)


CSS = """
:root{--bg:#f4f6fb;--card:#fff;--ink:#161d2e;--mut:#667089;--line:#e3e7ef;--soft:#f0f2fa;--acc:#5b5fe8;--ok:#14935a;--warn:#c98200;--bad:#d9413a;--run:#2a7de1;--xp:#f2a71b}
@media(prefers-color-scheme:dark){:root{--bg:#0d1119;--card:#161b26;--ink:#e7ebf4;--mut:#949db3;--line:#263044;--soft:#1b2231;--acc:#8b8ff5;--ok:#37c983;--warn:#f0b43a;--bad:#ff736b;--run:#5aa8ff;--xp:#f5c242}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding-bottom:86px}
.wrap{max-width:1200px;margin:0 auto;padding:16px}
h1{font-size:18px;margin:0;display:inline}h2{font-size:13px;margin:0 0 8px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut)}
small,.mut{color:var(--mut)}code{background:var(--soft);padding:0 5px;border-radius:5px;font-size:12.5px}
.hdr{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin-bottom:12px}
.hdr .name{font-weight:600;margin-left:8px}
.pills{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.pill{font-size:12px;padding:3px 10px;border-radius:99px;background:var(--card);border:1px solid var(--line)}
.pill.acc{border-color:var(--acc);color:var(--acc);font-weight:600}
.conn{font-size:12px;padding:3px 10px;border-radius:99px;background:var(--soft)}
.conn.ok{color:var(--ok)}.conn.bad{color:var(--bad)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:12px;box-shadow:0 1px 2px rgba(16,24,40,.05)}
.hold{display:flex;gap:10px;flex-wrap:wrap;justify-content:space-between;align-items:center;border:1px solid var(--warn);background:color-mix(in srgb,var(--warn) 12%,var(--card));border-radius:14px;padding:12px 14px;margin-bottom:12px}
.alert{border:1px solid var(--bad);background:color-mix(in srgb,var(--bad) 10%,var(--card));border-radius:14px;padding:10px 14px;margin-bottom:12px}
.stage{list-style:none;display:flex;justify-content:space-between;position:relative;margin:4px 0 14px;padding:0}
.stage .rail{position:absolute;left:6px;right:6px;top:11px;height:4px;background:var(--line);border-radius:4px;z-index:0}
.stage .rail i{display:block;height:100%;background:var(--ok);border-radius:4px;transition:width .5s}
.stage li{position:relative;z-index:1;text-align:center;flex:1;min-width:0}
.stage .dot{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--card);border:2px solid var(--line);font-size:11px;font-weight:700;color:var(--mut)}
.stage li.done .dot{background:var(--ok);border-color:var(--ok);color:#fff}
.stage li.cur .dot{background:var(--acc);border-color:var(--acc);color:#fff;box-shadow:0 0 0 4px color-mix(in srgb,var(--acc) 22%,transparent)}
.stage small{display:block;font-size:10.5px;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stage li.cur small{color:var(--ink);font-weight:600}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px}
@media(max-width:820px){.kpis{grid-template-columns:repeat(2,1fr)}}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px}
.kpi .v{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;margin:2px 0 6px}
.bar{height:8px;border-radius:99px;background:var(--line);overflow:hidden;margin:4px 0}
.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--acc),color-mix(in srgb,var(--acc) 60%,var(--ok)));border-radius:99px;transition:width .5s}
.bar.ok i{background:var(--ok)}.bar.over i{background:var(--bad)}
.relay{display:flex;gap:6px;overflow-x:auto;padding:6px 2px 10px;align-items:center}
.leg{flex:0 0 auto;min-width:96px;border:1px solid var(--line);border-radius:12px;padding:7px 10px;background:var(--soft);text-align:center}
.leg .ico{display:block;font-size:16px;line-height:1.2}
.leg b{display:block;font-size:12px}
.leg small{font-variant-numeric:tabular-nums}
.leg.done{border-color:var(--ok)}.leg.done .ico{color:var(--ok)}
.leg.running{border-color:var(--run);background:color-mix(in srgb,var(--run) 12%,var(--card));animation:bob 1s infinite alternate}
.leg.running small{color:var(--run);font-weight:600}
.leg.blocked{border-color:var(--bad)}.leg.blocked .ico{color:var(--bad)}
.baton{font-size:18px;color:var(--mut);opacity:.5}.baton.pass{color:var(--ok);opacity:1}
@keyframes bob{to{transform:translateY(-2px)}}
.grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:12px}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
.phase{margin-bottom:12px}
.phase .head{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px}
.phase .head b{font-size:15px}
.lane{margin-top:8px}.lane>small{text-transform:uppercase;letter-spacing:.05em;font-size:10.5px}
details.t{border:1px solid var(--line);border-radius:11px;margin:6px 0;background:var(--soft)}
details.t summary{cursor:pointer;padding:8px 10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;list-style:none}
details.t summary::-webkit-details-marker{display:none}
.chip{font-size:11px;padding:1px 9px;border-radius:99px;color:#fff;background:var(--mut);text-transform:capitalize}
.chip.approved{background:var(--acc)}.chip.running{background:var(--run)}.chip.done{background:var(--ok)}.chip.blocked{background:var(--bad)}
.ttl{flex:1;min-width:140px}.tm{font-variant-numeric:tabular-nums;font-size:12px;color:var(--mut)}
.body{padding:2px 12px 10px;font-size:13px}
.body ul{margin:4px 0;padding-left:18px}
.det{background:var(--card);border-left:3px solid var(--acc);padding:6px 10px;border-radius:6px;margin:6px 0}
button{font:inherit;cursor:pointer;border-radius:9px;padding:6px 12px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
button.primary{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}
button.add{font-size:12px;padding:4px 10px;color:var(--acc);border-color:var(--acc)}
button.copy{font-size:12px}
.msgs{list-style:none;margin:0;padding:0}
.msgs li{padding:7px 0;border-top:1px solid var(--line);font-size:13px}
.msgs li:first-child{border-top:0}
.tag{font-size:10px;text-transform:uppercase;letter-spacing:.05em;padding:1px 6px;border-radius:6px;background:var(--soft);color:var(--mut);margin-right:6px}
.tag.new{background:var(--acc);color:#fff}
.tokbar{display:flex;height:10px;border-radius:99px;overflow:hidden;background:var(--line);margin:6px 0}
.tokbar i{display:block}
table{width:100%;border-collapse:collapse}td{padding:3px 0;font-variant-numeric:tabular-nums}td:last-child{text-align:right}
.big{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
.est{color:var(--warn);font-size:11px}
.composer{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:10px 16px;display:flex;gap:8px;align-items:flex-end;box-shadow:0 -4px 16px rgba(16,24,40,.06)}
.composer textarea{flex:1;resize:none;min-height:40px;max-height:120px;font:inherit;padding:9px 11px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
.sheet{position:fixed;inset:0;background:rgba(10,14,24,.45);display:grid;place-items:center;padding:16px;z-index:5}
.sheet[hidden]{display:none}
.sheet .panel{background:var(--card);border-radius:16px;padding:16px;width:min(520px,100%);box-shadow:0 20px 60px rgba(0,0,0,.25)}
.sheet textarea{width:100%;font:inherit;padding:9px 11px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--ink);margin:6px 0 10px}
.row{display:flex;gap:8px;justify-content:flex-end;align-items:center;flex-wrap:wrap}
.foot{font-size:12px;color:var(--mut);margin-right:auto}
"""

JS = r"""(function(){
var cfg = window.FORGE_LIVE, live = document.getElementById('live'), conn = document.getElementById('conn');
var KEY = 'forge-open', openSet = {};
try { JSON.parse(sessionStorage.getItem(KEY) || '[]').forEach(function(id){ openSet[id] = true; }); } catch (err) {}
function saveOpen(){ try { sessionStorage.setItem(KEY, JSON.stringify(Object.keys(openSet))); } catch (err) {} }
function applyOpen(){ live.querySelectorAll('details[data-id]').forEach(function(d){ d.open = !!openSet[d.dataset.id]; }); }
live.addEventListener('toggle', function(ev){
  var d = ev.target;
  if (d.dataset && d.dataset.id) { if (d.open) openSet[d.dataset.id] = true; else delete openSet[d.dataset.id]; saveOpen(); }
}, true);
function setConn(ok){ conn.textContent = ok ? 'live' : 'offline: run /forge-dashboard'; conn.className = 'conn ' + (ok ? 'ok' : 'bad'); }
function refresh(){
  if (!cfg || document.hidden) return;
  fetch('/fragment', {cache: 'no-store'}).then(function(r){ if (!r.ok) throw new Error(r.status); return r.text(); })
    .then(function(h){ live.innerHTML = h; applyOpen(); setConn(true); })
    .catch(function(){ setConn(false); });
}
function post(path, body){
  return fetch(path, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Forge-Token': cfg.token},
    body: JSON.stringify(body)}).then(function(r){ if (!r.ok) throw new Error(r.status); return r.json(); });
}
var sheet = document.getElementById('sheet'), sheetFor = document.getElementById('sheet-for'),
    sheetText = document.getElementById('sheet-text'), sheetMsg = document.getElementById('sheet-msg'),
    prompt = document.getElementById('prompt'), foot = document.getElementById('foot');
function openSheet(id){
  sheetFor.dataset.ticket = id; sheetFor.textContent = id; sheetText.value = ''; sheetMsg.textContent = '';
  sheet.hidden = false; sheetText.focus();
}
function closeSheet(){ sheet.hidden = true; }
function sendPrompt(){
  var t = prompt.value.trim(); if (!t) return;
  post('/api/prompt', {text: t}).then(function(){ prompt.value = ''; foot.textContent = 'Queued. Forge reads it before the next build wave.'; refresh(); })
    .catch(function(){ foot.textContent = 'Could not send. Is the dashboard still running?'; });
}
function saveDetail(){
  var t = sheetText.value.trim(); if (!t) return;
  post('/api/detail', {ticket: sheetFor.dataset.ticket, text: t}).then(function(){ closeSheet(); refresh(); })
    .catch(function(){ sheetMsg.textContent = 'Could not save. Is the dashboard still running?'; });
}
document.addEventListener('click', function(ev){
  var el = ev.target;
  var add = el.closest && el.closest('[data-add]');
  if (add) { openSheet(add.dataset.add); return; }
  var cp = el.closest && el.closest('[data-copy]');
  if (cp && navigator.clipboard) { navigator.clipboard.writeText(cp.dataset.copy).then(function(){ cp.textContent = 'Copied'; }); return; }
  if (el.id === 'sheet-cancel' || el === sheet) { closeSheet(); return; }
  if (el.id === 'sheet-save') { saveDetail(); return; }
  if (el.id === 'send') { sendPrompt(); }
});
document.addEventListener('keydown', function(ev){
  if (ev.key === 'Escape' && !sheet.hidden) closeSheet();
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && document.activeElement === prompt) sendPrompt();
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && document.activeElement === sheetText) saveDetail();
});
if (cfg) { setInterval(refresh, 3000); } else if (conn) { conn.textContent = 'snapshot'; }
})();"""


def stage_html(st):
    step, fin = st["step"], st["finished"]
    nodes = []
    for i, nm in enumerate(F.STEPS, 1):
        cls = "done" if (fin or i < step) else ("cur" if i == step else "")
        nodes.append('<li class="%s"><span class="dot">%s</span><small>%s</small></li>' % (
            cls, "&#10003;" if cls == "done" else str(i), e(nm)))
    fill = 100 if fin else max(0, min(100, (max(step, 1) - 1) * 100 // 8))
    return '<ol class="stage"><div class="rail"><i style="width:%d%%"></i></div>%s</ol>' % (fill, "".join(nodes))


def race_seconds(tks, now):
    starts = [a for a in (tui.when(x.get("started")) for x in tks) if a]
    if not starts:
        return None
    ends = [tui.when(x.get("finished")) or now for x in tks if tui.when(x.get("started"))]
    return int((max(ends) - min(starts)).total_seconds())


def avg_leg(tks, now):
    secs = [tui.leg_seconds(x, now) for x in tks if x["status"] == "done"]
    secs = [s for s in secs if s is not None]
    return sum(secs) / len(secs) if secs else None


def kpis_html(st, s, now):
    tks = list(st["tickets"].values())
    tk_pct, tok_pct = pct(s["done"], s["n"]), pct(s["used"], s["expected"])
    race = race_seconds(tks, now)
    avg = avg_leg(tks, now)
    tiles = [
        ("Tickets", "%d / %d" % (s["done"], s["n"]), bar(tk_pct, "ok" if s["n"] and s["done"] == s["n"] else ""), "%d%% done" % tk_pct),
        ("Tokens used", n(s["used"]), bar(tok_pct, "over" if s["expected"] and s["used"] > s["expected"] else ""),
         "of %s expected" % n(s["expected"])),
        ("Saved vs baseline", n(s["saved"]), "", "estimate, not measured"),
        ("Race time", tui.fmt_dur(race), "", "avg leg %s" % tui.fmt_dur(int(avg) if avg is not None else None)),
    ]
    return '<div class="kpis">%s</div>' % "".join(
        '<div class="kpi"><small>%s</small><div class="v">%s</div>%s<small>%s</small></div>' % (a, b, c, d) for a, b, c, d in tiles)


def relay_html(st, now):
    tks = list(st["tickets"].values())
    if not tks:
        return '<div class="card"><h2>Relay</h2><small>No runners yet. The baton waits for approval.</small></div>'
    parts = []
    for k, x in enumerate(tks):
        s_ = x["status"]
        if k:
            parts.append('<span class="baton %s">&#10140;</span>' % ("pass" if tks[k - 1]["status"] == "done" else ""))
        ico = {"done": "&#10003;", "blocked": "&#10007;", "running": "&#127939;"}.get(s_, "&#9675;")
        parts.append('<div class="leg %s"><span class="ico">%s</span><b>%s</b><small>%s</small></div>' % (
            s_, ico, e(x["id"]), tui.fmt_dur(tui.leg_seconds(x, now))))
    return '<div class="card"><h2>Relay race</h2><div class="relay">%s</div></div>' % "".join(parts)


def ticket_html(t, now, live):
    est = t["est"]["total"]
    a = t.get("actual")
    if a:
        u = F.fresh(a)
        used = "%s / %s" % (n(u), n(est))
    else:
        used = ("estimated " if t["status"] == "done" else "est ") + n(est)
    b = []
    if t["description"]:
        b.append("<p>%s</p>" % e(t["description"]))
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
        b.append("<div><b>shortcut:</b><ul>%s</ul></div>" % "".join(
            "<li><code>%s:%d</code> %s</li>" % (e(s["file"]), s["line"], e(s["text"])) for s in t["shortcuts"]))
    if t["gap"]:
        b.append('<div style="color:var(--bad)"><b>Gap / blocker:</b> %s</div>' % e(t["gap"]))
    if t.get("outside_reads"):
        b.append('<div class="est">Read outside pack: %s</div>' % e(", ".join(t["outside_reads"])))
    det = t.get("details") or []
    if det:
        b.append('<div class="det"><b>Your details</b><ul>%s</ul></div>' % "".join(
            "<li>%s <small>%s</small></li>" % (e(d["text"]), e(d["t"][11:16])) for d in det))
    if live:
        b.append('<button class="add" data-add="%s">+ Add detail</button>' % e(t["id"]))
    deps = (" &larr; " + ", ".join(e(d) for d in t["deps"])) if t["deps"] else ""
    flags = "" if t["parallel_safe"] else ' <span class="pill">not parallel-safe</span>'
    return ('<details class="t" data-id="%s"><summary><span class="chip %s">%s</span><b>%s</b>'
            '<span class="ttl">%s<small>%s</small></span><span class="tm">%s</span><span class="tm">%s</span>%s'
            '<span class="tm">%s &middot; %s</span></summary><div class="body">%s</div></details>') % (
        e(t["id"]), t["status"], t["status"], e(t["id"]), e(t["title"]), deps, tui.fmt_dur(tui.leg_seconds(t, now)),
        used, flags, t["complexity"], t["model"], "".join(b) or "<small>No detail yet.</small>")


def phase_html(st, p, now, live):
    ts = [st["tickets"][i] for i in p["tickets"]]
    lanes = {}
    for t in ts:
        lanes.setdefault(t["group"], []).append(t)
    body = "".join('<div class="lane"><small>lane %s</small>%s</div>' % (
        e(g), "".join(ticket_html(t, now, live) for t in v)) for g, v in lanes.items())
    badge = '<span class="pill acc">Phase cleared</span>' if p["cleared"] else ""
    return ('<div class="card phase"><div class="head"><div><b>%s</b> <small>%s</small> %s</div>'
            '<small>%d/%d &middot; est %s &middot; used %s</small></div>%s%s</div>') % (
        e(p["id"]), e(p["title"]), badge, p["done"], p["n"], n(p["expected"]), n(p["used"]),
        bar(p["pct"], "ok" if p["cleared"] else ""), body or "<small>No tickets.</small>")


def tokens_html(s):
    io = s["io"]
    tot = max(1, io["input"] + io["output"] + io["cache_write"])
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
    split = ('<div class="tokbar"><i style="width:%d%%;background:var(--acc)"></i><i style="width:%d%%;background:var(--xp)"></i>'
             '<i style="width:%d%%;background:var(--run)"></i></div>') % (
        pct(io["input"], tot), pct(io["output"], tot), pct(io["cache_write"], tot))
    return ('<div class="card"><h2>Tokens</h2>%s<table>%s</table><hr style="border:0;border-top:1px solid var(--line)">'
            '<small>Saved vs unguided baseline <span class="est">(estimate)</span></small><div class="big">%s</div>'
            '<small>Plan projects %s <span class="est">(estimate)</span></small>'
            '<p class="mut" style="font-size:11px;margin:6px 0 0">Used = input + cache-write + output from transcripts. '
            'Cache reads are shown separately.</p></div>') % (
        split, "".join("<tr><td class=mut>%s</td><td>%s</td></tr>" % (e(a), e(b)) for a, b in rows),
        n(s["saved"]), n(s["proj_saved"]))


def inbox_html(st, live):
    msgs = st["inbox"][-6:]
    if not msgs:
        hint = "Messages you send here appear in this list. Forge reads them before the next build wave." if live else "Messages are sent from the live dashboard."
        return '<div class="card"><h2>Messages to Forge</h2><small>None yet. %s</small></div>' % hint
    items = "".join('<li><span class="tag%s">%s</span>%s%s <small>%s</small></li>' % (
        "" if m["read"] else " new", "read" if m["read"] else "new",
        e("[%s] " % m["ticket"]) if m.get("ticket") else "", e(m["text"]), e(m["t"][11:16])) for m in reversed(msgs))
    return '<div class="card"><h2>Messages to Forge</h2><ul class="msgs">%s</ul></div>' % items


def events_html(st):
    if not st["events"]:
        return ""
    items = "".join("<li><small>%s</small> %s</li>" % (e(x["t"][11:19]), e(x["msg"])) for x in reversed(st["events"][-8:]))
    return '<div class="card"><h2>Activity</h2><ul class="msgs">%s</ul></div>' % items


def hold_html(st):
    if st["approval"]["state"] == "pending" and st["tickets"]:
        return ('<div class="hold"><div><b>Plan ready for review.</b> Add details to any ticket, then approve in chat with '
                '<code>/forge-approve all</code>, <code>phase N</code> or ticket IDs.</div>'
                '<button class="copy" data-copy="/forge-approve all">Copy command</button></div>')
    return ""


def render_live(st, live=True):
    """The data panels. The live page swaps this in every 3s; the controls stay outside it."""
    now = now_utc()
    s = F.summarize(st)
    alerts = ""
    if st["blockers"]:
        alerts = '<div class="alert"><b>Blockers</b><ul>%s</ul></div>' % "".join("<li>%s</li>" % e(b) for b in st["blockers"])
    phases = "".join(phase_html(st, p, now, live) for p in s["phases"]) or '<div class="card"><small>No plan yet.</small></div>'
    skipped = ""
    if st["skipped"]:
        skipped = '<div class="card"><h2>Skipped / not requested</h2><ul>%s</ul></div>' % "".join(
            "<li>%s</li>" % e(x) for x in st["skipped"])
    return "".join([
        hold_html(st), alerts, stage_html(st), kpis_html(st, s, now), relay_html(st, now),
        '<div class="grid"><div>%s</div><aside>%s%s%s%s</aside></div>' % (
            phases, inbox_html(st, live), tokens_html(s), skipped, events_html(st)),
    ])


def render_html(st, live=None):
    """Full page. live = {"port", "token"} turns on the controls (served by dash_server.py); None = static snapshot."""
    s = F.summarize(st)
    ap = st["approval"]["state"]
    badges = "".join('<span class="pill">%s</span>' % x for x in (
        "ponytail: %s" % e(st["ponytail_level"]), "tests: %s" % e(st["test_mode"]), "approval: %s" % e(ap),
        "%d%% complete" % s["pct"]))
    head = ('<header class="hdr"><div><span style="font-size:18px">&#9874;</span> <h1>Forge</h1>'
            '<span class="name">%s</span></div><div class="pills">%s<span id="conn" class="conn">connecting</span></div></header>') % (
        e(st["feature"] or "no active run"), badges)
    if live:
        controls = ('<form id="composer" class="composer" onsubmit="return false">'
                    '<textarea id="prompt" rows="1" placeholder="Message Forge, e.g. skip the i18n part, or reuse utils.py" aria-label="Message Forge"></textarea>'
                    '<button id="send" type="button" class="primary">Send</button><span id="foot" class="foot"></span></form>'
                    '<div id="sheet" class="sheet" hidden><div class="panel" role="dialog" aria-modal="true">'
                    '<h2>Add detail to <span id="sheet-for"></span></h2>'
                    '<small>Extra context, constraints or acceptance notes. The agent building this ticket sees them.</small>'
                    '<textarea id="sheet-text" rows="4" aria-label="Detail"></textarea>'
                    '<div class="row"><span id="sheet-msg" class="foot"></span>'
                    '<button id="sheet-cancel" type="button">Cancel</button>'
                    '<button id="sheet-save" type="button" class="primary">Save detail</button></div></div></div>')
    else:
        controls = ('<p class="mut" style="text-align:center;font-size:12px">Snapshot. Live controls (add details, '
                    'send messages) need the dashboard server: run <code>/forge-dashboard</code>.</p>')
    script = "<script>window.FORGE_LIVE = %s;</script><script>%s</script>" % (json.dumps(live), JS)
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>Forge - %s</title><style>%s</style></head><body><div class="wrap">%s'
            '<main id="live">%s</main>%s</div>%s</body></html>') % (
        e(st["feature"] or "no run"), CSS, head, render_live(st, live=bool(live)), controls, script)


def terminal(st):
    return tui.render_text(st, 100)


def write(root, st):
    """Static snapshot for when the server is off. Written on every state change."""
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
