#Requires -Version 5.1
<#
.SYNOPSIS
  Packages aseprite-extension\ as dist\aseprite-mcp.aseprite-extension.

.DESCRIPTION
  The result is a plain zip that Aseprite installs on double-click or via
  Edit > Preferences > Extensions > Add Extension. Windows counterpart of
  scripts/package-extension.sh.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\package-extension.ps1
#>
param(
  [string]$OutFile
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$src = (Resolve-Path (Join-Path $root 'aseprite-extension')).Path.TrimEnd('\', '/')
if (-not $OutFile) { $OutFile = Join-Path $root 'dist/aseprite-mcp.aseprite-extension' }
# Resolve against the PowerShell location, not the process working directory.
$OutFile = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutFile)

foreach ($required in 'package.json', 'main.lua') {
  if (-not (Test-Path (Join-Path $src $required))) {
    throw "$src\$required is missing; is this a complete checkout?"
  }
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutFile) | Out-Null
if (Test-Path $OutFile) { Remove-Item -Force $OutFile }

# Not Compress-Archive: Windows PowerShell 5.1 stores entry names with backslashes (other
# zip readers then see "rpc\init.lua" as one file name) and it only writes *.zip files.
function Test-Shipped([string]$relative) {
  # Tests and dotfiles (.DS_Store, editor swap files) are not part of the extension.
  return -not ($relative -eq 'tests' -or $relative.StartsWith('tests/') -or $relative -match '(^|/)\.')
}

$zip = [System.IO.Compression.ZipFile]::Open($OutFile, [System.IO.Compression.ZipArchiveMode]::Create)
$count = 0
try {
  foreach ($item in Get-ChildItem -LiteralPath $src -Recurse -Force | Sort-Object FullName) {
    $relative = $item.FullName.Substring($src.Length + 1).Replace('\', '/')
    if (-not (Test-Shipped $relative)) { continue }
    if ($item.PSIsContainer) {
      # Aseprite only removes directories listed in the zip when it uninstalls or
      # updates the extension, so directory entries are written explicitly.
      [void]$zip.CreateEntry("$relative/")
    } else {
      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $zip, $item.FullName, $relative, [System.IO.Compression.CompressionLevel]::Optimal)
      $count++
    }
  }
} finally {
  $zip.Dispose()
}

Write-Host "Created $OutFile ($count files)"
