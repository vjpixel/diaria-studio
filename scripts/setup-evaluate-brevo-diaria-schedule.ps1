<#
.SYNOPSIS
    Registra (ou remove) a task "Diaria-Brevo-Diaria-Evaluate" no Task
    Scheduler -- evaluate diario do canal Brevo proprio do editor (#4534,
    fecha o checkbox aberto da #4476), 05:30 BRT.

.DESCRIPTION
    Cria uma tarefa agendada que roda `run-evaluate-brevo-diaria.ps1` (que
    chama `evaluate-brevo-diaria.ts --push`) todo dia as 05:30 -- ANTES do
    envio canonico das 06:00 BRT.

    O horario nao e preferencia, e restricao real: a Brevo congela
    destinatarios no AGENDAMENTO da campanha, nao no envio (ver memoria
    "brevo-recipients-snapshot"). Se o evaluate rodar DEPOIS da campanha do
    dia ja ter sido criada/agendada, o unlink de quem foi promovido/suprimido
    nao tem efeito nesse envio -- a pessoa recebe mesmo assim.

    `evaluate-brevo-diaria.ts --push` roda o fluxo COMPLETO aprovado na
    #4476 (item 2, "duas vias de promocao em paralelo"): descadastro NATIVO
    (Passo 0) + auto-confirmacao (Passo 1) + promocao/supressao por score
    (Passo 2, com janela de maturacao de 48h so pra supressao) -- todos com
    unlink da lista Brevo (`unlinkFromBrevoList`) apos confirmar a escrita.
    Sem essa task rodando, o canal `brevo_diaria` so para de mandar pra quem
    for desvinculado manualmente da lista -- quem se cadastra na Beehiiv
    vindo da diaria Brevo continua recebendo os dois canais por tempo
    indeterminado, e o cap de envio (`checkDailySendCap`) continua contando
    a lista inteira em vez da populacao `in_brevo` real.

    StartWhenAvailable: se o horario for perdido (maquina desligada), roda
    quando disponivel.

    Idempotente: re-executar substitui a task. Use -Unregister para remover.

    *** Rodar SO no clone permanente do repo (path derivado do diretorio deste
    script). Em worktree temporario o path muda e a task apontaria pra um
    diretorio deletado. ***

.PARAMETER Unregister
    Remove a task "Diaria-Brevo-Diaria-Evaluate".

.EXAMPLE
    # Registrar (ou atualizar):
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-evaluate-brevo-diaria-schedule.ps1

    # Remover:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-evaluate-brevo-diaria-schedule.ps1 -Unregister

.NOTES
    Issue: #4534.
    Requer: Windows + Task Scheduler + junction data/ + BREVO_DIARIA_API_KEY +
    BEEHIIV_API_KEY (+ opcional BEEHIIV_PUBLICATION_ID).
    Sem Admin: a task roda no contexto do usuario (RunLevel Limited).

    *** NAO EXECUTADO nesta sessao (#4534) -- worktree isolado sem acesso ao
    Task Scheduler real da maquina do editor nem a credenciais Brevo/Beehiiv
    ao vivo (mesma disciplina de #4320/#4382/#4490). Rodar manualmente apos
    o merge, quando o editor quiser habilitar a task -- registro real e 1a
    execucao ficam pendentes, ver CLAUDE.md. ***
#>
param(
    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$WrapperPs1 = Join-Path $RepoRoot "scripts\run-evaluate-brevo-diaria.ps1"

$TaskName = "Diaria-Brevo-Diaria-Evaluate"
$TaskDesc = "diar.ia.br: evaluate diario do canal brevo_diaria (#4534) - 05:30, antes do envio das 06:00, --push completo (descadastro nativo + auto-confirmacao + promocao/supressao por score)."

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

# Diario as 05:30 -- antes do envio canonico das 06:00 BRT (a Brevo congela
# destinatarios no agendamento da campanha, nao no envio).
$Trigger = New-ScheduledTaskTrigger -Daily -At (Get-Date -Hour 5 -Minute 30 -Second 0)

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
Write-Output "  Horario : 05:30 diario (--push completo, antes do envio das 06:00)"
Write-Output "  Log     : data\brevo-diaria\.evaluate.log"
Write-Output ""
Write-Output "Verificar: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Output "Remover  : .\scripts\setup-evaluate-brevo-diaria-schedule.ps1 -Unregister"
Write-Output ""
