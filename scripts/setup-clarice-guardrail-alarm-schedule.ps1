<#
.SYNOPSIS
    Registra (ou remove) a task "Diaria-Clarice-Guardrail-Alarm" no Task
    Scheduler -- alarme de guardrail furado do ramp Clarice, a cada 4h.

.DESCRIPTION
    Cria uma tarefa agendada que roda `run-clarice-guardrail-alarm.ps1` (que
    chama `clarice-guardrail-alarm.ts`) a cada 4h. Sem essa task, o alarme do
    #4064 fica implementado e testado mas nunca dispara sozinho (achado
    "finding 1" do self-review do PR #4131).

    Cadencia: a avaliacao roda ~6h apos CADA envio (GUARDRAIL_EVAL_WINDOW_MS
    em scripts/lib/clarice-guardrail-alarm.ts), e os envios saem 06:00 BRT.
    Uma execucao diaria as 12:00 BRT ja cobriria o caso, mas 4 em 4h e mais
    robusto contra maquina desligada/execucao perdida -- a idempotencia
    (data/clarice-guardrail-alarm-state.json, uma campanha nunca e
    reavaliada/realarmada 2x) torna execucoes extras seguras e baratas.

    StartWhenAvailable: se o horario for perdido (maquina desligada), roda
    quando disponivel.

    Idempotente: re-executar substitui a task. Use -Unregister para remover.

    *** Rodar SO no clone permanente do repo (path derivado do diretorio deste
    script). Em worktree temporario o path muda e a task apontaria pra um
    diretorio deletado. ***

.PARAMETER Unregister
    Remove a task "Diaria-Clarice-Guardrail-Alarm".

.EXAMPLE
    # Registrar (ou atualizar):
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-clarice-guardrail-alarm-schedule.ps1

    # Remover:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-clarice-guardrail-alarm-schedule.ps1 -Unregister

.NOTES
    Issue: #4064 (alarme), #4131 finding 1 (agendamento).
    Requer: Windows + Task Scheduler + junction data/ + BREVO_CLARICE_API_KEY +
    data/.credentials.json com scope gmail.send.
    Sem Admin: a task roda no contexto do usuario (RunLevel Limited).
#>
param(
    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$WrapperPs1 = Join-Path $RepoRoot "scripts\run-clarice-guardrail-alarm.ps1"

$TaskName = "Diaria-Clarice-Guardrail-Alarm"
$TaskDesc = "Diar.ia: alarme de guardrail furado do ramp Clarice (#4064) - a cada 4h."

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

# A cada 4h, comecando agora, indefinidamente.
$Trigger = New-ScheduledTaskTrigger -Once (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 4) -RepetitionDuration ([TimeSpan]::MaxValue)

$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit   (New-TimeSpan -Hours 1) `
    -MultipleInstances    IgnoreNew `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

# Register-ScheduledTask -Force cria OU sobrescreve (idempotente) e aceita -Description.
# NAO usar Set-ScheduledTask no branch de update: ele nao tem parametro -Description
# (falha com "NamedParameterNotFound" ao re-rodar sobre uma task existente -- #3757/#3764).
$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName    $TaskName `
    -Action      $Action `
    -Trigger     $Trigger `
    -Settings    $Settings `
    -Description $TaskDesc `
    -RunLevel    Limited `
    -Force | Out-Null

# #3775: Register-ScheduledTask -Force substitui a task INTEIRA (ao contrario de
# Set-ScheduledTask, que so atualiza os campos passados) -- qualquer propriedade
# nao especificada nesta chamada volta ao default, incluindo Enabled=True. Se o
# editor tinha desabilitado a task manualmente, restaura esse estado aqui; senao
# o -Force reativa a task silenciosamente, sem log nem aviso.
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
Write-Output "  Cadencia: a cada 4h (envios saem 06:00 BRT, avaliacao ~6h depois)"
Write-Output "  Log     : data\clarice-subscribers\.guardrail-alarm.log"
Write-Output ""
Write-Output "Verificar: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Output "Remover  : .\scripts\setup-clarice-guardrail-alarm-schedule.ps1 -Unregister"
Write-Output ""
