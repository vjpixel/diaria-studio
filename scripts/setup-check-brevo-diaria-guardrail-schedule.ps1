<#
.SYNOPSIS
    Registra (ou remove) a task "Diaria-Brevo-Diaria-Guardrail" no Task
    Scheduler -- circuit breaker de campanha do canal Brevo Pending (#4476
    item 9), a cada 4h.

.DESCRIPTION
    Cria uma tarefa agendada que roda `run-check-brevo-diaria-guardrail.ps1`
    (que chama `check-brevo-diaria-guardrail.ts`) a cada 4h. Sem essa task, o
    circuit breaker fica implementado e testado mas nunca reavalia sozinho --
    mesma classe de lacuna que motivou #4131 finding 1 pro alarme do ramp
    Clarice.

    Cadencia: a issue #4476 pede "checados TODO DIA -- nao esperam
    maturacao, a Brevo reporta bounce/spam quase em tempo real" (secao
    "Rollout em canario"). 4 em 4h e mais robusto que 1x/dia contra maquina
    desligada/execucao perdida e reage mais rapido a um bounce/spam real
    (nunca pior que o pedido da issue) -- mesmo raciocinio de cadencia do
    alarme do ramp Clarice (setup-clarice-guardrail-alarm-schedule.ps1).

    Uma vez pausado, o latch NAO despausa sozinho em nenhuma execucao
    seguinte (issue: "pausa o rollout ate o editor decidir") -- reexecutar
    esta task com o rollout ja pausado so atualiza `last_checked_at`, nunca
    reverte a pausa. Despausar exige acao explicita do editor:
      npx tsx scripts/check-brevo-diaria-guardrail.ts --unpause

    StartWhenAvailable: se o horario for perdido (maquina desligada), roda
    quando disponivel.

    Idempotente: re-executar substitui a task. Use -Unregister para remover.

    *** Rodar SO no clone permanente do repo (path derivado do diretorio deste
    script). Em worktree temporario o path muda e a task apontaria pra um
    diretorio deletado. ***

.PARAMETER Unregister
    Remove a task "Diaria-Brevo-Diaria-Guardrail".

.EXAMPLE
    # Registrar (ou atualizar):
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-check-brevo-diaria-guardrail-schedule.ps1

    # Remover:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-check-brevo-diaria-guardrail-schedule.ps1 -Unregister

.NOTES
    Issue: #4476 item 9.
    Requer: Windows + Task Scheduler + junction data/ + BREVO_DIARIA_API_KEY.
    Alarme por e-mail (opcional, best-effort) requer data/.credentials.json
    com scope gmail.send -- sem ele, o estado ainda persiste pausado, so o
    e-mail nao sai (ver docstring de check-brevo-diaria-guardrail.ts).
    Sem Admin: a task roda no contexto do usuario (RunLevel Limited).
#>
param(
    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$WrapperPs1 = Join-Path $RepoRoot "scripts\run-check-brevo-diaria-guardrail.ps1"

$TaskName = "Diaria-Brevo-Diaria-Guardrail"
$TaskDesc = "diar.ia.br: circuit breaker de campanha do canal Brevo Pending (#4476 item 9) - a cada 4h."

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

# A cada 4h, comecando agora, indefinidamente. -At explicito (ver
# racional em setup-clarice-guardrail-alarm-schedule.ps1, #4155) e
# -RepetitionDuration OMITIDO de proposito (repeticao indefinida; passar
# [TimeSpan]::MaxValue quebra o registro da task, mesmo achado #4155).
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 4)

$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit   (New-TimeSpan -Hours 1) `
    -MultipleInstances    IgnoreNew `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

# Register-ScheduledTask -Force cria OU sobrescreve (idempotente) e aceita
# -Description. NAO usar Set-ScheduledTask no branch de update (sem
# -Description, falha "NamedParameterNotFound" ao re-rodar -- #3757/#3764).
$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName    $TaskName `
    -Action      $Action `
    -Trigger     $Trigger `
    -Settings    $Settings `
    -Description $TaskDesc `
    -RunLevel    Limited `
    -Force | Out-Null

# #3775: Register-ScheduledTask -Force substitui a task INTEIRA -- qualquer
# propriedade nao especificada volta ao default, incluindo Enabled=True.
# Restaura o estado Disabled se o editor tinha desligado a task manualmente.
if ($Existing -and $Existing.State -eq "Disabled") {
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
}

if ($Existing) {
    Write-Output "Task '$TaskName' atualizada."
} else {
    Write-Output "Task '$TaskName' registrada."
}

Write-Output ""
Write-Output "Configuracao:"
Write-Output "  Wrapper : $WrapperPs1"
Write-Output "  Repo    : $RepoRoot"
Write-Output "  Cadencia: a cada 4h"
Write-Output "  Log     : data\brevo-diaria\.guardrail-check.log"
Write-Output "  Estado  : data\brevo-diaria\guardrail-state.json (latch -- so despausa via --unpause explicito)"
Write-Output ""
Write-Output "Verificar: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Output "Remover  : .\scripts\setup-check-brevo-diaria-guardrail-schedule.ps1 -Unregister"
Write-Output ""
