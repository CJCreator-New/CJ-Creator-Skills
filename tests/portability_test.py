#!/usr/bin/env python3
"""Portability tests: manifests agree, the portable skill is self-contained, every CLI command the
docs mention exists, and init + the instructions section work with no Claude environment variables."""
import json, os, re, shutil, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
PLUG = os.path.join(REPO, "forge")
SCR = os.path.join(PLUG, "scripts")
sys.path.insert(0, SCR)
import forge_lib as F  # noqa: E402

CLAUDE_ENV = ("CLAUDE_PROJECT_DIR", "CLAUDE_PLUGIN_ROOT", "CLAUDE_ENV_FILE", "FORGE_ROOT")


def clean_env():
    env = {k: v for k, v in os.environ.items() if k not in CLAUDE_ENV}
    env["FORGE_NO_DASHBOARD"] = "1"
    return env


def run_cli(cwd, *args):
    r = subprocess.run([sys.executable, os.path.join(SCR, "forge_cli.py")] + list(args),
                       cwd=cwd, env=clean_env(), capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


class Manifests(unittest.TestCase):
    PATHS = [
        ".claude-plugin/plugin.json",      # Claude Code
        "gemini-extension.json",           # Gemini CLI
        "plugin.json",                     # GitHub Copilot CLI
        ".codex-plugin/plugin.json",       # OpenAI Codex CLI
        ".cursor-plugin/plugin.json",      # Cursor
    ]

    def test_all_manifests_parse_and_agree(self):
        for p in self.PATHS:
            with open(os.path.join(PLUG, p), encoding="utf-8") as f:
                m = json.load(f)
            self.assertEqual(m["name"], "forge", p)
            self.assertEqual(m["version"], F.VERSION, p)
            self.assertTrue(m.get("description"), p)

    def test_marketplace_lists_the_plugin_at_the_same_version(self):
        with open(os.path.join(REPO, ".claude-plugin", "marketplace.json"), encoding="utf-8") as f:
            entry = json.load(f)["plugins"][0]
        self.assertEqual(entry["name"], "forge")
        self.assertEqual(entry["version"], F.VERSION)
        self.assertEqual(entry["source"], "./forge")

    def test_gemini_context_file_exists(self):
        with open(os.path.join(PLUG, "gemini-extension.json"), encoding="utf-8") as f:
            ctx = json.load(f)["contextFileName"]
        self.assertTrue(os.path.isfile(os.path.join(PLUG, ctx)))


class PortableSkill(unittest.TestCase):
    SKILL = os.path.join(PLUG, "skills", "forge", "SKILL.md")

    def setUp(self):
        with open(self.SKILL, encoding="utf-8") as f:
            self.text = f.read()
        m = re.match(r"^---\n(.*?)\n---\n", self.text, re.S)
        self.assertIsNotNone(m, "SKILL.md needs YAML frontmatter")
        self.front = {}
        for line in m.group(1).splitlines():
            k, _, v = line.partition(":")
            self.front[k.strip()] = v.strip().strip('"')

    def test_frontmatter_matches_folder(self):
        self.assertEqual(self.front["name"], os.path.basename(os.path.dirname(self.SKILL)))
        self.assertTrue(0 < len(self.front["description"]) <= 1024)

    def test_no_claude_only_variables(self):
        self.assertNotIn("${CLAUDE_", self.text)
        self.assertNotIn("CLAUDE_PLUGIN_ROOT", self.text)

    def test_bootstrap_path_resolves_from_skill_folder(self):
        # Setup says the plugin folder is two levels above SKILL.md; that must hold.
        self.assertTrue(os.path.isfile(os.path.normpath(os.path.join(
            os.path.dirname(self.SKILL), "..", "..", "scripts", "forge_cli.py"))))

    def test_ponytail_lives_outside_skills(self):
        # Ponytail must not auto-trigger in normal chat, so it stays out of skills/.
        self.assertFalse(os.path.exists(os.path.join(PLUG, "skills", "ponytail")))


class DocsMatchCli(unittest.TestCase):
    """Every `F <cmd>` / `forge.py <cmd>` in the runbook and prompts must be a real subcommand."""

    def test_referenced_commands_exist(self):
        with open(os.path.join(SCR, "forge_cli.py"), encoding="utf-8") as f:
            defined = set(re.findall(r'add\("([a-z-]+)"', f.read()))
        self.assertIn("claude-md", defined)
        files = [os.path.join(PLUG, "skills", "forge", "SKILL.md")]
        for sub in ("commands", "agents"):
            d = os.path.join(PLUG, sub)
            files += [os.path.join(d, n) for n in os.listdir(d) if n.endswith(".md")]
        missing = {}
        for p in files:
            with open(p, encoding="utf-8") as f:
                text = f.read()
            used = set(re.findall(r"\bF ([a-z][a-z-]*)\b", text))
            used |= set(re.findall(r"forge\.py ([a-z][a-z-]*)\b", text))
            bad = sorted(u for u in used if u not in defined)
            if bad:
                missing[os.path.relpath(p, PLUG)] = bad
        self.assertEqual(missing, {})


class NoClaudeEnvironment(unittest.TestCase):
    def test_init_and_instructions_file_work_without_claude_vars(self):
        d = tempfile.mkdtemp(prefix="forge-port-")
        rc, out = run_cli(d, "init")
        self.assertEqual(rc, 0, out)
        rc, out = run_cli(d, "new-run", "Portable check", "--request", "check")
        self.assertEqual(rc, 0, out)
        rc, out = run_cli(d, "claude-md", "apply", "--file", "AGENTS.md")
        self.assertEqual(rc, 0, out)
        self.assertIn("AGENTS.md updated", out)
        with open(os.path.join(d, "AGENTS.md"), encoding="utf-8") as f:
            self.assertIn("<!-- forge:start -->", f.read())
        rc, out = run_cli(d, "claude-md", "check", "--file", "AGENTS.md")
        self.assertEqual(out.strip(), "present")
        rc, out = run_cli(d, "claude-md", "check")  # default target stays CLAUDE.md
        self.assertEqual(out.strip(), "missing")
        self.assertFalse(os.path.exists(os.path.join(d, "CLAUDE.md")))

    def test_section_is_idempotent(self):
        d = tempfile.mkdtemp(prefix="forge-port-")
        p = os.path.join(d, "AGENTS.md")
        run_cli(d, "init")
        run_cli(d, "claude-md", "apply", "--file", "AGENTS.md")
        with open(p, encoding="utf-8") as f:
            first = f.read()
        run_cli(d, "claude-md", "apply", "--file", "AGENTS.md")
        with open(p, encoding="utf-8") as f:
            self.assertEqual(first, f.read())


class HookInterpreter(unittest.TestCase):
    """Hooks must find a Python 3 under python3, python or py, because macOS and Linux often lack `python`."""
    HOOKS = os.path.join(PLUG, "hooks", "hooks.json")

    def commands(self):
        with open(self.HOOKS, encoding="utf-8") as f:
            cfg = json.load(f)
        return [h["command"] for ev in cfg["hooks"].values() for g in ev for h in g["hooks"]]

    def test_every_hook_uses_the_resolver(self):
        cmds = self.commands()
        self.assertTrue(cmds)
        for c in cmds:
            self.assertIn("for p in python3 python py", c)
            self.assertIn("hook.py", c)

    def test_resolver_uses_python3_and_fails_open(self):
        sh = shutil.which("sh")
        if not sh:
            self.skipTest("no POSIX sh on this machine")
        cmd = self.commands()[-1].replace("sh -c", '"%s" -c' % sh, 1)  # the Stop hook
        env = {"CLAUDE_PLUGIN_ROOT": PLUG, "PATH": ""}
        # Only a python3 that is not a real Python 3.8+ (exits 1 on the probe): the resolver must skip it and fail open.
        d = tempfile.mkdtemp(prefix="forge-hook-")
        fake = os.path.join(d, "python3")
        with open(fake, "w", encoding="utf-8", newline="\n") as f:
            f.write("#!/bin/sh\nexit 1\n")
        os.chmod(fake, 0o755)
        env["PATH"] = d
        r = subprocess.run([sh, "-c", cmd], input="{}", env=env, cwd=d, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stderr, "")
        # A real interpreter behind python3 is used: the hook runs and exits 0 with no active run.
        with open(fake, "w", encoding="utf-8", newline="\n") as f:
            f.write('#!/bin/sh\nexec "%s" "$@"\n' % sys.executable.replace("\\", "/"))
        r = subprocess.run([sh, "-c", cmd], input="{}", env=env, cwd=d, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
