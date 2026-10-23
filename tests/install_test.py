#!/usr/bin/env python3
"""install.sh tests: runs the real script against a stub `claude` CLI and a temp agents dir. POSIX only."""
import os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
STUB = """#!/bin/sh
echo "$*" >> "$STUB_LOG"
if [ "$1" = plugin ] && [ "$2" = marketplace ] && [ "$3" = list ]; then printf '%s\\n' "$STUB_LIST"; fi
"""


@unittest.skipIf(os.name == "nt", "install.sh is POSIX sh")
class T(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.bin = os.path.join(self.tmp.name, "bin")
        self.agents = os.path.join(self.tmp.name, "agents")
        self.log = os.path.join(self.tmp.name, "claude.log")
        os.makedirs(self.bin)
        with open(os.path.join(self.bin, "claude"), "w") as f:
            f.write(STUB)
        os.chmod(os.path.join(self.bin, "claude"), 0o755)

    def tearDown(self):
        self.tmp.cleanup()

    def run_install(self, *args, list_output=""):
        env = dict(os.environ, PATH=self.bin + os.pathsep + os.environ["PATH"],
                   STUB_LOG=self.log, STUB_LIST=list_output)
        r = subprocess.run(["sh", os.path.join(ROOT, "install.sh"), "--agents-dir", self.agents, *args],
                           cwd=ROOT, env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return r.stdout + r.stderr

    def claude_calls(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log) as f:
            return f.read().splitlines()

    def test_registers_and_installs_both_plugins(self):
        self.run_install()
        self.assertEqual(self.claude_calls(), [
            "plugin marketplace list",
            "plugin marketplace add " + ROOT,
            "plugin marketplace update forge-marketplace",
            "plugin install forge@forge-marketplace",
            "plugin update forge@forge-marketplace",
            "plugin install repo-orchestrator@forge-marketplace",
            "plugin update repo-orchestrator@forge-marketplace",
            "plugin install frontend-engineer@forge-marketplace",
            "plugin update frontend-engineer@forge-marketplace",
            "plugin install backend-engineer@forge-marketplace",
            "plugin update backend-engineer@forge-marketplace",
            "plugin install e2e-engineer@forge-marketplace",
            "plugin update e2e-engineer@forge-marketplace",
            "plugin install security-audit@forge-marketplace",
            "plugin update security-audit@forge-marketplace",
        ])

    def test_portable_skill_copied_and_claude_only_skill_not(self):
        self.run_install()
        self.assertTrue(os.path.isfile(os.path.join(self.agents, "ponytail", "SKILL.md")))
        self.assertFalse(os.path.exists(os.path.join(self.agents, "orchestrate")))

    def test_rerun_replaces_portable_copy(self):
        self.run_install()
        stale = os.path.join(self.agents, "ponytail", "stale.txt")
        open(stale, "w").close()
        self.run_install()
        self.assertFalse(os.path.exists(stale))
        self.assertTrue(os.path.isfile(os.path.join(self.agents, "ponytail", "SKILL.md")))

    def test_repoints_marketplace_when_source_differs(self):
        self.run_install(list_output="  > forge-marketplace\n    Source: Folder (/somewhere/else)")
        calls = self.claude_calls()
        self.assertIn("plugin marketplace remove forge-marketplace", calls)
        self.assertLess(calls.index("plugin marketplace remove forge-marketplace"),
                        calls.index("plugin marketplace add " + ROOT))

    def test_keeps_marketplace_when_source_matches(self):
        self.run_install(list_output="  > forge-marketplace\n    Source: Folder (%s)" % ROOT)
        self.assertNotIn("plugin marketplace remove forge-marketplace", self.claude_calls())

    def test_skip_flags(self):
        self.run_install("--skip-claude")
        self.assertEqual(self.claude_calls(), [])
        self.assertTrue(os.path.isfile(os.path.join(self.agents, "ponytail", "SKILL.md")))

        self.run_install("--skip-agents", "--skip-claude")
        self.assertTrue(os.path.isfile(os.path.join(self.agents, "ponytail", "SKILL.md")))

    def test_rejects_unknown_option(self):
        r = subprocess.run(["sh", os.path.join(ROOT, "install.sh"), "--nope"],
                           cwd=ROOT, capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("unknown option", r.stderr)


if __name__ == "__main__":
    sys.exit(unittest.main())
