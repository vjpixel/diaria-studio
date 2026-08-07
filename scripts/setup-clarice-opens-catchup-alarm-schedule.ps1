<#
.SYNOPSIS
    Registra (ou remove) a task "Diaria-Clarice-Opens-Catchup-Alarm" no Task
    Scheduler -- alarme de falha sustentada do catch-up de opens da Clarice
    (#4740, #4722 item 4), diario as 09:00.

.DESCRIPTION
    Cria uma tarefa agendada que roda `run-clarice-opens-catchup-alarm.ps1`
    (que chama `clarice-opens-catchup-alarm.ts`) todo dia as 09:00 -- depois
    da task "Diaria-Clarice-Sync" (08:30, que agora tambem escreve
    data/clarice-subscribers/last-opens-catchup-status.json via
    extract-opens-catchup-status.ts) e antes da "Diaria-Cursos-Kv-Sync"
    (09:15).

    `clarice-opens-catchup-alarm.ts` le o status mais recente e avanca um
    streak de falhas CONSECUTIVAS do catch-up de opens (#4688) -- 1 falha
    isolada e normal (rede/rate-limit transitorio), N falhas seguidas e sinal
    real de algo quebrado. Ao atingir o threshold, manda um e-mail (Gmail) ao
    editor; idempotente (nao reenvia o MESMO alarme a cada checagem enquanto
    o streak persistir -- ver scripts/lib/clarice-opens-catchup-alarm.ts).

    O catch-up e fail-soft por design (nunca reprova o sync principal do
    store) -- este alarme existe justamente porque uma falha recorrente
    NESSE mecanismo de correcao passaria despercebida indefinidamente sem
    ele (mesma classe de gap que o #4688 original resolveu para opens_count).

    StartWhenAvailable: se o horario for perdido (maquina desligada), roda
    quando disponivel.

    Idempotente: re-executar substitui a task. Use -Unregister para remover.

    *** Rodar SO no clone permanente do repo (path derivado do diretorio deste
    script). Em worktree temporario o path muda e a task apontaria pra um
    diretorio deletado. ***

.PARAMETER Unregister
    Remove a task "Diaria-Clarice-Opens-Catchup-Alarm".

.EXAMPLE
    # Registrar (ou atualizar):
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-clarice-opens-catchup-alarm-schedule.ps1

    # Remover:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-clarice-opens-catchup-alarm-schedule.ps1 -Unregister

.NOTES
    Issue: #4740 (#4722 item 4).
    Requer: Windows + Task Scheduler + junction data/ + data/.credentials.json
    com o scope gmail.send. Depende da task "Diaria-Clarice-Sync" ja estar
    armada (e o wrapper dela, run-clarice-sync-daily.ps1, ja escrevendo
    last-opens-catchup-status.json) -- sem isso, este alarme sempre le
    status "not_run" (neutro, nunca alarma, mas tambem nunca detecta falha
    real). Sem Admin: a task roda no contexto do usuario (RunLevel Limited).

    *** NAO EXECUTADO nesta sessao (#4740) -- worktree isolado sem acesso ao
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
$WrapperPs1 = Join-Path $RepoRoot "scripts\run-clarice-opens-catchup-alarm.ps1"

$TaskName = "Diaria-Clarice-Opens-Catchup-Alarm"
$TaskDesc = "diar.ia.br: alarme de falha sustentada do catch-up de opens da Clarice (#4740) - 09:00, so e-mail, nunca escreve na Brevo."

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

# Diario as 09:00 -- depois do sync (08:30) que escreve o status consumido
# aqui, antes do Diaria-Cursos-Kv-Sync (09:15), pra nao concorrer por rede/CPU.
$Trigger = New-ScheduledTaskTrigger -Daily -At (Get-Date -Hour 9 -Minute 0 -Second 0)

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
Write-Output "  Horario : 09:00 diario"
Write-Output "  Log     : data\clarice-subscribers\.opens-catchup-alarm.log"
Write-Output ""
Write-Output "Verificar: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Output "Remover  : .\scripts\setup-clarice-opens-catchup-alarm-schedule.ps1 -Unregister"
Write-Output ""
