<#
.SYNOPSIS
    Registra (ou remove) a task "Diaria-Postmaster-Spam-Sync" no Task
    Scheduler -- sync automatico do spamRate do Google Postmaster Tools
    (#4154), a cada 12h.

.DESCRIPTION
    Cria uma tarefa agendada que roda `run-postmaster-spam-sync.ps1` (que
    chama `postmaster-spam-sync.ts`) a cada 12h. Sem essa task, a leitura do
    Postmaster continua dependendo do editor abrir o painel manualmente antes
    de cada envio (scripts/postmaster-spam-entry.ts) -- funcional, mas facil
    de esquecer, e o esquecimento trava o escalonamento de volume do ramp
    (sinal vira `indeterminate` apos 48h sem leitura fresca).

    Cadencia: a leitura e uma MEDIA sobre HEALTH_SAMPLE_DAYS (mesma janela das
    outras metricas da aba Rampa, pedido do editor 260730), entao 1x/dia ja
    bastaria -- 12h da margem contra maquina desligada/execucao perdida sem
    custo real (a chamada e leve, poucas requests por dia da janela).
    recordedAt e sempre "agora" no momento da gravacao, entao cada run
    bem-sucedida reseta a janela de staleness de 48h do breaker
    (POSTMASTER_STALE_MS em thresholds.ts).

    StartWhenAvailable: se o horario for perdido (maquina desligada), roda
    quando disponivel.

    Idempotente: re-executar substitui a task. Use -Unregister para remover.

    *** Rodar SO no clone permanente do repo (path derivado do diretorio deste
    script). Em worktree temporario o path muda e a task apontaria pra um
    diretorio deletado. ***

.PARAMETER Unregister
    Remove a task "Diaria-Postmaster-Spam-Sync".

.EXAMPLE
    # Registrar (ou atualizar):
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-postmaster-spam-sync-schedule.ps1

    # Remover:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-postmaster-spam-sync-schedule.ps1 -Unregister

.NOTES
    Issue: #4154.
    Requer: Windows + Task Scheduler + junction data/ + data/.credentials.json
    com scope postmaster.readonly + CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_WORKERS_TOKEN.
    Sem Admin: a task roda no contexto do usuario (RunLevel Limited).
#>
param(
    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$WrapperPs1 = Join-Path $RepoRoot "scripts\run-postmaster-spam-sync.ps1"

$TaskName = "Diaria-Postmaster-Spam-Sync"
$TaskDesc = "Diar.ia: sync automatico do spamRate do Google Postmaster Tools (#4154) - a cada 12h."

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

# A cada 12h, comecando agora, indefinidamente.
# -Once e SWITCH, nao aceita valor posicional: o instante inicial vai em -At
# (ver #4155 -- sem -At explicito o registro falha em silencio).
# -RepetitionDuration OMITIDO de proposito: sem ele a repeticao e indefinida
# (ver #4155 -- TimeSpan::MaxValue quebra o XML do Task Scheduler).
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 12)

$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit   (New-TimeSpan -Minutes 15) `
    -MultipleInstances    IgnoreNew `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

# Register-ScheduledTask -Force cria OU sobrescreve (idempotente) e aceita
# -Description. NAO usar Set-ScheduledTask no branch de update: ele nao tem
# parametro -Description (#3757/#3764).
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
# propriedade nao especificada nesta chamada volta ao default, incluindo
# Enabled=True. Se o editor tinha desabilitado a task manualmente, restaura
# esse estado aqui; senao o -Force reativa a task silenciosamente.
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
Write-Output "  Cadencia: a cada 12h"
Write-Output "  Log     : data\clarice-subscribers\.postmaster-spam-sync.log"
Write-Output ""
Write-Output "Verificar: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Output "Remover  : .\scripts\setup-postmaster-spam-sync-schedule.ps1 -Unregister"
Write-Output ""
