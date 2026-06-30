<#
.SYNOPSIS
    Registra (ou atualiza/remove) a task "Diaria-Overnight-Watchdog" no Task Scheduler.

.DESCRIPTION
    Cria uma tarefa agendada que roda o watchdog de stall overnight a cada 10 min
    (entre 18:00 e 09:00 do dia seguinte — fora desse janela o overnight não está ativo).

    O watchdog detecta se há uma rodada overnight parada silenciosamente há mais de
    60 min (o coordenador é event-driven e não cobre silêncio total — #2688) e
    emite halt banner + evento no run-log + alerta Telegram opcional.

    Idempotente: re-executar substitui a task existente.
    Use -Unregister para remover a task.

    *** NÃO EXECUTAR durante setup de worktrees temporários ***
    O path do runner é derivado do diretório deste script. Em worktrees
    temporários o path muda; registrar agora criaria a task apontando para
    um diretório que será deletado. Execute APENAS no clone permanente do repo,
    após o merge do PR.

.PARAMETER Unregister
    Remove a task "Diaria-Overnight-Watchdog" do Task Scheduler.

.EXAMPLE
    # Registrar (ou atualizar) a task:
    powershell -NoProfile -ExecutionPolicy Bypass `
        -File .\scripts\overnight\setup-watchdog-schedule.ps1

    # Remover a task:
    powershell -NoProfile -ExecutionPolicy Bypass `
        -File .\scripts\overnight\setup-watchdog-schedule.ps1 -Unregister

.NOTES
    Issue: #2688
    Documentação: docs/overnight-watchdog-setup.md
    Requer: Windows com Task Scheduler. Sem Admin: task roda no contexto do usuário.
#>
param(
    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Paths (sem hardcode de usuário/máquina)
# ---------------------------------------------------------------------------
$ScriptDir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot     = (Resolve-Path (Join-Path $ScriptDir "../..")).Path
$WatchdogTs   = Join-Path $RepoRoot "scripts\overnight-watchdog.ts"

$TaskName     = "Diaria-Overnight-Watchdog"
$TaskDesc     = "Diar.ia: watchdog de stall overnight (#2688) — roda a cada 10 min entre 18:00-09:00."

# ---------------------------------------------------------------------------
# Guard: garantir que o watchdog existe no path derivado
# ---------------------------------------------------------------------------
if (-not (Test-Path $WatchdogTs)) {
    Write-Error "Watchdog não encontrado: $WatchdogTs"
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
#
# Roda `npx tsx scripts\overnight-watchdog.ts` no repo root.
# npx é um wrapper — o path completo garante que o PATH do Task Scheduler
# encontre o Node/npm. Se necessário, substituir por path absoluto:
#   (Get-Command npx).Source
# ---------------------------------------------------------------------------
$Action = New-ScheduledTaskAction `
    -Execute  "npx" `
    -Argument "tsx `"$WatchdogTs`"" `
    -WorkingDirectory $RepoRoot

# Trigger repetitivo: a cada 10 min, das 18:00 às 09:00 do dia seguinte (15 h), todo dia.
# O watchdog é idempotente — quando não há rodada ativa, encerra imediatamente.
# PowerShell gotcha (#2688 self-review): -RepetitionInterval/-RepetitionDuration pertencem
# ao parameter set -Once, NÃO ao -Daily — combiná-los com -Daily lança
# ParameterSetCannotBeResolved no Register/Set. Idioma canônico p/ "diário + repetição":
# criar o trigger -Daily e enxertar a .Repetition de um trigger -Once descartável.
$TriggerStart = (Get-Date -Hour 18 -Minute 0 -Second 0)
$Trigger = New-ScheduledTaskTrigger -Daily -At $TriggerStart
$Trigger.Repetition = (New-ScheduledTaskTrigger -Once -At $TriggerStart `
    -RepetitionInterval (New-TimeSpan -Minutes 10) `
    -RepetitionDuration (New-TimeSpan -Hours 15)).Repetition

# Settings
$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit   (New-TimeSpan -Minutes 5) `
    -MultipleInstances    IgnoreNew `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

# Registrar (idempotente via condicional)
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
Write-Output "Configuração:"
Write-Output "  Watchdog : $WatchdogTs"
Write-Output "  Repo     : $RepoRoot"
Write-Output "  Horário  : 18:00 diário, repetindo a cada 10 min por 15 h (até 09:00)"
Write-Output "  Threshold: 60 min (override: env OVERNIGHT_WATCHDOG_STALL_MIN)"
Write-Output ""
Write-Output "Para verificar: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Output "Para remover  : .\scripts\overnight\setup-watchdog-schedule.ps1 -Unregister"
Write-Output ""
Write-Output "Alerta Telegram (opcional):"
Write-Output "  Setar TELEGRAM_BOT_TOKEN e TELEGRAM_WATCHDOG_CHAT_ID no .env.local"
Write-Output "  O mesmo bot do telegram-setup.md — adicionar TELEGRAM_WATCHDOG_CHAT_ID"
Write-Output "  com o chat_id do seu DM com o bot (via https://api.telegram.org/bot{token}/getUpdates)."
