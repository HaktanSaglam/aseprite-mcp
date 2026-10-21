#Requires -Version 5.1
<#
.SYNOPSIS
  One-command setup for Windows (macOS/Linux: scripts/install.sh).

.DESCRIPTION
  1. checks Node.js 20+, installs and builds the bridge
  2. packages the Aseprite extension and hands it to Aseprite to install
  3. optionally starts the bridge in the background at every login (-Service)
  4. optionally registers the MCP server with Claude Code (-Claude)
  Safe to re-run after `git pull`: every step updates what is already there.
  Without switches it asks before each optional step.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Service -Claude
#>
[CmdletBinding()]
param(
  # Start the bridge in the background at every login.
  [switch]$Service,
  # Don't install the background bridge and don't ask.
  [switch]$NoService,
  # Register the MCP server with Claude Code (claude mcp add ...).
  [switch]$Claude,
  # Don't register with Claude Code and don't ask.
  [switch]$NoClaude,
  # Only package the extension; don't hand it to Aseprite.
  [switch]$NoOpen,
  # Answer yes to every question.
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$bridge = Join-Path $root 'bridge'
$extFile = Join-Path $root 'dist\aseprite-mcp.aseprite-extension'
$cli = Join-Path $bridge 'bin\aseprite-mcp.js'
$mcpPort = if ($env:ASEPRITE_MCP_PORT) { $env:ASEPRITE_MCP_PORT } else { '7800' }
$wsPort = if ($env:ASEPRITE_WS_PORT) { $env:ASEPRITE_WS_PORT } else { '7801' }
$mcpUrl = "http://127.0.0.1:$mcpPort/mcp"

function Write-Step([string]$text) {
  Write-Host ''
  Write-Host "==> $text" -ForegroundColor Cyan
}

# Native programs report failure through $LASTEXITCODE, which $ErrorActionPreference ignores.
function Invoke-Native([string]$file, [string[]]$arguments) {
  & $file @arguments
  if ($LASTEXITCODE -ne 0) { throw "'$file $($arguments -join ' ')' failed with exit code $LASTEXITCODE" }
}

# Yes/no question; defaults to yes when someone can answer and to no otherwise (CI, pipes).
function Confirm-Step([string]$question) {
  if ($Yes) { return $true }
  if ([Console]::IsInputRedirected -or -not [Environment]::UserInteractive) { return $false }
  $reply = Read-Host "$question [Y/n]"
  return ($reply -eq '' -or $reply -match '^[Yy]')
}

function Resolve-Choice([bool]$on, [bool]$off, [string]$question) {
  if ($on) { return $true }
  if ($off) { return $false }
  return (Confirm-Step $question)
}

function Get-ExtensionsDir {
  # ASEPRITE_USER_FOLDER is Aseprite's own override for its settings folder.
  if ($env:ASEPRITE_USER_FOLDER) { return (Join-Path $env:ASEPRITE_USER_FOLDER 'extensions') }
  return (Join-Path $env:APPDATA 'Aseprite\extensions')
}

# ---------------------------------------------------------------- 1. Node.js + bridge

Write-Step 'Checking Node.js'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js is not installed. Install Node.js 20 or newer from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS), open a new terminal and run this script again.'
}
$nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) { throw "Node.js $(& node -v) is too old; version 20 or newer is required." }
Write-Host "Node.js $(& node -v), npm $(& npm.cmd -v)"

Write-Step 'Installing and building the bridge'
Push-Location $bridge
try {
  Invoke-Native 'npm.cmd' @('ci', '--no-audit', '--no-fund', '--loglevel=error')
  Invoke-Native 'npm.cmd' @('run', 'build', '--silent')
} finally {
  Pop-Location
}
Write-Host "Built $bridge\dist"

# ---------------------------------------------------------------- 2. Aseprite extension

Write-Step 'Packaging the Aseprite extension'
& (Join-Path $PSScriptRoot 'package-extension.ps1') -OutFile $extFile

# The extension was called "claude-pixel-bridge" before 1.0. Both copies would connect
# to the bridge and keep replacing each other's connection.
$legacyDir = Join-Path (Get-ExtensionsDir) 'claude-pixel-bridge'
if (Test-Path $legacyDir) {
  Write-Host "Found the old 'Claude Pixel Bridge' extension (renamed to Aseprite MCP in 1.0): $legacyDir"
  if (Confirm-Step 'Remove the old extension? (recommended)') {
    Remove-Item -Recurse -Force $legacyDir
    Write-Host 'Removed. Restart Aseprite if it is open.'
  } else {
    Write-Host 'Kept. Uninstall it in Aseprite: Edit > Preferences > Extensions > Claude Pixel Bridge > Uninstall.'
  }
}

