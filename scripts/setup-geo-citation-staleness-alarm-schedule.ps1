<#
.SYNOPSIS
    Registra (ou remove) a task "Diaria-Geo-Citation-Staleness-Alarm" no Task
    Scheduler -- alarme de staleness do monitor de citacao GEO (#4755),
    segundas 14:00.

.DESCRIPTION
    Cria uma tarefa agendada que roda `run-geo-citation-staleness-alarm.ps1`
    (que chama `geo-citation-staleness-alarm.ts`) toda segunda as 14:00 --
    algumas horas depois da task "Diaria-Geo-Citation-Monitor" (segundas
    10:30), que e quem escreve data/geo-citations/history.jsonl.

    `geo-citation-staleness-alarm.ts` le o `ts` do registro mais recente do
    history.jsonl e, se fizer mais de ~3 semanas (2 execucoes semanais
    perdidas + folga) sem registro novo, manda um e-mail (Gmail) ao editor.
    Idempotente por fingerprint do ultimo registro conhecido (nao reenvia o
    MESMO alarme a cada checagem semanal enquanto o historico continuar
    parado, mas RE-ARMA quando o historico volta a crescer e depois para de
    novo -- ver scripts/lib/geo-citation-staleness-alarm.ts).

    *** Por que esta task existe (#4755, achado do fleet review da #4754) ***

    test/pending-scheduled-tasks.test.ts descobre a task
    "Diaria-Geo-Citation-Monitor" pelo NOME (Get-ScheduledTask) mas nunca
    checa State/LastTaskResult -- uma task registrada e depois DESABILITADA
    (ou removida, ou a maquina fica semanas desligada, ou todo provider
    perde a API key) passa nesse guard em silencio. Todos esses motivos
    colapsam no MESMO sintoma observavel: history.jsonl para de crescer.
    Este alarme olha o SINTOMA, nao o registro da task -- cobre de uma vez
    os 4 modos de falha citados acima.

    NAO requer nenhuma API key de provider GEO (ANTHROPIC_API_KEY/
    OPENAI_API_KEY/GEMINI_API_KEY) -- so le o history.jsonl ja escrito,
    nunca chama os providers.

    StartWhenAvailable: se o horario for perdido (maquina desligada), roda
    quando disponivel.

    Idempotente: re-executar substitui a task. Use -Unregister para remover.

    *** Rodar SO no clone permanente do repo (path derivado do diretorio
    deste script). Em worktree temporario o path muda e a task apontaria pra
    um diretorio deletado. ***

.PARAMETER Unregister
    Remove a task "Diaria-Geo-Citation-Staleness-Alarm".

.EXAMPLE
    # Registrar (ou atualizar):
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-geo-citation-staleness-alarm-schedule.ps1

    # Remover:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-geo-citation-staleness-alarm-schedule.ps1 -Unregister

.NOTES
    Issue: #4755.
    Requer: Windows + Task Scheduler + junction data/ + data/.credentials.json
    com o scope gmail.send (mesmo requisito dos outros alarmes locais deste
    repo). NAO depende de nenhuma API key de provider GEO. Sem Admin: a
    task roda no contexto do usuario (RunLevel Limited).

    *** NAO EXECUTADO nesta sessao (#4755) -- worktree isolado sem acesso ao
    Task Scheduler real da maquina do editor nem a data/.credentials.json/
    Gmail ao vivo (mesma disciplina de #4320/#4382/#4490/#4534/#4723). Rodar
    manualmente apos o merge, quando o editor quiser habilitar o alarme --
    registro real e 1a execucao ficam pendentes, ver CLAUDE.md. ***
#>
param(
    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$WrapperPs1 = Join-Path $RepoRoot "scripts\run-geo-citation-staleness-alarm.ps1"

$TaskName = "Diaria-Geo-Citation-Staleness-Alarm"
$TaskDesc = "diar.ia.br: alarme de staleness do monitor de citacao GEO (#4755) - segundas 14:00, so e-mail, nunca chama provider nem escreve na Brevo/Beehiiv."

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

# Semanal, segundas 14:00 -- algumas horas depois do monitor (segundas 10:30),
# que e quem escreve o history.jsonl que este alarme le.
$Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At (Get-Date -Hour 14 -Minute 0 -Second 0)

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
Write-Output "  Horario : segundas 14:00 (semanal)"
Write-Output "  Log     : data\geo-citations\.staleness-alarm.log"
Write-Output "  Le      : data\geo-citations\history.jsonl"
Write-Output ""
Write-Output "Verificar: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Output "Remover  : .\scripts\setup-geo-citation-staleness-alarm-schedule.ps1 -Unregister"
Write-Output ""
