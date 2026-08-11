<#
.SYNOPSIS
    Registra (ou atualiza/remove) a task "Diaria-Edicao-Diaria" no Task Scheduler.

    *** STATUS (260811, #4998): REATIVADA a pedido do editor, com dois
    ajustes em relação ao original: horário 16:00 (era 14:00) e um guard de
    idempotência no runner — se a edição do dia já foi iniciada (manualmente
    ou por uma run anterior), o runner pula sem invocar `claude` (ver
    run-scheduled-edicao.ps1). Histórico: a task tinha sido desregistrada em
    260711 (#3259, decisão do editor); ver docs/scheduled-edicao-setup.md
    para o histórico completo.

.DESCRIPTION
    Cria uma tarefa agendada que roda run-scheduled-edicao.ps1 de domingo a
    quinta-feira às 16:00 (horário local da máquina = BRT).

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
$TaskDesc   = "diar.ia.br: roda /diaria-edicao D+1 de dom-qui 16:00 BRT (Stages 0-3 + pre-render), pula se a edicao ja foi iniciada."

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

# Trigger: semanal, dias dom (0), seg (1), ter (2), qua (3), qui (4), 16:00
# DaysOfWeek bitmask: Sunday=1, Monday=2, Tuesday=4, Wednesday=8, Thursday=16
$Trigger = New-ScheduledTaskTrigger `
    -Weekly `
    -DaysOfWeek Sunday,Monday,Tuesday,Wednesday,Thursday `
    -At "16:00"

# Settings
$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 3) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

# Registrar (idempotente). Register-ScheduledTask -Force cria OU sobrescreve e
# aceita -Description. NÃO usar Set-ScheduledTask no branch de update: ele não
# tem parâmetro -Description (falhava com "NamedParameterNotFound" ao re-rodar
# sobre uma task existente — #3757/#3764).
$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName    $TaskName `
    -Action      $Action `
    -Trigger     $Trigger `
    -Settings    $Settings `
    -Description $TaskDesc `
    -RunLevel    Limited `
    -Force | Out-Null

# #3775: Register-ScheduledTask -Force substitui a task INTEIRA (ao contrário de
# Set-ScheduledTask, que só atualiza os campos passados) — qualquer propriedade
# não especificada nesta chamada volta ao default, incluindo Enabled=True. Se o
# editor tinha desabilitado a task manualmente, restaurar esse estado aqui;
# senão o -Force reativa a task silenciosamente, sem log nem aviso.
if ($Existing -and $Existing.State -eq "Disabled") {
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
}

if ($Existing) {
    Write-Output "Task '$TaskName' atualizada."
} else {
    Write-Output "Task '$TaskName' registrada."
}

Write-Output ""
Write-Output "Configuração:"
Write-Output "  Runner  : $RunnerPath"
Write-Output "  Repo    : $RepoRoot"
Write-Output "  Horário : dom-qui 16:00 (fuso local da máquina; ajustar se não for BRT)"
Write-Output "  Guard   : pula sem rodar se data/editions/{AAMMDD}/ já existir (edição já iniciada)"
Write-Output "  Duração : máx 3 h por execução"
Write-Output ""
Write-Output "Para verificar: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Output "Para remover  : .\scripts\overnight\setup-edicao-schedule.ps1 -Unregister"
