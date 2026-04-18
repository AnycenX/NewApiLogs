<#
.SYNOPSIS
Build helper for WebApiLogs.

.DESCRIPTION
Supports frontend build, cargo check, debug package build, and release package build.
The script switches to the project directory automatically and tries to add cargo to PATH.

.PARAMETER Mode
Available values:
- release : build release app and installers
- debug   : build debug app and installers
- frontend: build frontend assets only
- check   : run cargo check only

.PARAMETER Install
Run npm install before building.

.EXAMPLE
.\build.ps1

.EXAMPLE
.\build.ps1 -Mode release

.EXAMPLE
.\build.ps1 -Mode debug

.EXAMPLE
.\build.ps1 -Mode frontend

.EXAMPLE
.\build.ps1 -Mode check
#>

[CmdletBinding()]
param(
  [ValidateSet("release", "debug", "frontend", "check")]
  [string]$Mode = "release",
  [switch]$Install
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$CargoBin = Join-Path $env:USERPROFILE ".cargo\bin"

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Run-Command {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [string]$WorkingDirectory = $ProjectRoot
  )

  Write-Host "> $FilePath $($Arguments -join ' ')" -ForegroundColor DarkGray

  Push-Location $WorkingDirectory
  try {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "Command failed: $FilePath $($Arguments -join ' ')"
    }
  }
  finally {
    Pop-Location
  }
}

function Ensure-Command([string]$CommandName, [string]$Hint) {
  if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
    throw "Command not found: $CommandName. $Hint"
  }
}

function Get-AppVersion {
  $TauriConfigPath = Join-Path $ProjectRoot "src-tauri\tauri.conf.json"
  $TauriConfig = Get-Content $TauriConfigPath -Raw | ConvertFrom-Json
  return $TauriConfig.version
}

function Show-Outputs([string]$BuildMode) {
  $TargetDir = Join-Path $ProjectRoot "src-tauri\target\$BuildMode"
  $AppVersion = Get-AppVersion
  $AppExe = Join-Path $TargetDir "app.exe"
  $NsisExe = Join-Path $TargetDir "bundle\nsis\WebApiLogs_${AppVersion}_x64-setup.exe"
  $Msi = Join-Path $TargetDir "bundle\msi\WebApiLogs_${AppVersion}_x64_en-US.msi"

  Write-Step "Build outputs"
  if (Test-Path $AppExe) {
    Write-Host "app.exe: $AppExe" -ForegroundColor Green
  }
  if (Test-Path $NsisExe) {
    Write-Host "setup.exe: $NsisExe" -ForegroundColor Green
  }
  if (Test-Path $Msi) {
    Write-Host "msi: $Msi" -ForegroundColor Green
  }
}

Set-Location $ProjectRoot

if ((Test-Path $CargoBin) -and (-not (($env:PATH -split ";") -contains $CargoBin))) {
  $env:PATH = "$CargoBin;$env:PATH"
}

Ensure-Command -CommandName "npm" -Hint "Install Node.js first and make sure npm is available."

if ($Install -or -not (Test-Path (Join-Path $ProjectRoot "node_modules"))) {
  Write-Step "Installing frontend dependencies"
  Run-Command -FilePath "npm" -Arguments @("install")
}

switch ($Mode) {
  "frontend" {
    Write-Step "Running frontend build"
    Run-Command -FilePath "npm" -Arguments @("run", "build")
    Write-Step "Done"
    Write-Host "dist: $(Join-Path $ProjectRoot 'dist')" -ForegroundColor Green
  }

  "check" {
    Ensure-Command -CommandName "cargo" -Hint "Install Rust first or check C:\Users\AnycenX\.cargo\bin."
    Write-Step "Running cargo check"
    Run-Command -FilePath "cargo" -Arguments @("check") -WorkingDirectory (Join-Path $ProjectRoot "src-tauri")
    Write-Step "Done"
  }

  "debug" {
    Ensure-Command -CommandName "cargo" -Hint "Install Rust first or check C:\Users\AnycenX\.cargo\bin."
    Write-Step "Running debug package build"
    Run-Command -FilePath "npm" -Arguments @("run", "tauri", "build", "--", "--debug")
    Show-Outputs -BuildMode "debug"
  }

  "release" {
    Ensure-Command -CommandName "cargo" -Hint "Install Rust first or check C:\Users\AnycenX\.cargo\bin."
    Write-Step "Running release package build"
    Run-Command -FilePath "npm" -Arguments @("run", "tauri", "build")
    Show-Outputs -BuildMode "release"
  }
}

Write-Step "All done"
