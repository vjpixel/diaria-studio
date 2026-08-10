<#
.SYNOPSIS
    Registra (ou remove) a task "Diaria-Postmaster-Spam-Sync" no Task
    Scheduler -- sync automatico do spamRate do Google Postmaster Tools
    (#4154), diaria as 12:30.

.DESCRIPTION
    Cria uma tarefa agendada que roda `run-postmaster-spam-sync.ps1` (que
    chama `postmaster-spam-sync.ts`) todo dia as 12:30 (mudou de "a cada 12h"
    pra diaria, decisao do editor 260810). Sem essa task, a leitura do
    Postmaster continua dependendo do editor abrir o painel manualmente antes
    de cada envio (scripts/postmaster-spam-entry.ts) -- funcional, mas facil
    de esquecer, e o esquecimento trava o escalonamento de volume do ramp
    (sinal vira `indeterminate` apos 48h sem leitura fresca).

    Cadencia: a leitura e uma MEDIA sobre HEALTH_SAMPLE_DAYS (mesma janela das
    outras metricas da aba Rampa, pedido do editor 260730) -- o dado fonte em
    si so muda em granularidade diaria, entao rodar 2x/dia (cadencia antiga)
    nao lia nada mais fresco, so gastava a chamada a toa. 1x/dia as 12:30
    basta; StartWhenAvailable ja cobre execucao perdida por maquina desligada.
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
$TaskDesc = "diar.ia.br: sync automatico do spamRate do Google Postmaster Tools (#4154) - diaria 12:30."

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

# Diaria, 12:30. Ver .DESCRIPTION pro porque de nao ser mais "a cada 12h".
$Trigger = New-ScheduledTaskTrigger -Daily -At (Get-Date -Hour 12 -Minute 30 -Second 0)

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
Write-Output "  Cadencia: diaria 12:30"
Write-Output "  Log     : data\clarice-subscribers\.postmaster-spam-sync.log"
Write-Output ""
Write-Output "Verificar: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Output "Remover  : .\scripts\setup-postmaster-spam-sync-schedule.ps1 -Unregister"
Write-Output ""
