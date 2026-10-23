#!/usr/bin/env python3
"""Forge project-root lookup. Kept apart from forge_lib so the hooks can find the root and skip the
library when no Forge run exists. Python 3.8+, stdlib only."""
import os
import subprocess


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
