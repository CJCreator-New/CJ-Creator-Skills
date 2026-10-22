#!/bin/sh
# Install the CJ Creator skills (Forge and repo-orchestrator) for Claude Code, and the
# portable skills for every other agent that reads ~/.agents/skills.
#
#   curl -fsSL https://raw.githubusercontent.com/CJCreator-New/CJ-Creator-Skills/main/install.sh | sh
#   sh install.sh [--ref <branch|tag>] [--agents-dir <dir>] [--skip-claude] [--skip-agents]
#
# Run it again to update. Run it from a checkout to install that checkout in place.
# Environment overrides: CJ_SKILLS_REPO, CJ_SKILLS_REF, CJ_SKILLS_HOME, CJ_SKILLS_AGENTS_DIR.

set -eu

REPO="${CJ_SKILLS_REPO:-CJCreator-New/CJ-Creator-Skills}"
REF="${CJ_SKILLS_REF:-main}"
DEST="${CJ_SKILLS_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/cj-creator-skills}"
AGENTS_DIR="${CJ_SKILLS_AGENTS_DIR:-$HOME/.agents/skills}"
MARKETPLACE="forge-marketplace"
DO_CLAUDE=1
DO_AGENTS=1

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) [ $# -ge 2 ] || die "--ref needs a value"; REF="$2"; shift 2 ;;
    --agents-dir) [ $# -ge 2 ] || die "--agents-dir needs a value"; AGENTS_DIR="$2"; shift 2 ;;
    --skip-claude) DO_CLAUDE=0; shift ;;
    --skip-agents) DO_AGENTS=0; shift ;;
    -h|--help)
      say "usage: sh install.sh [--ref <branch|tag>] [--agents-dir <dir>] [--skip-claude] [--skip-agents]"
      exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

# A checkout next to this script wins. A piped script ($0 is "sh") has no checkout, so fetch one.
SRC=""
case "$0" in
  */install.sh|install.sh)
    here=$(cd "$(dirname "$0")" && pwd)
    if [ -f "$here/.claude-plugin/marketplace.json" ]; then SRC="$here"; fi
    ;;
esac

download() { # url, destination file
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    die "need git, curl or wget to download the skills"
  fi
}

fetch_repo() {
  mkdir -p "$(dirname "$DEST")"
  if command -v git >/dev/null 2>&1 && [ -d "$DEST/.git" ]; then
    say "Updating $DEST to $REF"
    git -C "$DEST" fetch --quiet --depth 1 origin "$REF"
    # DEST is a managed install copy, not a workspace: match the fetched ref exactly.
    git -C "$DEST" reset --quiet --hard FETCH_HEAD
  elif command -v git >/dev/null 2>&1; then
    say "Downloading $REPO@$REF to $DEST"
    rm -rf "$DEST"
    git clone --quiet --depth 1 --branch "$REF" "https://github.com/$REPO.git" "$DEST"
  else
    say "Downloading $REPO@$REF to $DEST (git not found, using the archive)"
    tmp=$(mktemp -d)
    download "https://github.com/$REPO/archive/$REF.tar.gz" "$tmp/src.tgz"
    rm -rf "$DEST"
    mkdir -p "$DEST"
    tar -xzf "$tmp/src.tgz" -C "$DEST" --strip-components=1
    rm -rf "$tmp"
  fi
}

install_claude() {
  if ! command -v claude >/dev/null 2>&1; then
    warn "Claude Code CLI not found, so the Claude plugins were skipped."
    warn "Install Claude Code (https://claude.com/claude-code), then run this script again."
    return 0
  fi
  say "Claude Code: registering $MARKETPLACE from $SRC"
  # 'marketplace add' keeps an existing entry even when it points somewhere else. Re-point it
  # when the source differs. Removing it also uninstalls its plugins, so the reinstall below restores them.
  listing=$(claude plugin marketplace list 2>/dev/null || true)
  case "$listing" in
    *"$MARKETPLACE"*)
      case "$listing" in
        *"($SRC)"*) ;;
        *) say "  re-pointing $MARKETPLACE (its source changed)"
           claude plugin marketplace remove "$MARKETPLACE" ;;
      esac ;;
  esac
  claude plugin marketplace add "$SRC"
  claude plugin marketplace update "$MARKETPLACE"
  for plugin in forge repo-orchestrator frontend-engineer backend-engineer e2e-engineer; do
    claude plugin install "$plugin@$MARKETPLACE"
    claude plugin update "$plugin@$MARKETPLACE"
  done
}

install_agents() {
  # Only ponytail goes to other agents. It is plain instructions. repo-orchestrator needs the
  # Claude Code Agent tool and subagents, so it stays Claude-only.
  mkdir -p "$AGENTS_DIR"
  rm -rf "$AGENTS_DIR/ponytail"
  cp -R "$SRC/forge/ponytail" "$AGENTS_DIR/ponytail"
  say "Other agents: ponytail -> $AGENTS_DIR/ponytail"
}

if [ -z "$SRC" ]; then
  fetch_repo
  SRC="$DEST"
fi
[ -f "$SRC/.claude-plugin/marketplace.json" ] || die "$SRC is not the CJ Creator skills repository"

if [ "$DO_CLAUDE" -eq 1 ]; then install_claude; fi
if [ "$DO_AGENTS" -eq 1 ]; then install_agents; fi

if ! command -v python >/dev/null 2>&1; then
  warn "'python' not found. Forge runs its hooks and commands with 'python' (Python 3.8+), so install it or alias it."
fi

say ""
say "Done. Source: $SRC"
say "Claude Code: start a new session (or run /reload-plugins). In a project, run /forge-init once, then /forge <request>."
say "Other agents: skills are in $AGENTS_DIR."