$handedOver = $false
if (-not $NoOpen) {
  Write-Step 'Installing the extension in Aseprite'
  try {
    # Works when Aseprite is associated with .aseprite-extension files (the regular installer does that).
    Start-Process -FilePath $extFile
    $handedOver = $true
    Write-Host "Aseprite is opening the extension. In Aseprite click 'Install'"
    Write-Host "(or 'Yes' when it offers to upgrade an existing Aseprite MCP extension)."
  } catch {
    Write-Host 'No program is associated with .aseprite-extension files; showing the file in Explorer instead.'
    Start-Process -FilePath 'explorer.exe' -ArgumentList "/select,`"$extFile`""
  }
}
if (-not $handedOver) {
  Write-Host 'Install the extension once in Aseprite: Edit > Preferences > Extensions > Add Extension'
  Write-Host "and choose $extFile"
  Write-Host '(dragging the file onto the Aseprite window works too).'
}

# ---------------------------------------------------------------- 3. Background bridge

$serviceRunning = $false
$startupShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Aseprite MCP bridge.lnk'
# An existing background bridge keeps running the old build until it is reinstalled.
if (-not $Service -and -not $NoService -and (Test-Path $startupShortcut)) {
  $serviceWanted = $true
} else {
  $serviceWanted = Resolve-Choice $Service.IsPresent $NoService.IsPresent 'Start the bridge automatically in the background at login?'
}
if ($serviceWanted) {
  Write-Step 'Installing the background bridge'
  $env:ASEPRITE_MCP_SKIP_BUILD = '1'
  try {
    & (Join-Path $PSScriptRoot 'install-service.ps1')
    $serviceRunning = $true
  } catch {
    Write-Warning "The background bridge could not be installed: $_"
  } finally {
    Remove-Item Env:ASEPRITE_MCP_SKIP_BUILD -ErrorAction SilentlyContinue
  }
}

# ---------------------------------------------------------------- 4. Claude Code

Write-Step 'Claude Code'
if (Get-Command claude -ErrorAction SilentlyContinue) {
  # Windows PowerShell turns redirected stderr lines into errors, which 'Stop' would make fatal.
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $existing = @(& claude mcp get aseprite 2>$null)
    $alreadyRegistered = ($LASTEXITCODE -eq 0)
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($alreadyRegistered) {
    if (($existing -join "`n").Contains($mcpUrl)) {
      Write-Host "Claude Code already knows the 'aseprite' MCP server ($mcpUrl)."
    } else {
      Write-Host "Claude Code already has an MCP server called 'aseprite' with another URL:"
      $existing | ForEach-Object { Write-Host "    $_" }
      Write-Host 'To point it at this bridge:'
      Write-Host '    claude mcp remove aseprite -s user'
      Write-Host "    claude mcp add --transport http --scope user aseprite $mcpUrl"
    }
  } elseif (Resolve-Choice $Claude.IsPresent $NoClaude.IsPresent 'Register the bridge with Claude Code (claude mcp add, user scope)?') {
    Invoke-Native 'claude' @('mcp', 'add', '--transport', 'http', '--scope', 'user', 'aseprite', $mcpUrl)
    Write-Host "Registered 'aseprite' ($mcpUrl) for all your Claude Code projects."
  } else {
    Write-Host "Skipped. Register later with: claude mcp add --transport http --scope user aseprite $mcpUrl"
  }
} else {
  Write-Host "The 'claude' CLI was not found. The in-Aseprite chat uses Claude Code by default:"
  Write-Host "install it from https://claude.com/claude-code and run 'claude auth login'."
  Write-Host 'Other MCP clients (Cursor, VS Code, Codex, ...): see docs\CLIENTS.md'
}

# ---------------------------------------------------------------- Summary

Write-Step 'Done. Next steps'
$n = 1
if (-not $serviceRunning) {
  Write-Host "  $n. Start the bridge and keep the window open:"
  Write-Host "       node `"$cli`""
  $n++
}
Write-Host "  $n. In Aseprite, when the Security dialog says the script wants to open a WebSocket"
Write-Host "     connection to ws://127.0.0.1:$wsPort : tick 'Don't show this specific alert again for"
Write-Host "     this script', then click 'Allow to Open Connections'."
$n++
Write-Host "  $n. Open the assistant: Edit > FX > Aseprite MCP > AI Assistant..."
$n++
Write-Host "  $n. Something not working? Run: node `"$cli`" doctor"
Write-Host ''
Write-Host "MCP endpoint for other clients: $mcpUrl  (configs: node `"$cli`" print-config)"
