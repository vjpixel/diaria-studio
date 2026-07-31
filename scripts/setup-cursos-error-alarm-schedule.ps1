<#
.SYNOPSIS
    Registra (ou remove) a task "Diaria-Cursos-Error-Alarm" no Task
    Scheduler -- alarme de erro do worker cursos (#4320), a cada 2h.

.DESCRIPTION
    Cria uma tarefa agendada que roda `run-cursos-error-alarm.ps1` (que
    chama `cursos-error-alarm.ts`) a cada 2h. Sem essa task, o alarme fica
    implementado e testado mas nunca dispara sozinho -- mesmo padrao do
    "finding 1" do #4131 (guardrail Clarice), evitado aqui de proposito.

    Cadencia: worker de baixo trafego, sem janela de avaliacao pos-envio
    (diferente do guardrail Clarice) -- 2h e um meio-termo entre "descobrir
    rapido" e nao gastar leituras de KV a toa. A idempotencia (snapshot de
    contadores em data/cursos-error-alarm-state.json -- #4382, era cursor de
    tempo antes; ver scripts/lib/cursos-error-alarm.ts) torna execucoes
    extras seguras e baratas.

    StartWhenAvailable: se o horario for perdido (maquina desligada), roda
    quando disponivel -- o cursor de tempo cobre o gap sozinho (auto-cura,
    mesmo raciocinio do #2932 pro sync Clarice).

    Idempotente: re-executar substitui a task. Use -Unregister para remover.

    *** Rodar SO no clone permanente do repo (path derivado do diretorio deste
    script). Em worktree temporario o path muda e a task apontaria pra um
    diretorio deletado. ***

.PARAMETER Unregister
    Remove a task "Diaria-Cursos-Error-Alarm".

.EXAMPLE
    # Registrar (ou atualizar):
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-cursos-error-alarm-schedule.ps1

    # Remover:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-cursos-error-alarm-schedule.ps1 -Unregister

.NOTES
    Issue: #4320 (redesign GraphQL->contadores KV: #4382).
    Requer: Windows + Task Scheduler + junction data/ + CLOUDFLARE_ACCOUNT_ID +
    CLOUDFLARE_WORKERS_TOKEN + CURSOS_KV_NAMESPACE_ID + data/.credentials.json
    com scope gmail.send.
    Sem Admin: a task roda no contexto do usuario (RunLevel Limited).

    *** NAO EXECUTADO nesta sessao (#4320) -- worktree isolado sem acesso ao
    Task Scheduler real da maquina do editor nem a credenciais Cloudflare ao
    vivo. Rodar manualmente apos o merge (ver docs/cursos-worker-alarm-setup.md). ***
#>
param(
    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$WrapperPs1 = Join-Path $RepoRoot "scripts\run-cursos-error-alarm.ps1"

$TaskName = "Diaria-Cursos-Error-Alarm"
$TaskDesc = "Diar.ia: alarme de erro do worker cursos (#4320) - a cada 2h."

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

# A cada 2h, comecando agora, indefinidamente. -Once e SWITCH (nao aceita
# valor posicional) -- o instante inicial vai em -At (ver #4155, mesma
# armadilha documentada em setup-clarice-guardrail-alarm-schedule.ps1).
# -RepetitionDuration OMITIDO de proposito: sem ele a repeticao e indefinida
# (passar [TimeSpan]::MaxValue quebra o registro, ver #4155).
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 2)

$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit   (New-TimeSpan -Minutes 30) `
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
Write-Output "  Cadencia: a cada 2h"
Write-Output "  Log     : data\cursos-subscribers\.error-alarm.log"
Write-Output ""
Write-Output "Verificar: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Output "Remover  : .\scripts\setup-cursos-error-alarm-schedule.ps1 -Unregister"
Write-Output ""
