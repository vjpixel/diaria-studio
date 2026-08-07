<#
.SYNOPSIS
    Registra (ou remove) a task "Diaria-Geo-Citation-Monitor" no Task
    Scheduler -- monitor SEMANAL de citacao por assistente de IA (#4558
    Parte C), segundas 10:30.

.DESCRIPTION
    Cria uma tarefa agendada que roda `run-geo-citation-monitor.ps1` (que
    chama `geo-citation-monitor.ts`) toda segunda as 10:30 -- depois das
    tasks diarias de sync (08:30 Clarice, 09:15 cursos KV, 09:45 apoios), pra
    nao concorrer pelo mesmo horario de rede/CPU local.

    O monitor pergunta a cada provedor configurado as perguntas fixas de
    GEO_QUESTIONS ("Qual a melhor newsletter diaria sobre inteligencia
    artificial em portugues?" e vizinhas) e registra em
    data/geo-citations/history.jsonl se a diar.ia.br foi citada.

    *** Por que esta task existe ***

    O monitor foi mergeado no #4616 e ficou sem NUNCA ter rodado --
    data/geo-citations/ nao existia no disco ate 07/ago. Nenhum .ps1, nenhum
    workflow, nenhuma task o invocava -- enquanto TODAS as outras tasks
    agendadas do repo ja seguiam esse padrao (13 em 07/ago; conferir com
    `ls scripts/setup-*-schedule.ps1` em vez de confiar neste numero, que
    cresce a cada task nova). Sem cadencia, o baseline medido em 07/ago
    (0 de 16 consultas citaram) morre sozinho e a tese GEO da #4558 nunca
    ganha serie temporal pra ser avaliada.

    *** Por que SEMANAL e nao diario ***

    Citacao por assistente muda em escala de semanas; a serie so tem valor
    como tendencia; e cada execucao gasta 8 perguntas x N provedores em
    chamadas de API. Diario seria gastar 7x pra ler ruido.

    NAO ASSUMIR custo uniforme entre provedores: OpenAI e Anthropic cobram por
    token, mas a Gemini historicamente tem free tier que 8 chamadas/semana
    plausivelmente nao estouram. Nunca foi medido -- se alguem for reafirmar
    "custa X por execucao", conferir a fatura real de cada provedor antes
    (principio de zero custo recorrente do CLAUDE.md).

    *** Fail-soft por provedor ***

    O script pula quem nao tem API key e reporta quais pulou -- isso NAO
    reprova a run. Em 07/ago rodou com OpenAI + Gemini (ANTHROPIC_API_KEY
    ausente do .env). Meia medicao vale mais que nenhuma; o log registra a
    cobertura parcial.

    StartWhenAvailable: se o horario for perdido (maquina desligada), roda
    quando disponivel.

    Idempotente: re-executar substitui a task. Use -Unregister para remover.

    *** Rodar SO no clone permanente do repo (path derivado do diretorio
    deste script). Em worktree temporario o path muda e a task apontaria pra
    um diretorio deletado. ***

.PARAMETER Unregister
    Remove a task "Diaria-Geo-Citation-Monitor".

.EXAMPLE
    # Registrar (ou atualizar):
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-geo-citation-monitor-schedule.ps1

    # Remover:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-geo-citation-monitor-schedule.ps1 -Unregister

.NOTES
    Issue: #4558 Parte C.
    Requer: Windows + Task Scheduler + junction data/ + pelo menos UMA de
    ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY no .env.
    Sem Admin: a task roda no contexto do usuario (RunLevel Limited).

    *** NAO EXECUTADO nesta sessao -- registro real da task fica pendente do
    editor, mesma disciplina de #4320/#4382/#4490/#4534/#4723. A 1a execucao
    do monitor em si JA rodou ao vivo em 07/ago (baseline 0 de 16,
    comentado na #4558); o que falta e a cadencia. ***
#>
param(
    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$WrapperPs1 = Join-Path $RepoRoot "scripts\run-geo-citation-monitor.ps1"

$TaskName = "Diaria-Geo-Citation-Monitor"
$TaskDesc = "diar.ia.br: monitor semanal de citacao por assistente de IA (#4558 Parte C) - segundas 10:30."

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

# Semanal, segundas 10:30. Ver docstring pro racional de semanal vs diario.
$Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At (Get-Date -Hour 10 -Minute 30 -Second 0)

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
Write-Output "  Horario : segundas 10:30 (semanal)"
Write-Output "  Log     : data\geo-citations\.monitor.log"
Write-Output "  Serie   : data\geo-citations\history.jsonl"
Write-Output ""
Write-Output "Verificar: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Output "Remover  : .\scripts\setup-geo-citation-monitor-schedule.ps1 -Unregister"
Write-Output ""
