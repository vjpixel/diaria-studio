<#
.SYNOPSIS
    Registra a task "Diaria-Resume-Social-260827" no Windows Task Scheduler
    — disparo ÚNICO amanhã 06:10 BRT (09:10 UTC), pra retomar o dispatch
    social da edição 260827 assim que o Kit tiver enviado de verdade.

.DESCRIPTION
    Mesmo padrão de scripts/overnight/setup-edicao-schedule.ps1, mas
    -Once em vez de -Weekly, e task específica desta edição (não genérica).

    *** O Claude Code NÃO consegue rodar este script sozinho *** —
    Register-ScheduledTask dá "Acesso negado" (HRESULT 0x80070005) no
    token do processo do Claude, mesmo sem sandbox. Rode este script você
    mesmo, num terminal normal.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass `
        -File .\scripts\overnight\setup-resume-social-260827.ps1

    # Remover depois de confirmar que rodou (opcional, task 1x já se
    # autodesabilita após o disparo):
    powershell -NoProfile -ExecutionPolicy Bypass `
        -File .\scripts\overnight\setup-resume-social-260827.ps1 -Unregister
#>
param(
    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = (Resolve-Path (Join-Path $ScriptDir "../..")).Path
$RunnerPath = Join-Path $ScriptDir "run-resume-social-260827.ps1"

$TaskName = "Diaria-Resume-Social-260827"
$TaskDesc = "diar.ia.br: retoma dispatch social da edicao 260827 apos envio real do Kit (#6323). Disparo unico 2026-08-27 06:10 BRT."

if (-not (Test-Path $RunnerPath)) {
    Write-Error "Runner não encontrado: $RunnerPath"
    exit 1
}

if ($Unregister) {
    $Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($Existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "Task '$TaskName' removida."
    } else {
        Write-Output "Task '$TaskName' não encontrada (já removida ou nunca registrada)."
    }
    exit 0
}

$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$RunnerPath`"" `
    -WorkingDirectory $RepoRoot

# Disparo único: 2026-08-27 06:10 BRT (fuso local da máquina).
$Trigger = New-ScheduledTaskTrigger -Once -At "2026-08-27T06:10:00"

$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

# #3775/#3780: Register-ScheduledTask -Force substitui a task INTEIRA (ao
# contrário de Set-ScheduledTask, que só atualiza os campos passados) —
# qualquer propriedade não especificada nesta chamada volta ao default,
# incluindo Enabled=True. Se o editor tinha desabilitado a task manualmente
# antes de re-rodar este script, restaurar esse estado aqui; senão o -Force
# reativa a task silenciosamente, sem log nem aviso (mesmo padrão de
# setup-edicao-schedule.ps1).
$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

Register-ScheduledTask `
    -TaskName    $TaskName `
    -Action      $Action `
    -Trigger     $Trigger `
    -Settings    $Settings `
    -Description $TaskDesc `
    -RunLevel    Limited `
    -Force | Out-Null

if ($Existing -and $Existing.State -eq "Disabled") {
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
}

Write-Output "Task '$TaskName' registrada — dispara uma vez em 2026-08-27 06:10 (fuso local da máquina)."
Write-Output ""
Write-Output "Configuração:"
Write-Output "  Runner  : $RunnerPath"
Write-Output "  Repo    : $RepoRoot"
Write-Output "  Log     : data\task-scheduler-resume-social-260827.log"
Write-Output ""
Write-Output "Para verificar: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Output "Para remover  : .\scripts\overnight\setup-resume-social-260827.ps1 -Unregister"
