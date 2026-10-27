# Install the CJ Creator skills (every plugin in the marketplace) for Claude Code, and the
# portable skill for every other agent that reads ~/.agents/skills. Windows PowerShell 5.1 or pwsh.
#
#   irm https://raw.githubusercontent.com/CJCreator-New/CJ-Creator-Skills/main/install.ps1 | iex
#   .\install.ps1 [-Ref <branch|tag>] [-AgentsDir <dir>] [-SkipClaude] [-SkipAgents]
#
# Piped through iex there are no parameters, so set $env:CJ_SKILLS_REF or $env:CJ_SKILLS_AGENTS_DIR instead.
# Run it again to update. Run it from a checkout to install that checkout in place.

param(
  [string]$Ref = $(if ($env:CJ_SKILLS_REF) { $env:CJ_SKILLS_REF } else { 'main' }),
  [string]$AgentsDir = $(if ($env:CJ_SKILLS_AGENTS_DIR) { $env:CJ_SKILLS_AGENTS_DIR } else { Join-Path $HOME '.agents\skills' }),
  [switch]$SkipClaude,
  [switch]$SkipAgents
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 defaults to TLS 1.0/1.1, which GitHub refuses.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = if ($env:CJ_SKILLS_REPO) { $env:CJ_SKILLS_REPO } else { 'CJCreator-New/CJ-Creator-Skills' }
$Dest = if ($env:CJ_SKILLS_HOME) { $env:CJ_SKILLS_HOME } else { Join-Path $env:LOCALAPPDATA 'cj-creator-skills' }
$Marketplace = 'forge-marketplace'

function Write-Note([string]$Text) { Write-Host $Text }

function Invoke-Native([string]$What, [scriptblock]$Command) {
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)" }
}

function Fetch-Repo {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Dest) | Out-Null
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($git -and (Test-Path (Join-Path $Dest '.git'))) {
    Write-Note "Updating $Dest to $Ref"
    Invoke-Native 'git fetch' { git -C $Dest fetch --quiet --depth 1 origin $Ref }
    # Dest is a managed install copy, not a workspace: match the fetched ref exactly.
    Invoke-Native 'git reset' { git -C $Dest reset --quiet --hard FETCH_HEAD }
  } elseif ($git) {
    Write-Note "Downloading $Repo@$Ref to $Dest"
    if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
    Invoke-Native 'git clone' { git clone --quiet --depth 1 --branch $Ref "https://github.com/$Repo.git" $Dest }
  } else {
    Write-Note "Downloading $Repo@$Ref to $Dest (git not found, using the archive)"
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('cj-skills-' + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp | Out-Null
    $zip = Join-Path $tmp 'src.zip'
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$Repo/archive/$Ref.zip" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $inner = Get-ChildItem -Directory $tmp | Select-Object -First 1
    if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
    Move-Item $inner.FullName $Dest
    Remove-Item -Recurse -Force $tmp
  }
}

function Install-Claude {
  $claude = Get-Command claude -ErrorAction SilentlyContinue
  if (-not $claude) {
    Write-Warning 'Claude Code CLI not found, so the Claude plugins were skipped.'
    Write-Warning 'Install Claude Code (https://claude.com/claude-code), then run this script again.'
    return
  }
  Write-Note "Claude Code: registering $Marketplace from $Src"
  # 'marketplace add' keeps an existing entry even when it points somewhere else. Re-point it
  # when the source differs. Removing it also uninstalls its plugins, so the reinstall below restores them.
  $listing = ((& claude plugin marketplace list 2>$null) -join "`n").Replace('\', '/')
  if ($listing.Contains($Marketplace) -and -not $listing.Contains("($($Src.Replace('\', '/')))")) {
    Write-Note "  re-pointing $Marketplace (its source changed)"
    Invoke-Native 'marketplace remove' { claude plugin marketplace remove $Marketplace }
  }
  Invoke-Native 'marketplace add' { claude plugin marketplace add $Src }
  Invoke-Native 'marketplace update' { claude plugin marketplace update $Marketplace }
  foreach ($plugin in 'forge', 'repo-orchestrator', 'frontend-engineer', 'backend-engineer', 'e2e-engineer', 'security-audit') {
    Invoke-Native "install $plugin" { claude plugin install "$plugin@$Marketplace" }
    Invoke-Native "update $plugin" { claude plugin update "$plugin@$Marketplace" }
  }
}

function Install-Agents {
  # Only ponytail goes to other agents. It is plain instructions. repo-orchestrator needs the
  # Claude Code Agent tool and subagents, so it stays Claude-only.
  New-Item -ItemType Directory -Force -Path $AgentsDir | Out-Null
  $target = Join-Path $AgentsDir 'ponytail'
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Copy-Item -Recurse -Path (Join-Path $Src 'forge\ponytail') -Destination $target
  Write-Note "Other agents: ponytail -> $target"
}

$Src = $null
if ($PSCommandPath) {
  $here = Split-Path -Parent $PSCommandPath
  if (Test-Path (Join-Path $here '.claude-plugin\marketplace.json')) { $Src = $here }
}
if (-not $Src) {
  Fetch-Repo
  $Src = $Dest
}
if (-not (Test-Path (Join-Path $Src '.claude-plugin\marketplace.json'))) {
  throw "$Src is not the CJ Creator skills repository"
}
$Src = (Resolve-Path $Src).Path

if (-not $SkipClaude) { Install-Claude }
if (-not $SkipAgents) { Install-Agents }

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
  Write-Warning "'python' not found. Forge runs its hooks and commands with 'python' (Python 3.8+), so install it or alias it."
}

Write-Note ''
Write-Note "Done. Source: $Src"
Write-Note 'Claude Code: start a new session (or run /reload-plugins). In a project, run /forge-init once, then /forge <request>.'
Write-Note "Other agents: skills are in $AgentsDir."
