<#
.SYNOPSIS
    Registra (ou remove) a task "Diaria-Edicao-Diaria" no Windows Task
    Scheduler — reativação Windows do #5611 (reverte parte do #5115/#5162).

.DESCRIPTION
    Cria uma tarefa agendada que roda `run-scheduled-edicao.ps1` (wrapper
    fino que invoca `npx tsx scripts/overnight/run-scheduled-edicao.ts` — a
    lógica real, já testada e multiplataforma, compartilhada com o par
    Linux/systemd, ver `scripts/lib/edicao-systemd-units.ts`) de domingo a
    quinta-feira às 16:00 (horário local da máquina = BRT) — mesmo
    calendário do timer systemd (`Sun,Mon,Tue,Wed,Thu 16:00
    America/Sao_Paulo`), pra manter as duas vias intercambiáveis mesmo com
    só uma armada por vez.

    Idempotente: re-executar substitui a task existente. Use -Unregister
    para remover a task.

    *** NÃO EXECUTAR durante setup de worktrees temporários ***
    O path do runner é derivado do diretório deste script. Em worktrees
    temporários (agentes `/diaria-develop`, `/diaria-overnight`) o path
    muda; registrar agora criaria a task apontando para um diretório que
    será deletado. Execute este script APENAS no clone permanente do repo,
    após o merge do PR. (Mesma ressalva do `.ps1` original, pré-#5115.)

    Também publica (best-effort) um marcador cross-machine em
    data/edicao-diaria-schedule-attestation.json a cada registro/remoção —
    ver scripts/lib/edicao-schedule-attestation.ts (#7036). Consumido pelo
    alarme edicao-diaria-staleness-alarm.ts pra não silenciar por engano
    quando esta máquina está armada mas o alarme roda em outra (helios).

.PARAMETER Unregister
    Remove a task "Diaria-Edicao-Diaria" do Task Scheduler.

.EXAMPLE
    # Registrar (ou atualizar) a task:
    powershell -NoProfile -ExecutionPolicy Bypass `
        -File .\scripts\overnight\setup-edicao-schedule.ps1

    # Remover a task:
    powershell -NoProfile -ExecutionPolicy Bypass `
        -File .\scripts\overnight\setup-edicao-schedule.ps1 -Unregister

.NOTES
    Issue: #5611 (reverte parte do #5115/#5162; história original #2068/#4998); #7036 (atestação cross-machine)
    Requer: Windows com Task Scheduler (schtasks.exe ou New-ScheduledTask).
    Sem privilégios de Admin, a task é registrada para o usuário atual
    (sem "Run as SYSTEM") — suficiente: roda no contexto do usuário que tem
    Claude Code autenticado E o Chrome logado (motivo original da via
    Windows, ver corpo da issue #5611).
#>
param(
    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Paths (derivados do próprio script — sem hardcode de usuário/máquina)
# ---------------------------------------------------------------------------
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = (Resolve-Path (Join-Path $ScriptDir "../..")).Path
$RunnerPath = Join-Path $ScriptDir "run-scheduled-edicao.ps1"

$TaskName = "Diaria-Edicao-Diaria"
$TaskDesc = "diar.ia.br: roda /diaria-edicao D+1 de dom-qui 16:00 BRT (Stages 0-4 + pre-render, via run-scheduled-edicao.ts), pula se a edicao ja foi iniciada."

# ---------------------------------------------------------------------------
# Atestação cross-machine (#7036) — publica em data/ (junction do OneDrive,
# ver CLAUDE.md § Setup) se ESTA máquina tem a task armada, pra que o alarme
# `edicao-diaria-staleness-alarm.ts` rodando em OUTRA máquina (hoje: helios)
# não silencie por engano quando o agendador LOCAL dele está `disabled` mas
# a via Windows está de fato ativa. Best-effort: nunca falha o
# registro/remoção da task se a escrita der erro (`data/` pode não existir
# nesta máquina, permissão, OneDrive fora do ar) — só avisa.
# Formato/consumidor: scripts/lib/edicao-schedule-attestation.ts.
# ---------------------------------------------------------------------------
$AttestationPath = Join-Path $RepoRoot "data\edicao-diaria-schedule-attestation.json"

function Write-EdicaoScheduleAttestation {
    param([bool]$Armed)
    try {
        $attestation = [ordered]@{
            machine    = $env:COMPUTERNAME
            scheduler  = "windows-task-scheduler"
            armed      = $Armed
            updatedAt  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        }
        $dataDir = Split-Path -Parent $AttestationPath
        if (-not (Test-Path $dataDir)) {
            Write-Warning "Atestação cross-machine NÃO gravada — '$dataDir' não existe nesta máquina (ver CLAUDE.md § Setup, junction do OneDrive)."
            return
        }
        ($attestation | ConvertTo-Json -Compress) | Set-Content -Path $AttestationPath -Encoding utf8 -NoNewline
        Write-Output "Atestação cross-machine gravada em $AttestationPath (armed=$Armed)."
    } catch {
        Write-Warning "Falha ao gravar atestação cross-machine em '$AttestationPath' (não bloqueia o registro/remoção da task): $_"
    }
}

# ---------------------------------------------------------------------------
# Guard: garantir que o runner existe no path derivado
# ---------------------------------------------------------------------------
if (-not (Test-Path $RunnerPath)) {
    Write-Error "Runner não encontrado: $RunnerPath"
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
        Write-Output "Task '$TaskName' não encontrada (já removida ou nunca registrada)."
    }
    Write-EdicaoScheduleAttestation -Armed $false
    exit 0
}

# ---------------------------------------------------------------------------
# Registrar / atualizar
# ---------------------------------------------------------------------------

# Action: powershell.exe -NoProfile -ExecutionPolicy Bypass -File <runner>
$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$RunnerPath`"" `
    -WorkingDirectory $RepoRoot

# Trigger: semanal, dom-qui, 16:00 — mesmo calendário do timer systemd
# (scripts/lib/edicao-systemd-units.ts, buildEdicaoOnCalendar).
$Trigger = New-ScheduledTaskTrigger `
    -Weekly `
    -DaysOfWeek Sunday,Monday,Tuesday,Wednesday,Thursday `
    -At "16:00"

# Settings
$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 3) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

# Registrar (idempotente). Register-ScheduledTask -Force cria OU sobrescreve e
# aceita -Description. NÃO usar Set-ScheduledTask no branch de update: ele não
# tem parâmetro -Description (falhava com "NamedParameterNotFound" ao re-rodar
# sobre uma task existente — #3757/#3764).
$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName    $TaskName `
    -Action      $Action `
    -Trigger     $Trigger `
    -Settings    $Settings `
    -Description $TaskDesc `
    -RunLevel    Limited `
    -Force | Out-Null

# #3775: Register-ScheduledTask -Force substitui a task INTEIRA (ao contrário de
# Set-ScheduledTask, que só atualiza os campos passados) — qualquer propriedade
# não especificada nesta chamada volta ao default, incluindo Enabled=True. Se o
# editor tinha desabilitado a task manualmente, restaurar esse estado aqui;
# senão o -Force reativa a task silenciosamente, sem log nem aviso.
$RestoredAsDisabled = $false
if ($Existing -and $Existing.State -eq "Disabled") {
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
    $RestoredAsDisabled = $true
}

if ($Existing) {
    Write-Output "Task '$TaskName' atualizada."
} else {
    Write-Output "Task '$TaskName' registrada."
}

# armed=false se o estado Disabled anterior foi restaurado acima — a
# atestação precisa refletir o estado FINAL da task, não a intenção
# genérica de "registrei/atualizei" (#7036).
Write-EdicaoScheduleAttestation -Armed (-not $RestoredAsDisabled)

Write-Output ""
Write-Output "Configuração:"
Write-Output "  Runner  : $RunnerPath (wrapper fino -> npx tsx scripts/overnight/run-scheduled-edicao.ts)"
Write-Output "  Repo    : $RepoRoot"
Write-Output "  Horário : dom-qui 16:00 (fuso local da máquina; ajustar se não for BRT)"
Write-Output "  Guard   : pula sem rodar se data/editions/{AAMMDD}/ já existir (edição já iniciada)"
Write-Output "  Duração : máx 3 h por execução"
Write-Output ""
Write-Output "Para verificar: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Output "Para remover  : .\scripts\overnight\setup-edicao-schedule.ps1 -Unregister"
