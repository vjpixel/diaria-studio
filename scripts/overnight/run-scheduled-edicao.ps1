<#
.SYNOPSIS
    Compatibility shim (#14121). The scheduled edition runner moved to
    scripts/edicao-agendada/run-scheduled-edicao.ps1. A Windows task that
    was registered with this old path keeps working: this file only calls
    the new script and returns its exit code. Re-register the task with
    scripts/edicao-agendada/setup-edicao-schedule.ps1 to point it at the
    new path. Guard: test/edicao-agendada-shims-14121.test.ts.
#>
$ErrorActionPreference = "Stop"
$Target = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..\edicao-agendada\run-scheduled-edicao.ps1"
$global:LASTEXITCODE = 0
& $Target @args
exit $LASTEXITCODE
