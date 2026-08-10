<#
.SYNOPSIS
    Registra (ou remove) a task "Diaria-Clarice-Novos" no Task Scheduler --
    envio diario aos cadastros novos da Clarice (Stripe -> MV -> campanha,
    #4347/#4941), diaria as 17:00.

.DESCRIPTION
    Cria uma tarefa agendada que roda `run-clarice-novos.ps1` (que chama
    `clarice-novos-run.ts`) todo dia as 17:00 -- automatiza o que ate o
    #4941 era invocacao MANUAL ~4x/semana de /diaria-clarice-novos.

    `clarice-novos-run.ts` orquestra deterministicamente os Passos 0-7:
    delta Stripe -> ingest no store -> MV roteado por cohort (guard D8) ->
    semaforo (D4) -> grupo 'novos' (--hold juridico, teto D13) -> import
    Brevo -> criacao da campanha -> disparo IMEDIATO (--send-now, D7) --
    SEM gate humano (D6, #4347). O toggle dedicado
    data/clarice-novos-enabled.json (default enabled:false) e o kill
    switch (#4941 E3): armar esta task NUNCA liga a automacao sozinho --
    o editor precisa escrever {"enabled": true} explicitamente depois de
    conferir a 1a rodada.

    Nenhum dos 9 guards deterministicos do #4347 muda de comportamento --
    cada um continua ABORTANDO a rodada (nunca so avisar). Toda rodada
    (sucesso, rodada vazia, ou abort) grava relatorio em
    data/clarice-subscribers/novos-reports/ e registra em
    data/reports/index.jsonl (superficie /relatorios do Studio, #3714) --
    inclusive nos caminhos de abort, pra uma rodada agendada que aborta
    nunca ficar indistinguivel de uma que nao rodou.

    StartWhenAvailable: se o horario for perdido (maquina desligada), roda
    quando disponivel.

    Idempotente: re-executar substitui a task. Use -Unregister para remover.

    *** Rodar SO no clone permanente do repo (path derivado do diretorio deste
    script). Em worktree temporario o path muda e a task apontaria pra um
    diretorio deletado. ***

    *** Armar SO em UMA maquina (decisao do editor, #4941 E4) -- data/ e
    junction do OneDrive sincronizada entre maquinas; duas maquinas armadas
    ao mesmo tempo podem resolver a MESMA --key no mesmo dia numa janela de
    latencia de sync e criar 2 campanhas (envio duplicado). Sem lock novo
    pra isso -- documentar onde a 2a maquina for armada e o suficiente. ***

.PARAMETER Unregister
    Remove a task "Diaria-Clarice-Novos".

.EXAMPLE
    # Registrar (ou atualizar):
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-clarice-novos-schedule.ps1

    # Remover:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-clarice-novos-schedule.ps1 -Unregister

.NOTES
    Issue: #4347, #4941.
    Requer: Windows + Task Scheduler + junction data/ + STRIPE_API_KEY +
    BREVO_CLARICE_API_KEY + MILLION_VERIFIER_API_KEY. Sem Admin: a task
    roda no contexto do usuario (RunLevel Limited).
#>
param(
    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$WrapperPs1 = Join-Path $RepoRoot "scripts\run-clarice-novos.ps1"

$TaskName = "Diaria-Clarice-Novos"
$TaskDesc = "diar.ia.br: envio diario aos cadastros novos da Clarice (#4347/#4941) - 17:00, gated pelo toggle data/clarice-novos-enabled.json."

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

# Diaria as 17:00 -- ver .DESCRIPTION. Sem colisao com nenhuma outra task
# armada do repo.
$Trigger = New-ScheduledTaskTrigger -Daily -At (Get-Date -Hour 17 -Minute 0 -Second 0)

$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit   (New-TimeSpan -Hours 1) `
    -MultipleInstances    IgnoreNew `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

# Register-ScheduledTask -Force cria OU sobrescreve (idempotente) e aceita
# -Description. NAO usar Set-ScheduledTask no branch de update: ele nao tem
# parametro -Description (falha com "NamedParameterNotFound" ao re-rodar
# sobre uma task existente -- #3757/#3764).
$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName    $TaskName `
    -Action      $Action `
    -Trigger     $Trigger `
    -Settings    $Settings `
    -Description $TaskDesc `
    -RunLevel    Limited `
    -Force | Out-Null

# #3775: Register-ScheduledTask -Force substitui a task INTEIRA (ao contrario
# de Set-ScheduledTask, que so atualiza os campos passados) -- qualquer
# propriedade nao especificada nesta chamada volta ao default, incluindo
# Enabled=True. Se o editor tinha desabilitado a task manualmente, restaura
# esse estado aqui; senao o -Force reativa a task silenciosamente, sem log
# nem aviso.
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
Write-Output "  Horario : 17:00 diario"
Write-Output "  Log     : data\clarice-subscribers\.novos-run.log"
Write-Output ""
Write-Output "*** A automacao continua PAUSADA ate voce liberar o toggle: ***"
Write-Output "  npx tsx scripts/lib/clarice-novos-enabled.ts --set enabled"
Write-Output ""
Write-Output "Verificar: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Output "Remover  : .\scripts\setup-clarice-novos-schedule.ps1 -Unregister"
Write-Output ""
