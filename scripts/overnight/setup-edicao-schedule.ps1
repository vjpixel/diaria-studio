<#
.SYNOPSIS
    Compatibility shim (#14121). The task registration script moved to
    scripts/edicao-agendada/setup-edicao-schedule.ps1. This file forwards
    -Unregister and calls the new script, which registers the task with
    the NEW runner path (derived from its own directory).
    Guard: test/edicao-agendada-shims-14121.test.ts.
#>
param(
    [switch]$Unregister
)
$ErrorActionPreference = "Stop"
$Target = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..\edicao-agendada\setup-edicao-schedule.ps1"
$global:LASTEXITCODE = 0
& $Target -Unregister:$Unregister
exit $LASTEXITCODE
