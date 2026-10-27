#!/usr/bin/env python3
"""The forge hook imports forge_lib only when a Forge run exists, so ordinary sessions skip it."""
import json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(os.path.dirname(HERE), "forge", "scripts")

# Runs the hook's main() in a fresh interpreter and reports whether forge_lib was loaded.
PROBE = """
import io, json, sys
sys.argv = ["hook.py", "pre-tool"]
sys.stdin = io.StringIO(json.dumps({"tool_name": "Read", "tool_input": {"file_path": "x.py"}, "cwd": %r}))
sys.path.insert(0, %r)
import hook
hook.main()
print("loaded" if "forge_lib" in sys.modules else "skipped")
"""


def probe(cwd, env=None):
    code = PROBE % (cwd, SCRIPTS)
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env, timeout=60)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip().splitlines()[-1]


class T(unittest.TestCase):
    def test_plain_project_does_not_load_forge_lib(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(probe(d, env=dict(os.environ, CLAUDE_PROJECT_DIR="")), "skipped")

    def test_forge_project_loads_forge_lib(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, ".claude", "forge"))
            with open(os.path.join(d, ".claude", "forge", "state.json"), "w") as f:
                json.dump({}, f)
            self.assertEqual(probe(d, env=dict(os.environ, CLAUDE_PROJECT_DIR="")), "loaded")

    def test_state_found_through_claude_project_dir_loads_forge_lib(self):
        with tempfile.TemporaryDirectory() as project, tempfile.TemporaryDirectory() as elsewhere:
            os.makedirs(os.path.join(project, ".claude", "forge"))
            with open(os.path.join(project, ".claude", "forge", "state.json"), "w") as f:
                json.dump({}, f)
            self.assertEqual(probe(elsewhere, env=dict(os.environ, CLAUDE_PROJECT_DIR=project)), "loaded")


if __name__ == "__main__":
    unittest.main(verbosity=2)
