#!/usr/bin/env python3
"""TUI tests: layouts at several widths, ASCII mode, statusline, and a live `watch` in a real pty."""
import json, os, pty, re, select, subprocess, sys, tempfile, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCR = os.path.join(os.path.dirname(HERE), "forge", "scripts")
sys.path.insert(0, SCR)
import forge_lib as F, tui  # noqa: E402

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def make_state():
    st = F.new_state("Demo feature", "demo")
    st["step"] = 5
    st["phases"] = [{"id": "P1", "title": "Core"}, {"id": "P2", "title": "Wire"}]
    def tk(i, ph, status, **kw):
        t = {"id": i, "phase": ph, "title": "Ticket %s with a fairly long descriptive title here" % i, "description": "", "edit": [], "create": [], "read": [],
             "symbols": [], "imitate": [], "conventions": [], "deps": kw.get("deps", []), "group": kw.get("group", "A"), "parallel_safe": True,
             "complexity": "M", "model": kw.get("model", "sonnet"), "tests_later": [], "est": {"input": 4000, "output": 600, "total": 4600, "low": 3200, "high": 6900, "baseline": 20000},
             "status": status, "actual": kw.get("actual"), "lines": {"added": 12, "removed": 3}, "closing": kw.get("closing", []), "shortcuts": [], "touched": [], "gap": kw.get("gap", ""), "summary": ""}
        st["tickets"][i] = t
    tk("P1-T1", "P1", "done", actual={"input": 900, "output": 700, "cache_read": 9000, "cache_write": 2000, "turns": 4, "exact": True}, closing=["Skipped: i18n."])
    tk("P1-T2", "P1", "running", group="B")
    tk("P1-T3", "P1", "running", group="C", model="opus")
    tk("P2-T1", "P2", "approved", deps=["P1-T1"])
    tk("P2-T2", "P2", "blocked", gap="needs API key decision")
    st["approval"] = {"state": "partial", "approved": []}
    st["blockers"] = ["P2-T2: needs API key decision"]
    st["skipped"] = ["i18n", "extra options"]
    st["events"] = [{"t": "2026-10-13T10:00:00+00:00", "msg": "P1-T1 -> done"}]
    return st


class T(unittest.TestCase):
    def test_widths_and_color(self):
        st = make_state()
        for w in (50, 60, 80, 100, 120, 160, 200):
            for color in (False, True):
                for compact in (False, True):
                    lines = tui.render(st, w, tui.Theme(color, True), tick=3, toasts=[("P1-T1 cleared  +10 XP", tui.OK)], compact=compact)
                    for l in lines:
                        self.assertLessEqual(tui.vlen(tui.clip(l, w)), w, (w, l))
                    # boxes must be rectangular: every line of a box has the same visible width
                    widths = {tui.vlen(l) for l in lines if l.startswith(("╭", "│", "╰"))}
                    self.assertLessEqual(len(widths), 2 if w >= 112 else 1, (w, widths))

    def test_ascii_mode_is_pure_ascii(self):
        out = tui.render_text(make_state(), 100, color=False, uni=False)
        out.encode("ascii")

    def test_no_state(self):
        self.assertIn("not initialised", tui.render(None, 80)[0])

    def test_statusline(self):
        d = tempfile.mkdtemp(); os.makedirs(os.path.join(d, ".claude/forge"))
        self.assertEqual(tui.statusline(json.dumps({"cwd": d})), "")  # no state -> nothing
        F.save(d, make_state())
        out = ANSI.sub("", tui.statusline(json.dumps({"workspace": {"current_dir": d}})))
        self.assertIn("Forge", out); self.assertIn("5/9", out); self.assertIn("1/5", out); self.assertIn("1 running" if False else "2 running", out); self.assertIn("1 blocked", out)
        self.assertLess(len(out), 140)

    def test_toasts(self):
        a, b = make_state(), make_state()
        b["tickets"]["P1-T2"]["status"] = "done"
        # The relay-race toast ("baton passed after <time>"); the leg time depends on the clock, so match the prefix.
        toasts = [x[0] for x in tui.diff_toasts(a, b)]
        self.assertTrue(toasts and toasts[0].startswith("P1-T2 baton passed after "), toasts)
        self.assertTrue(toasts[0].endswith("  +10 XP"), toasts)

    def test_watch_in_pty(self):
        d = tempfile.mkdtemp(); os.makedirs(os.path.join(d, ".claude/forge"))
        st = make_state(); F.save(d, st)
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(d)
            os.environ.update(TERM="xterm-256color", PYTHONIOENCODING="utf-8", LANG="C.UTF-8")
            os.execvp("python", ["python", os.path.join(SCR, "forge_cli.py"), "watch"])
        import fcntl, struct, termios
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 130, 0, 0))
        buf = b""
        def pump(sec):
            nonlocal buf
            end = time.time() + sec
            while time.time() < end:
                r, _, _ = select.select([fd], [], [], 0.1)
                if r:
                    try: buf += os.read(fd, 65536)
                    except OSError: return
        pump(1.2)
        self.assertIn(b"\x1b[?1049h", buf); self.assertIn("Demo feature".encode(), buf)
        # live update: finish a ticket and watch the toast + new state appear
        st["tickets"]["P1-T2"]["status"] = "done"; F.save(d, st)
        mark = len(buf); pump(1.5)
        self.assertIn(b"P1-T2 baton passed after", buf[mark:])
        os.write(fd, b"q"); pump(1.0)
        _, status = os.waitpid(pid, 0)
        self.assertEqual(os.WEXITSTATUS(status), 0)
        self.assertTrue(buf.rstrip().endswith(b"\x1b[?25h\x1b[?1049l") or b"\x1b[?1049l" in buf[-40:])


if __name__ == "__main__":
    unittest.main(verbosity=2)
