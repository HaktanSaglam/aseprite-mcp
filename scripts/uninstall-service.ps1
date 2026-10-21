#Requires -Version 5.1
<#
.SYNOPSIS
  Stops the background bridge started by install-service.ps1 and removes it from login.
  Safe to run when nothing is installed. The log in %LOCALAPPDATA%\aseprite-mcp is kept.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\uninstall-service.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $root 'bridge\dist\index.js'
$launcher = Join-Path $env:LOCALAPPDATA 'aseprite-mcp\start-bridge.ps1'
$shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Aseprite MCP bridge.lnk'

$removed = $false
foreach ($file in $shortcut, $launcher) {
  if (Test-Path $file) {
    Remove-Item -Force $file
    $removed = $true
  }
}

$processes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entry) })
foreach ($proc in $processes) {
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  $removed = $true
}

if ($removed) {
  Write-Host 'Removed the Aseprite MCP bridge from login and stopped it.'
} else {
  Write-Host 'Nothing to remove: the background bridge is not installed.'
}
