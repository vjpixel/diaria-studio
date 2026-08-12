<#
.SYNOPSIS
    Registra (ou remove) o PAR de tasks da automacao de envio da Clarice no
    Task Scheduler (decisoes do editor 260811):
      - "Diaria-Clarice-Envio"       -- diaria as 19:00 (planeja + agenda)
      - "Diaria-Clarice-Envio-Guard" -- diaria as 05:00 (reavalia o freio)

.DESCRIPTION
    Um script, DUAS tasks -- de proposito: elas sao um par indivisivel. A
    task das 19:00 planeja a onda do dia seguinte e AGENDA a campanha pras
    06:00 BRT (09:00 UTC); a das 05:00 reavalia o freio de risco de ISP com
    ~11h de bounce/unsub/spam novos e e a ultima chance de segurar o disparo.
    Armar uma sem a outra e uma configuracao que ninguem quer: so a das 19:00
    agenda sem rede de seguranca, so a das 05:00 vigia uma onda que nunca e
    agendada.

    O QUE A RODADA DAS 19:00 FAZ (scripts/clarice-envio-run.ts):
      - FREIO = so risco de ISP, janela dos ultimos 3 dias de envio
        (bounce/unsub ja finais em T+13h): hard bounce >=2%, bounce total
        (hard+soft) >=5%, unsub >=3%, spam Postmaster >=0,3%. Limiares
        mantidos como estao em workers/brevo-dashboard/src/thresholds.ts.
      - ABERTURA NAO FREIA VOLUME (decisao do editor 260811). A base de 1o
        envio e ~96% fria e abre ~1%; o limiar antigo (openRate < 15% =>
        vermelho => corta 30%) era uma catraca que zerava o envio -- medido:
        10.014 -> 322 -> 1.053 -> 817. Abertura virou metrica de
        observacao/tendencia (janela 60d), reportada e nunca aplicada como
        corte.
      - ACELERADOR = escalada adaptativa pela folga ate os limiares (janela
        30 dias), teto +25%/dia, substituindo o +10% fixo. Volume base = o
        ultimo dia enviado, escalando dali (sem reset).
      - SEM teto absoluto de volume (decisao do editor): limitam so a fila, o
        credito Brevo e o freio.
      - SUNSET: contato com >=2 envios e 0 aberturas vira INELEGIVEL, pra
        cortar o laco que alimenta spam.

    KILL SWITCH -- data/clarice-envio-enabled.json, comum as duas tasks.
    *** Default LIGADO quando o arquivo esta ausente *** (decisao do editor,
    "ligada desde o inicio"): ao contrario da Diaria-Clarice-Novos, armar
    ESTA task JA liga a automacao. Pra pausar:
        npx tsx scripts/lib/clarice-envio-enabled.ts --set disabled
    Arquivo CORROMPIDO (JSON invalido/vazio) e tratado como PAUSADO, com
    aviso -- ilegivel e sinal de problema, nao de intencao.

    StartWhenAvailable: se o horario for perdido (maquina desligada), roda
    quando disponivel.

    Idempotente: re-executar substitui as duas tasks. Use -Unregister para
    remover as duas.

    *** Rodar SO no clone permanente do repo (path derivado do diretorio
    deste script). Em worktree temporario o path muda e as tasks apontariam
    pra um diretorio deletado. ***

    *** Armar SO em UMA maquina -- a escolhida pelo editor e `predator`.
    data/ e junction do OneDrive sincronizada entre maquinas; duas maquinas
    armadas resolvem o mesmo dia na mesma janela de latencia de sync e podem
    agendar a MESMA onda duas vezes (envio duplicado real). Sem lock novo pra
    isso -- desarmar a 1a antes de armar uma 2a e o suficiente. ***

.PARAMETER Unregister
    Remove as duas tasks ("Diaria-Clarice-Envio" e
    "Diaria-Clarice-Envio-Guard").

.EXAMPLE
    # Registrar (ou atualizar) as duas:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-clarice-envio-schedule.ps1

    # Remover as duas:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-clarice-envio-schedule.ps1 -Unregister

