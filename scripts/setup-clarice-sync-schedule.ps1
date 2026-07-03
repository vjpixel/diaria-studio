<#
.SYNOPSIS
    Registra (ou remove) a task "Diaria-Clarice-Sync" no Task Scheduler — sync
    incremental diário do store Clarice às 03:40.

.DESCRIPTION
    Cria uma tarefa agendada que roda `run-clarice-sync-daily.ps1` (que chama
    `clarice-sync-brevo.ts --incremental`) todo dia às 03:40 — off-peak, captura o
    dia inteiro de engajamento maduro, sem disputar o teto horário do Brevo.

    StartWhenAvailable: se o horário for perdido (máquina desligada), roda quando
    disponível — e o incremental deriva de MAX(brevo_modified_at), cobrindo o gap
    do dia perdido sozinho (auto-cura).

    Idempotente: re-executar substitui a task. Use -Unregister para remover.

    *** Rodar SÓ no clone permanente do repo (path derivado do diretório deste
    script). Em worktree temporário o path muda e a task apontaria pra um diretório
    deletado. ***

.PARAMETER Unregister
    Remove a task "Diaria-Clarice-Sync".

.EXAMPLE
    # Registrar (ou atualizar):
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-clarice-sync-schedule.ps1

    # Remover:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-clarice-sync-schedule.ps1 -Unregister

.NOTES
    Issue: #2932 (sync incremental: #2928).
    Requer: Windows + Task Scheduler + junction data/ + BREVO_CLARICE_API_KEY no .env.
    Sem Admin: a task roda no contexto do usuário (RunLevel Limited).
#>
param(
    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$WrapperPs1 = Join-Path $RepoRoot "scripts\run-clarice-sync-daily.ps1"

$TaskName = "Diaria-Clarice-Sync"
$TaskDesc = "Diar.ia: sync incremental diario do store Clarice (#2932) - 03:40, --incremental."

if (-not (Test-Path $WrapperPs1)) {
    Write-Error "Wrapper nao encontrado: $WrapperPs1"
    exit 1
}

# ---------------------------------------------------------------------------
# Remover
# ---------------------------------------------------------------------------
if ($Unregister) {
    $Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($Existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "Task '$TaskName' removida."
    } else {
        Write-Output "Task '$TaskName' nao encontrada (ja removida ou nunca registrada)."
    }
    exit 0
}

# ---------------------------------------------------------------------------
# Registrar / atualizar
# ---------------------------------------------------------------------------
$Action = New-ScheduledTaskAction `
    -Execute  "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$WrapperPs1`"" `
    -WorkingDirectory $RepoRoot

# Diário às 03:40 (once/dia; o sync é idempotente + resumível).
$Trigger = New-ScheduledTaskTrigger -Daily -At (Get-Date -Hour 3 -Minute 40 -Second 0)

$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit   (New-TimeSpan -Hours 3) `
    -MultipleInstances    IgnoreNew `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Existing) {
    Set-ScheduledTask `
        -TaskName    $TaskName `
        -Action      $Action `
        -Trigger     $Trigger `
        -Settings    $Settings `
        -Description $TaskDesc
    Write-Output "Task '$TaskName' atualizada."
} else {
    Register-ScheduledTask `
        -TaskName    $TaskName `
        -Action      $Action `
        -Trigger     $Trigger `
        -Settings    $Settings `
        -Description $TaskDesc `
        -RunLevel    Limited
    Write-Output "Task '$TaskName' registrada."
}

Write-Output ""
Write-Output "Configuracao:"
Write-Output "  Wrapper : $WrapperPs1"
Write-Output "  Repo    : $RepoRoot"
Write-Output "  Horario : 03:40 diario (--incremental)"
Write-Output "  Log     : data\clarice-subscribers\.brevo-sync-daily.log"
Write-Output ""
Write-Output "Verificar: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Output "Remover  : .\scripts\setup-clarice-sync-schedule.ps1 -Unregister"
Write-Output ""
