#!/usr/bin/env python3
"""Forge terminal UI: live `watch`, one-shot `status`, one-line `statusline`. Stdlib only."""
import datetime
import json
import os
import re
import select
import shutil
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import forge_lib as F  # noqa: E402

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
TOKEN_RE = re.compile(r"(\x1b\[[0-9;?]*[A-Za-z])|([^\x1b]+)")
ACC, OK, WARN, BAD, RUN, XP, MUT, BORDER, INK, FAINT = 105, 78, 214, 203, 75, 220, 245, 240, 252, 238
LANES = [105, 75, 141, 213, 81, 215]

UNI = dict(tl="╭", tr="╮", bl="╰", br="╯", h="─", v="│", full="█", empty="░", part=" ▏▎▍▌▋▊▉", done="✔", bad="✖",
           pend="○", appr="◐", spin="⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏", dot="●", cur="◉", hv="━", tm="├─", tl_="└─", star="★",
           hammer="⚒", sep="·", arrow="▸", pause="‖", flag="⚑", up="▲", down="▼", ell="…", run="▶", dia="◆", ret="↳", runA="o/", runB="\\o", link="━►", idle="┄┄")
ASC = dict(tl="+", tr="+", bl="+", br="+", h="-", v="|", full="#", empty=".", part="", done="v", bad="x",
           pend="o", appr="~", spin="|/-\\", dot="*", cur="@", hv="=", tm="|-", tl_="`-", star="*",
           hammer="#", sep="-", arrow=">", pause="||", flag="!", up="^", down="v", ell="~", run=">", dia="*", ret="->", runA="o/", runB="\\o", link="=>", idle="..")


class Theme:
    def __init__(self, color=True, uni=True):
        self.color, self.uni = color, uni
        self.g = UNI if uni else ASC

    def c(self, code, s, bold=False, dim=False):
        if not self.color or not s:
            return s
        return "\x1b[%s38;5;%dm%s\x1b[0m" % ("1;" if bold else ("2;" if dim else ""), code, s)


def vlen(s):
    return len(ANSI_RE.sub("", s))


def clip(s, w, ell="…"):
    if vlen(s) <= w:
        return s
    keep, out, n = max(0, w - 1), [], 0
    for m in TOKEN_RE.finditer(s):
        if m.group(1):
            out.append(m.group(1))
            continue
        txt = m.group(2)
        room = keep - n
        if len(txt) <= room:
            out.append(txt)
            n += len(txt)
        else:
            out.append(txt[:max(0, room)])
            break
    return "".join(out) + ell + ("\x1b[0m" if "\x1b" in s else "")


def rpad(s, w):
    return s + " " * max(0, w - vlen(s))


def lpad(s, w):
    return " " * max(0, w - vlen(s)) + s


def hn(x):
    x = int(x)
    if abs(x) < 1000:
        return str(x)
    if abs(x) < 1000000:
        return ("%.1fk" % (x / 1000)).replace(".0k", "k")
    return ("%.2fM" % (x / 1e6)).replace(".00M", "M")


def sg(x):
    return ("+" if x > 0 else "") + hn(x)