.NOTES
    Decisoes do editor 260811 (automacao do envio Clarice).
    Molde: setup-clarice-novos-schedule.ps1 (#4347/#4941).
    Requer: Windows + Task Scheduler + junction data/ + BREVO_CLARICE_API_KEY.
    Sem Admin: as tasks rodam no contexto do usuario (RunLevel Limited).
#>
param(
    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir       = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot        = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$WrapperPs1      = Join-Path $RepoRoot "scripts\run-clarice-envio.ps1"
$GuardWrapperPs1 = Join-Path $RepoRoot "scripts\run-clarice-envio-guard.ps1"

$TaskName      = "Diaria-Clarice-Envio"
$TaskDesc      = "diar.ia.br: planeja e agenda a onda Clarice do dia seguinte (06:00 BRT) - 19:00, freio por risco de ISP + escalada adaptativa, gated pelo toggle data/clarice-envio-enabled.json (default LIGADO)."
$GuardTaskName = "Diaria-Clarice-Envio-Guard"
$GuardTaskDesc = "diar.ia.br: guard matinal da onda Clarice ja agendada - 05:00, reavalia o freio de risco de ISP antes do disparo das 06:00."

if (-not (Test-Path $WrapperPs1)) {
    Write-Error "Wrapper nao encontrado: $WrapperPs1"
    exit 1
}
if (-not (Test-Path $GuardWrapperPs1)) {
    Write-Error "Wrapper nao encontrado: $GuardWrapperPs1"
    exit 1
}

# ---------------------------------------------------------------------------
# Remover (as duas -- o par e indivisivel, ver .DESCRIPTION)
# ---------------------------------------------------------------------------
if ($Unregister) {
    foreach ($Name in @($TaskName, $GuardTaskName)) {
        $Found = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
        if ($Found) {
            Unregister-ScheduledTask -TaskName $Name -Confirm:$false
            Write-Output "Task '$Name' removida."
        } else {
            Write-Output "Task '$Name' nao encontrada (ja removida ou nunca registrada)."
        }
    }
    exit 0
}

# ---------------------------------------------------------------------------
# Registrar / atualizar -- task 1 de 2: Diaria-Clarice-Envio (19:00)
# ---------------------------------------------------------------------------
$Action = New-ScheduledTaskAction `
    -Execute  "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$WrapperPs1`"" `
    -WorkingDirectory $RepoRoot

# Diaria as 19:00 -- depois da Diaria-Clarice-Novos (11:00 desde #5140) de proposito: os
# cadastros novos do dia ja entraram no store antes do planejamento da onda.
$Trigger = New-ScheduledTaskTrigger -Daily -At (Get-Date -Hour 19 -Minute 0 -Second 0)

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

# ---------------------------------------------------------------------------
# Registrar / atualizar -- task 2 de 2: Diaria-Clarice-Envio-Guard (05:00)
# ---------------------------------------------------------------------------
$GuardAction = New-ScheduledTaskAction `
    -Execute  "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$GuardWrapperPs1`"" `
    -WorkingDirectory $RepoRoot

# Diaria as 05:00 -- 1h de folga antes do disparo das 06:00 BRT, e 30min
# antes do Diaria-Brevo-Diaria-Evaluate (05:30). Mesma classe de restricao do
# #4534: tem que rodar ANTES do envio, senao a acao nao afeta a campanha do
# dia (a Brevo congela destinatarios no agendamento, nao no envio).
$GuardTrigger = New-ScheduledTaskTrigger -Daily -At (Get-Date -Hour 5 -Minute 0 -Second 0)

$GuardSettings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit   (New-TimeSpan -Minutes 30) `
    -MultipleInstances    IgnoreNew `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

$GuardExisting = Get-ScheduledTask -TaskName $GuardTaskName -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName    $GuardTaskName `
    -Action      $GuardAction `
    -Trigger     $GuardTrigger `
    -Settings    $GuardSettings `
    -Description $GuardTaskDesc `
    -RunLevel    Limited `
    -Force | Out-Null

# Mesmo #3775 da task acima: -Force reativaria um Disable manual em silencio.
if ($GuardExisting -and $GuardExisting.State -eq "Disabled") {
    Disable-ScheduledTask -TaskName $GuardTaskName | Out-Null
}

if ($GuardExisting) {
    Write-Output "Task '$GuardTaskName' atualizada."
} else {
    Write-Output "Task '$GuardTaskName' registrada."
}

Write-Output ""
Write-Output "Configuracao:"
Write-Output "  Wrapper (run)   : $WrapperPs1"
Write-Output "  Wrapper (guard) : $GuardWrapperPs1"
Write-Output "  Repo            : $RepoRoot"
Write-Output "  Horarios        : 19:00 (planeja+agenda) e 05:00 (guard) diarios"
Write-Output "  Logs            : data\clarice-subscribers\.envio-run.log"
Write-Output "                    data\clarice-subscribers\.envio-guard.log"
Write-Output ""
Write-Output "*** A automacao ja nasce LIGADA (default do toggle quando o arquivo esta ausente). ***"
Write-Output "  Ver estado : npx tsx scripts/lib/clarice-envio-enabled.ts"
Write-Output "  Pausar     : npx tsx scripts/lib/clarice-envio-enabled.ts --set disabled"
Write-Output "  Religar    : npx tsx scripts/lib/clarice-envio-enabled.ts --set enabled"
Write-Output ""
Write-Output "Verificar: Get-ScheduledTask -TaskName '$TaskName','$GuardTaskName' | Get-ScheduledTaskInfo"
Write-Output "Remover  : .\scripts\setup-clarice-envio-schedule.ps1 -Unregister"
Write-Output ""
