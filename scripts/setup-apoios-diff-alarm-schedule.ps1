<#
.SYNOPSIS
    Registra (ou remove) a task "Diaria-Apoios-Diff-Alarm" no Task Scheduler
    -- alarme diario de diff pendente do sync apoio_nivel (#4485 item 2),
    09:45.

.DESCRIPTION
    Cria uma tarefa agendada que roda `run-apoios-diff-alarm.ps1` (que chama
    `apoios-diff-alarm.ts`) todo dia as 09:45 -- 30min depois da task
    "Diaria-Cursos-Kv-Sync" (09:15), pra nao concorrer pelo mesmo horario de
    rede/CPU local, e depois do sync diario do store Clarice (08:30).

    `apoios-diff-alarm.ts` roda o MESMO calculo de diff do dry-run de
    `sync-apoio-nivel-beehiiv.ts` -- NUNCA aplica --push. Se houver diff
    pendente (adicoes/trocas/remocoes de apoio_nivel), manda um e-mail de
    alarme ao editor via Gmail; o gate humano de /diaria-apoios-sync (Passo
    3) continua sendo a UNICA forma de gravar de verdade na Beehiiv. E
    idempotente por fingerprint do diff (nao reenvia o MESMO e-mail todo dia
    enquanto o editor nao agir -- ver scripts/lib/apoios-diff-alarm.ts).

    Fecha a opcao (a) recomendada no corpo da issue #4485 ("Task Scheduler,
    no padrao das outras tasks locais do repo -- roda o dry-run e so alarma
    quando houver diff, sem --push automatico").

    StartWhenAvailable: se o horario for perdido (maquina desligada), roda
    quando disponivel.

    Idempotente: re-executar substitui a task. Use -Unregister para remover.

    *** Rodar SO no clone permanente do repo (path derivado do diretorio deste
    script). Em worktree temporario o path muda e a task apontaria pra um
    diretorio deletado. ***

.PARAMETER Unregister
    Remove a task "Diaria-Apoios-Diff-Alarm".

.EXAMPLE
    # Registrar (ou atualizar):
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-apoios-diff-alarm-schedule.ps1

    # Remover:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-apoios-diff-alarm-schedule.ps1 -Unregister

.NOTES
    Issue: #4485 item 2.
    Requer: Windows + Task Scheduler + junction data/ + BEEHIIV_API_KEY (+
    opcional BEEHIIV_PUBLICATION_ID) + APOIA_SE_API_KEY/APOIA_SE_API_SECRET/
    APOIA_SE_CAMPAIGN + data/.credentials.json com o scope gmail.send.
    Sem Admin: a task roda no contexto do usuario (RunLevel Limited).

    *** NAO EXECUTADO nesta sessao (#4490/#4485) -- worktree isolado sem
    acesso ao Task Scheduler real da maquina do editor nem a credenciais
    Beehiiv/apoia.se/Gmail ao vivo (mesma disciplina de #4320/#4382). Rodar
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
$WrapperPs1 = Join-Path $RepoRoot "scripts\run-apoios-diff-alarm.ps1"

$TaskName = "Diaria-Apoios-Diff-Alarm"
$TaskDesc = "diar.ia.br: alarme diario de diff pendente do sync apoio_nivel (#4485) - 09:45, so dry-run + e-mail, nunca --push."

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

# Diario as 09:45 (once/dia; alarme idempotente por fingerprint -- rodar 2x
# no mesmo diff nunca reenvia o mesmo e-mail).
$Trigger = New-ScheduledTaskTrigger -Daily -At (Get-Date -Hour 9 -Minute 45 -Second 0)

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
Write-Output "  Horario : 09:45 diario (dry-run + e-mail se houver diff)"
Write-Output "  Log     : data\apoia-se\.diff-alarm.log"
Write-Output ""
Write-Output "Verificar: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Output "Remover  : .\scripts\setup-apoios-diff-alarm-schedule.ps1 -Unregister"
Write-Output ""