def bar(t, frac, width, pal=(OK,)):
    frac = max(0.0, min(1.0, frac))
    eighths = int(round(frac * width * 8)) if t.uni else int(round(frac * width)) * 8
    full, part = eighths // 8, eighths % 8
    cells = []
    for i in range(width):
        col = pal[min(len(pal) - 1, i * len(pal) // max(1, width))]
        if i < full:
            cells.append(t.c(col, t.g["full"]))
        elif i == full and part and t.g["part"]:
            cells.append(t.c(col, t.g["part"][part]))
        else:
            cells.append(t.c(FAINT, t.g["empty"]))
    return "".join(cells)


def box(t, title, body, w, color=BORDER):
    g, inner = t.g, w - 2
    ttl = (" " + title + " ") if title else ""
    top = t.c(color, g["tl"] + g["h"]) + t.c(INK, ttl, bold=True) + t.c(color, g["h"] * max(0, inner - 1 - len(ttl)) + g["tr"])
    out = [top]
    for ln in body:
        out.append(t.c(color, g["v"]) + " " + rpad(clip(ln, w - 4, g["ell"]), w - 4) + " " + t.c(color, g["v"]))
    out.append(t.c(color, g["bl"] + g["h"] * inner + g["br"]))
    return out


def side_by_side(a, b, wa):
    res = []
    for i in range(max(len(a), len(b))):
        res.append(rpad(a[i] if i < len(a) else "", wa) + " " + (b[i] if i < len(b) else ""))
    return res


# ----------------------------------------------------------------------------- sections
def header(t, st, s, W, tick):
    g = t.g
    left = t.c(XP, g["hammer"] + " FORGE", bold=True) + "  " + t.c(INK, st["feature"] or "no active run", bold=True)
    ap = st["approval"]["state"]
    apc = {"approved": OK, "partial": WARN, "pending": WARN}.get(ap, MUT)
    right = "   ".join([t.c(MUT, "ponytail ") + t.c(ACC, st["ponytail_level"], bold=True),
                        t.c(MUT, "tests ") + t.c(INK, st["test_mode"]),
                        t.c(MUT, "approval ") + t.c(apc, ap, bold=True)])
    left = clip(left, max(10, W - vlen(right) - 2), g["ell"])
    top = left + " " * max(2, W - vlen(left) - vlen(right)) + right
    step, fin = st["step"], st["finished"]
    nodes = []
    for i in range(1, 10):
        if fin or i < step:
            nodes.append(t.c(OK, g["dot"]))
        elif i == step:
            nodes.append(t.c(ACC, g["cur"] if tick % 4 < 3 else g["dot"], bold=True))
        else:
            nodes.append(t.c(FAINT, g["pend"]))
        if i < 9:
            done = fin or i < step
            nodes.append(t.c(OK, g["hv"] * 2) if done else t.c(FAINT, g["h"] * 2))
    name = "Shipped" if fin else (F.STEPS[step - 1] if 1 <= step <= 9 else "Idle")
    label = t.c(ACC, "Step %d/9" % max(step, 1), bold=True) + "  " + t.c(INK, name)
    return [top, "".join(nodes) + "   " + label]


def progress_box(t, st, s, W):
    g = t.g
    xpw = 18
    r1 = t.c(XP, "Lv %d" % s["level"], bold=True) + " " + t.c(INK, s["title"], bold=True) + "  " + \
        bar(t, (s["xp"] % 60) / 60, xpw, (XP, 214, 208)) + "  " + t.c(MUT, "%d XP" % s["xp"])
    ow = max(10, min(40, W - 40))
    r2 = t.c(MUT, "Overall ") + bar(t, s["pct"] / 100, ow, (OK,)) + " " + t.c(INK, "%d%%" % s["pct"], bold=True)
    ts = st["tests"]["status"]
    tcol = {"pass": OK, "fail": BAD, "running": RUN}.get(ts, MUT)
    bk = s["budget_kept"]
    pills = [
        t.c(OK if s["done"] else MUT, "%s %d/%d tickets" % (g["done"], s["done"], s["n"])),
        t.c(tcol, "%s tests %s" % (g["dia"], ts)),
        t.c(OK if bk else (BAD if bk is False else MUT), "%s budget %s" % (g["star"], "kept" if bk else ("over" if bk is False else "n/a"))),
        t.c(XP if s["shipped"] else MUT, "%s %s" % (g["flag"], "SHIPPED" if s["shipped"] else "not shipped")),
        t.c(MUT, "+%d -%d lines" % (s["lines_add"], s["lines_rem"])),
    ]
    return box(t, "Progress", [r1, r2, "   ".join(pills)], W)


def alerts(t, st, W, toasts):
    g, out = t.g, []
    for txt, col in toasts:
        out.append(t.c(col, " %s %s" % (g["star"], txt), bold=True))
    if st["approval"]["state"] == "pending" and st["tickets"]:
        out += box(t, "Awaiting approval", [t.c(WARN, "%s Nothing runs until you approve:  " % g["pause"]) + t.c(INK, "/forge-approve all", bold=True)
                                            + t.c(MUT, "  |  phase N  |  <ticket ids>")], W, WARN)
    if st["blockers"]:
        out += box(t, "Blockers", [t.c(BAD, "%s %s" % (g["bad"], b)) for b in st["blockers"][-4:]], W, BAD)
    return out


ICON_COL = {"pending": MUT, "approved": ACC, "running": RUN, "done": OK, "blocked": BAD}


def icon(t, status, tick):
    g = t.g
    if status == "running":
        return t.c(RUN, g["spin"][tick % len(g["spin"])], bold=True)
    return t.c(ICON_COL[status], {"pending": g["pend"], "approved": g["appr"], "done": g["done"], "blocked": g["bad"]}[status], bold=status in ("done", "blocked"))


def ticket_meta(t, tk, narrow):
    """Returns column segments [lane, lines, tokens, flags] so rows align within a phase."""
    g = t.g
    a = tk.get("actual")
    est = tk["est"]["total"]
    lane = t.c(LANES[ord(tk["group"][:1] or "A") % len(LANES)], "[%s]" % tk["group"])
    lines = "" if narrow else t.c(OK, "+%d" % tk["lines"]["added"]) + " " + t.c(BAD, "-%d" % tk["lines"]["removed"])
    if a:
        u = F.fresh(a)
        d = round(100 * (u - est) / est) if est else 0
        col = OK if d <= 0 else (WARN if d <= 25 else BAD)
        tok = t.c(INK, "%s/%s" % (hn(u), hn(est))) + " " + t.c(col, "%s%d%%" % (g["down"] if d <= 0 else g["up"], abs(d)))
    elif tk["status"] == "done":
        tok = t.c(WARN, "est %s" % hn(est))
    else:
        tok = t.c(MUT, "est %s" % hn(est))
    flags = []
    if tk["model"] == "opus":
        flags.append(t.c(ACC, g["dia"] + "opus"))
    if tk["shortcuts"]:
        flags.append(t.c(WARN, "%s%d" % (g["flag"], len(tk["shortcuts"]))))
    return [lane, lines, tok, " ".join(flags)]


def phases_box(t, st, s, W, tick, compact):
    g, iw, body = t.g, W - 4, []
    narrow = iw < 70
    if not s["phases"]:
        msg = "No plan yet. Run /forge <request>." if not st["feature"] else "Planning has not produced tickets yet."
        return box(t, "Phases", [t.c(MUT, msg)], W)
    for p in s["phases"]:
        tks = [st["tickets"][i] for i in p["tickets"]]
        running = sum(1 for x in tks if x["status"] == "running")
        left = t.c(INK, "%s %s" % (p["id"], p["title"]), bold=True) + "  " + bar(t, p["pct"] / 100, 10, (OK,)) + " " + \
            t.c(INK, "%d/%d" % (p["done"], p["n"]))
        if p["cleared"]:
            left += "  " + t.c(XP, "%s CLEARED" % g["star"], bold=True)
        elif running > 1:
            left += "  " + t.c(RUN, "%s %d in parallel" % (g["run"], running))
        right = t.c(MUT, "est %s %s used %s" % (hn(p["expected"]), g["sep"], hn(p["used"])))
        body.append(left + " " * max(1, iw - vlen(left) - vlen(right)) + right)
        if compact and p["cleared"]:
            continue
        idw = max(len(x["id"]) for x in tks) if tks else 4
        segs = [ticket_meta(t, x, narrow) for x in tks]
        cw = [max(vlen(sg_[i]) for sg_ in segs) for i in range(4)] if segs else [0] * 4
        metas = ["  ".join(rpad(sg_[i], cw[i]) if i != 2 else lpad(sg_[i], cw[i]) for i in range(4) if cw[i]).rstrip() for sg_ in segs]
        mw = max([vlen(m) for m in metas] or [0])
        for k, (x, meta) in enumerate(zip(tks, metas)):
            last = k == len(tks) - 1
            head = " " + t.c(BORDER, g["tl_"] if last else g["tm"]) + " " + icon(t, x["status"], tick) + " " + t.c(INK if x["status"] != "pending" else MUT, rpad(x["id"], idw), bold=x["status"] == "running") + " "
            tw = max(6, iw - vlen(head) - mw - 1)
            title = x["title"] + (t.c(MUT, " %s%s" % ("<-" if not t.uni else "←", ",".join(x["deps"]))) if x["deps"] and x["status"] in ("pending", "approved") else "")
            body.append(head + rpad(clip(title, tw, g["ell"]), tw) + " " + rpad(meta, mw))
            if not compact and not narrow:
                cont = " " + t.c(BORDER, "  " if last else g["v"] + " ") + "   "
                if x["gap"]:
                    body.append(cont + t.c(BAD, "%s %s" % (g["ret"], x["gap"])))
                elif x["status"] == "done" and x["closing"]:
                    body.append(cont + t.c(MUT, "%s %s" % (g["ret"], x["closing"][0]), dim=True))
        body.append("")
    if body and body[-1] == "":
        body.pop()
    return box(t, "Phases", body, W)


def tokens_box(t, st, s, W):
    g, iw = t.g, W - 4
    lw = 11
    bw = max(6, min(30, iw - lw - 8))
    over = s["expected"] and s["used"] > s["expected"]
    ex = max(1, s["expected"])
    io = s["io"]
    rows = [
        t.c(MUT, rpad("Expected", lw)) + bar(t, 1.0, bw, (ACC,)) + " " + t.c(INK, hn(s["expected"]), bold=True),
        t.c(MUT, rpad("Used", lw)) + bar(t, s["used"] / ex, bw, (BAD,) if over else (OK, OK, WARN)) + " " + t.c(BAD if over else INK, hn(s["used"]), bold=True),
        t.c(MUT, rpad("Remaining", lw)) + t.c(BAD if s["remaining"] < 0 else INK, sg(s["remaining"]) if s["remaining"] < 0 else hn(s["remaining"])) + t.c(MUT, "   range %s-%s" % (hn(s["est_low"]), hn(s["est_high"]))),
        t.c(BORDER, g["h"] * iw),
        t.c(MUT, "in ") + t.c(INK, hn(io["input"])) + t.c(MUT, "  out ") + t.c(INK, hn(io["output"])),
        t.c(MUT, "cache r ") + t.c(INK, hn(io["cache_read"])) + t.c(MUT, "  w ") + t.c(INK, hn(io["cache_write"])),
        t.c(MUT, "variance ") + t.c(OK if s["var"] <= 0 else WARN, sg(s["var"])) + t.c(MUT, " (done)"),
    ]
    if s["unmeasured"]:
        rows.append(t.c(WARN, "unmeasured %s (est.)" % hn(s["unmeasured"])))
    if s["overhead"]:
        rows.append(t.c(MUT, "overhead " + " ".join("%s %s" % (k[:4], hn(F.fresh(v))) for k, v in s["overhead"].items())))
    rows += [t.c(BORDER, g["h"] * iw),
             t.c(MUT, "SAVED vs baseline ") + t.c(WARN, "(est.)"),
             t.c(OK if s["saved"] >= 0 else BAD, "  " + hn(s["saved"]), bold=True) + t.c(MUT, "   plan projects %s" % hn(s["proj_saved"]))]
    return box(t, "Tokens", rows, W)


# ----------------------------------------------------------------------------- relay
QUIPS = {
    "start": ["On your marks, the baton is waiting", "Stretching hamstrings, nobody move yet"],
    "run": ["Sprinting through the edits", "Dodging merge conflicts at full speed", "Legs pumping, lungs burning", "Lap time is ticking"],
    "slow": ["Taking the scenic route", "Slow down, Usain", "This leg has turned into a marathon"],
    "finish": ["Crossed the line, baton delivered", "Every runner home, nothing dropped"],
}


def quip(kind, tick):
    opts = QUIPS[kind]
    return opts[(tick // 15) % len(opts)]


def when(v):
    try:
        return datetime.datetime.fromisoformat(v) if v else None
    except ValueError:
        return None


def leg_seconds(tk, now):
    a = when(tk.get("started"))
    if a is None:
        return None
    b = when(tk.get("finished")) or (now if tk["status"] == "running" else None)
    return None if b is None else max(0, int((b - a).total_seconds()))


def fmt_dur(sec):
    if sec is None:
        return "--:--"
    if sec >= 3600:
        return "%dh%02dm" % (sec // 3600, sec % 3600 // 60)
    return "%d:%02d" % (sec // 60, sec % 60)


def relay_box(t, st, W, tick, now):
    """Each ticket is one leg. The runner carries the baton along the track; a finished leg hands it on."""
    g, iw = t.g, W - 4
    tks = list(st["tickets"].values())
    if not tks:
        return box(t, "Relay race", [t.c(MUT, "No runners yet. The baton waits for /forge-approve.")], W)
    idw = max(5, max(len(x["id"]) for x in tks))
    cw = idw + 9  # icon (2) + space + id + space + time (5)
    cols = max(1, (iw + 4) // (cw + 4))  # each leg joins the next with " link "
    secs = [leg_seconds(x, now) for x in tks]
    done = [s_ for x, s_ in zip(tks, secs) if x["status"] == "done" and s_ is not None]
    avg = sum(done) / len(done) if done else 0
    cells = []
    for x, sec in zip(tks, secs):
        run = x["status"] == "running"
        if run:
            ic = t.c(RUN, g["runA"] if (tick // 3) % 2 == 0 else g["runB"], bold=True)
            tcol = RUN
        else:
            ic = rpad(icon(t, x["status"], tick), 2)
            tcol = {"done": INK, "blocked": BAD}.get(x["status"], MUT)
        cells.append(ic + " " + t.c(INK if x["status"] != "pending" else MUT, rpad(x["id"], idw), bold=run) + " " + t.c(tcol, lpad(fmt_dur(sec), 5)))
    body = []
    for r in range(0, len(tks), cols):
        end = min(r + cols, len(tks))
        row = ""
        for j in range(r, end):
            row += cells[j]
            if j + 1 < end:
                row += " " + (t.c(OK, g["link"]) if tks[j]["status"] == "done" else t.c(FAINT, g["idle"])) + " "
        body.append(row)
    running = [x for x, s_ in zip(tks, secs) if x["status"] == "running"]
    body.append("")
    if running:
        r0, sec = running[0], leg_seconds(running[0], now)
        slow = bool(avg) and sec is not None and sec > 2 * avg
        body.append(t.c(RUN, "%s %s" % (r0["id"], fmt_dur(sec)), bold=True) + t.c(MUT, "  %s  " % g["sep"])
                    + t.c(WARN if slow else INK, quip("slow" if slow else "run", tick)))
    elif all(x["status"] == "done" for x in tks):
        body.append(t.c(XP, "%s %s" % (g["star"], quip("finish", tick)), bold=True))
    else:
        body.append(t.c(MUT, quip("start", tick)))
    nd = sum(1 for x in tks if x["status"] == "done")
    line = "legs %d/%d done  %s  avg leg %s" % (nd, len(tks), g["sep"], fmt_dur(int(avg)) if done else "--:--")
    starts = [a for a in (when(x.get("started")) for x in tks) if a]
    if starts:
        ends = [when(x.get("finished")) or now for x in tks if when(x.get("started"))]
        race = fmt_dur(int((max(ends) - min(starts)).total_seconds()))
        line = "race %s  %s  %s" % (race, g["sep"], line)
    body.append(t.c(MUT, line))
    return box(t, "Relay race", body, W)


def side_boxes(t, st, W):
    out = []
    if st["skipped"]:
        out += box(t, "Skipped / not requested", [t.c(MUT, "- ") + x for x in st["skipped"][:5]], W)
    if st["events"]:
        ev = ["%s  %s" % (t.c(MUT, e["t"][11:19]), e["msg"]) for e in reversed(st["events"][-5:])]
        out += box(t, "Activity", ev, W)
    return out


# ----------------------------------------------------------------------------- frame
def render(st, width=100, theme=None, tick=0, toasts=(), compact=False):
    t = theme or Theme(False, True)
    W = max(50, width)
    if st is None:
        return [t.c(WARN, "Forge is not initialised in this project. Run /forge-init, then /forge <request>.")]
    s = F.summarize(st)
    L = header(t, st, s, W, tick) + [""]
    L += progress_box(t, st, s, W)
    if not compact:
        L += relay_box(t, st, W, tick, datetime.datetime.now(datetime.timezone.utc))
    L += alerts(t, st, W, toasts)
    if W >= 112:
        rw = 40
        lw = W - rw - 1
        left = phases_box(t, st, s, lw, tick, compact)
        right = tokens_box(t, st, s, rw) + (side_boxes(t, st, rw) if not compact else [])
        L += side_by_side(left, right, lw)
    else:
        L += phases_box(t, st, s, W, tick, compact) + tokens_box(t, st, s, W)
        if not compact:
            L += side_boxes(t, st, W)
    return L


def render_text(st, width=100, color=False, uni=None):
    uni = (sys.stdout.encoding or "").lower().startswith("utf") if uni is None else uni
    return "\n".join(clip(l, width) for l in render(st, width, Theme(color, uni)))


def brief(st):
    """Plain few-line summary for the chat at each gate. The full layout stays in watch and the dashboard."""
    if st is None:
        return "Forge is not initialised. Run /forge-init."
    s = F.summarize(st)
    step = st["step"]
    name = "Shipped" if st["finished"] else (F.STEPS[step - 1] if 1 <= step <= 9 else "Idle")
    rem = sg(s["remaining"]) if s["remaining"] < 0 else hn(s["remaining"])
    lines = [
        "Forge %s: step %d/9 %s, approval %s, tests %s" % (st["feature"] or "no run", max(step, 1), name,
                                                        st["approval"]["state"], st["tests"]["status"]),
        "Tickets %d/%d done, tokens %s/%s (remaining %s)%s" % (s["done"], s["n"], hn(s["used"]), hn(s["expected"]), rem,
                                                          " saved ~%s (est.)" % hn(s["saved"]) if s["saved"] > 0 else ""),
    ]
    for p in s["phases"]:
        open_ids = [i for i in p["tickets"] if st["tickets"][i]["status"] != "done"]
        mark = "cleared" if p["cleared"] else "%d/%d" % (p["done"], p["n"])
        tail = " | open " + ", ".join(open_ids[:6]) if open_ids and not p["cleared"] else ""
        lines.append("%s %s: %s, est %s%s" % (p["id"], p["title"], mark, hn(p["expected"]), tail))
    if st["blockers"]:
        lines.append("Blocked: " + "; ".join(st["blockers"][-3:]))
    return "\n".join(lines)


# ----------------------------------------------------------------------------- statusline
def statusline(raw):
    try:
        data = json.loads(raw) if raw.strip() else {}
    except ValueError:
        data = {}
    cwd = (data.get("workspace") or {}).get("current_dir") or data.get("cwd")
    root = F.find_root(cwd)
    st = F.load(root) if root else None
    if not F.is_active(st):
        return ""
    t, g = Theme(True, True), UNI
    s = F.summarize(st)
    sep = t.c(BORDER, " │ ")
    step = st["step"]
    head = t.c(XP, g["hammer"] + " Forge", bold=True) + " " + t.c(ACC, "%d/9 %s" % (step, F.STEPS[step - 1] if 1 <= step <= 9 else "Idle"), bold=True)
    parts = [head]
    if st["approval"]["state"] == "pending" and st["tickets"]:
        parts.append(t.c(WARN, "%s awaiting /forge-approve" % g["pause"], bold=True))
        parts.append(t.c(INK, "%d tickets %s est %s" % (s["n"], g["sep"], hn(s["expected"]))))
    elif s["n"]:
        run = sum(1 for x in st["tickets"].values() if x["status"] == "running")
        parts.append(bar(t, s["pct"] / 100, 8, (OK,)) + " " + t.c(INK, "%d/%d" % (s["done"], s["n"])))
        if run:
            parts.append(t.c(RUN, "%s %d running" % (g["run"], run)))
        blocked = sum(1 for x in st["tickets"].values() if x["status"] == "blocked")
        if blocked:
            parts.append(t.c(BAD, "%s %d blocked" % (g["bad"], blocked)))
        parts.append(t.c(INK, "%s/%s tok" % (hn(s["used"]), hn(s["expected"]))))
        if s["saved"] > 0:
            parts.append(t.c(OK, "%s saved ~%s" % (g["star"], hn(s["saved"]))))
    return sep.join(parts)


# ----------------------------------------------------------------------------- watch
class Keys:
    """Non-blocking single-key input; no-op when stdin is not a TTY."""
    def __init__(self):
        self.on = sys.stdin.isatty()
        self.old = None
        if self.on and os.name != "nt":
            import termios
            import tty
            self.fd = sys.stdin.fileno()
            self.old = termios.tcgetattr(self.fd)
            tty.setcbreak(self.fd)

    def read(self, timeout):
        if not self.on:
            time.sleep(timeout)
            return ""
        if os.name == "nt":
            import msvcrt
            end = time.time() + timeout
            while time.time() < end:
                if msvcrt.kbhit():
                    return msvcrt.getwch()
                time.sleep(0.03)
            return ""
        r, _, _ = select.select([sys.stdin], [], [], timeout)
        return os.read(self.fd, 8).decode(errors="ignore") if r else ""

    def close(self):
        if self.old is not None:
            import termios
            termios.tcsetattr(self.fd, termios.TCSADRAIN, self.old)


def diff_toasts(old, new):
    out = []
    if not old or not new or old.get("slug") != new.get("slug"):
        return out
    now = datetime.datetime.now(datetime.timezone.utc)
    for i, t in new["tickets"].items():
        was = (old["tickets"].get(i) or {}).get("status")
        if was and was != t["status"]:
            if t["status"] == "done":
                out.append(("%s baton passed after %s  +10 XP" % (i, fmt_dur(leg_seconds(t, now))), OK))
            elif t["status"] == "blocked":
                out.append(("%s dropped the baton" % i, BAD))
            elif t["status"] == "running":
                out.append(("%s grabbed the baton" % i, RUN))
    so, sn = F.summarize(old), F.summarize(new)
    if sn["cleared"] > so["cleared"]:
        out.append(("Phase cleared  +25 XP", XP))
    if sn["shipped"] and not so["shipped"]:
        out.append(("FEATURE SHIPPED", XP))
    if new["tests"]["status"] != old["tests"]["status"] and new["tests"]["status"] in ("pass", "fail"):
        out.append(("tests %s" % new["tests"]["status"], OK if new["tests"]["status"] == "pass" else BAD))
    return out


def watch(root, ascii_=False, color=None):
    uni = not ascii_ and (sys.stdout.encoding or "").lower().startswith("utf")
    tty = sys.stdout.isatty()
    use_color = (tty and not os.environ.get("NO_COLOR") and os.environ.get("TERM") != "dumb") if color is None else color
    theme = Theme(use_color, uni)
    if not tty:
        w = shutil.get_terminal_size((100, 30)).columns
        print("\n".join(render(F.load(root), w, theme)))
        return
    if os.name == "nt":
        os.system("")  # enable VT sequences
    out = sys.stdout
    out.write("\x1b[?1049h\x1b[?25l")
    out.flush()
    keys = Keys()
    st, last_m, tick, off, compact = None, None, 0, 0, False
    toasts, prev_size = [], None
    try:
        while True:
            try:
                m = os.path.getmtime(F.state_path(root))
            except OSError:
                m = None
            if m != last_m:
                new = F.load(root)
                for txt, col in diff_toasts(st, new):
                    toasts.append((txt, col, time.time() + 6))
                st, last_m = new, m
            toasts = [x for x in toasts if x[2] > time.time()]
            size = shutil.get_terminal_size((100, 30))
            if size != prev_size:
                out.write("\x1b[2J")
                prev_size = size
            width, height = max(50, min(size.columns, 200)), size.lines
            footer = theme.c(MUT, " q quit  j/k scroll  c compact  r reload   updated %s" % time.strftime("%H:%M:%S"))
            lines = render(st, width, theme, tick, [(a, b) for a, b, _ in toasts], compact)
            if len(lines) > height - 1 and not compact:
                lines = render(st, width, theme, tick, [(a, b) for a, b, _ in toasts], True)
            off = max(0, min(off, max(0, len(lines) - (height - 1))))
            view = lines[off:off + height - 1] + [footer]
            out.write("\x1b[H" + "".join(clip(l, width) + "\x1b[K\n" for l in view[:-1]) + clip(view[-1], width) + "\x1b[K\x1b[J")
            out.flush()
            tick += 1
            running = st and any(x["status"] == "running" for x in st["tickets"].values())
            k = keys.read(0.2 if running or toasts else 0.5)
            if k in ("q", "Q", "\x03"):
                break
            if k in ("j", "\x1b[B"):
                off += 3
            elif k in ("k", "\x1b[A"):
                off -= 3
            elif k == "c":
                compact = not compact
            elif k == "r":
                last_m = None
    except KeyboardInterrupt:
        pass
    finally:
        keys.close()
        out.write("\x1b[?25h\x1b[?1049l")
        out.flush()


def hint(root):
    launcher = os.path.join(F.forge_dir(root), "forge.py")
    snip = {"statusLine": {"type": "command", "command": "[ -f .claude/forge/forge.py ] && python .claude/forge/forge.py statusline || true"}}
    return ("LIVE TERMINAL VIEW - open a second terminal in this project and run:\n  python %s watch\n"
            "  (q quits, j/k scroll, c compact; --ascii for plain terminals)\n\n"
            "OPTIONAL status bar inside Claude Code - add to ~/.claude/settings.json (or .claude/settings.local.json):\n%s\n"
            "  (works when Claude Code is started from the project root; shows nothing when no Forge run is active)\n"
            % (launcher, json.dumps(snip, indent=2)))
