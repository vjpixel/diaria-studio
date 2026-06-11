<#
.SYNOPSIS
    Registra (ou atualiza/remove) a task "Diaria-Edicao-Diaria" no Task Scheduler.

.DESCRIPTION
    Cria uma tarefa agendada que roda run-scheduled-edicao.ps1 de domingo a
    quinta-feira às 14:00 (horário local da máquina = BRT).

    Idempotente: re-executar substitui a task existente. Use -Unregister para
    remover a task.

    *** NÃO EXECUTAR durante setup de worktrees temporários ***
    O path do runner é derivado do diretório deste script. Em worktrees
    temporários o path muda; registrar agora criaria a task apontando para
    um diretório que será deletado. Execute este script APENAS no clone
    permanente do repo, após o merge do PR. (Ver docs/scheduled-edicao-setup.md)

.PARAMETER Unregister
    Remove a task "Diaria-Edicao-Diaria" do Task Scheduler.

.EXAMPLE
    # Registrar (ou atualizar) a task:
    powershell -NoProfile -ExecutionPolicy Bypass `
        -File .\scripts\overnight\setup-edicao-schedule.ps1

    # Remover a task:
    powershell -NoProfile -ExecutionPolicy Bypass `
        -File .\scripts\overnight\setup-edicao-schedule.ps1 -Unregister

.NOTES
    Issue: #2068
    Requer: Windows com Task Scheduler (schtasks.exe ou New-ScheduledTask).
    Sem privilégios de Admin, a task é registrada para o usuário atual
    (sem "Run as SYSTEM"). Isso é suficiente — a task roda no contexto do
    usuário que tem Claude Code autenticado.
#>
param(
    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Paths (derivados do script — sem hardcode de usuário/máquina)
# ---------------------------------------------------------------------------
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = (Resolve-Path (Join-Path $ScriptDir "../..")).Path
$RunnerPath = Join-Path $ScriptDir "run-scheduled-edicao.ps1"

$TaskName   = "Diaria-Edicao-Diaria"
$TaskDesc   = "Diar.ia: roda /diaria-edicao D+1 de dom-qui 14:00 BRT (Stages 0-3 + pre-render)."

# ---------------------------------------------------------------------------
# Guard: garantir que o runner existe no path derivado
# ---------------------------------------------------------------------------
if (-not (Test-Path $RunnerPath)) {
    Write-Error "Runner não encontrado: $RunnerPath"
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
        Write-Output "Task '$TaskName' não encontrada (já removida ou nunca registrada)."
    }
    exit 0
}

# ---------------------------------------------------------------------------
# Registrar / atualizar
# ---------------------------------------------------------------------------

# Action: powershell.exe -NoProfile -ExecutionPolicy Bypass -File <runner>
$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$RunnerPath`"" `
    -WorkingDirectory $RepoRoot

# Trigger: semanal, dias dom (0), seg (1), ter (2), qua (3), qui (4), 14:00
# DaysOfWeek bitmask: Sunday=1, Monday=2, Tuesday=4, Wednesday=8, Thursday=16
$Trigger = New-ScheduledTaskTrigger `
    -Weekly `
    -DaysOfWeek Sunday,Monday,Tuesday,Wednesday,Thursday `
    -At "14:00"

# Settings
$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 3) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

# Registrar (idempotente via -Force)
$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Existing) {
    Set-ScheduledTask `
        -TaskName $TaskName `
        -Action $Action `
        -Trigger $Trigger `
        -Settings $Settings `
        -Description $TaskDesc
    Write-Output "Task '$TaskName' atualizada."
} else {
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $Action `
        -Trigger $Trigger `
        -Settings $Settings `
        -Description $TaskDesc `
        -RunLevel Limited
    Write-Output "Task '$TaskName' registrada."
}

Write-Output ""
Write-Output "Configuração:"
Write-Output "  Runner  : $RunnerPath"
Write-Output "  Repo    : $RepoRoot"
Write-Output "  Horário : dom-qui 14:00 (fuso local da máquina; ajustar se não for BRT)"
Write-Output "  Duração : máx 3 h por execução"
Write-Output ""
Write-Output "Para verificar: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Output "Para remover  : .\scripts\overnight\setup-edicao-schedule.ps1 -Unregister"
