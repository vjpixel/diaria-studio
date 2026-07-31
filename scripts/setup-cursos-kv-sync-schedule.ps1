<#
.SYNOPSIS
    Registra (ou remove) a task "Diaria-Cursos-Kv-Sync" no Task Scheduler --
    sync diario do KV CURSOS_SUBSCRIBERS (#4320), 09:15.

.DESCRIPTION
    Cria uma tarefa agendada que roda `run-cursos-kv-sync.ps1` (que chama
    `sync-cursos-subscribers-kv.ts`) todo dia as 09:15 -- 45min depois da
    task "Diaria-Clarice-Sync" (08:30), pra nao concorrer pelo mesmo horario
    de rede/CPU local.

    `sync-cursos-subscribers-kv.ts` (#4052) e o caminho PRIMARIO de
    verificacao do gate `?email=` do worker cursos -- rodou manualmente 1x e
    nunca foi agendado (follow-up reconhecido no PR #4088, fechado so agora
    pela #4320). Nao e urgente (o `by_email` da Beehiiv funciona como
    fallback ao vivo, confirmado na #4305) mas o caminho PRIMARIO ficava
    permanentemente desatualizado sem isto.

    StartWhenAvailable: se o horario for perdido (maquina desligada), roda
    quando disponivel -- o script faz full sync (paginacao completa de
    assinantes ativos), entao um dia perdido nao deixa rastro nenhum de gap.

    Idempotente: re-executar substitui a task. Use -Unregister para remover.

    *** Rodar SO no clone permanente do repo (path derivado do diretorio deste
    script). Em worktree temporario o path muda e a task apontaria pra um
    diretorio deletado. ***

.PARAMETER Unregister
    Remove a task "Diaria-Cursos-Kv-Sync".

.EXAMPLE
    # Registrar (ou atualizar):
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-cursos-kv-sync-schedule.ps1

    # Remover:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-cursos-kv-sync-schedule.ps1 -Unregister

.NOTES
    Issue: #4052 (script), #4088 (follow-up reconhecido), #4320 (agendamento).
    Requer: Windows + Task Scheduler + junction data/ + BEEHIIV_API_KEY +
    CLOUDFLARE_ACCOUNT_ID + CURSOS_KV_NAMESPACE_ID no .env.
    Sem Admin: a task roda no contexto do usuario (RunLevel Limited).

    *** NAO EXECUTADO nesta sessao (#4320) -- worktree isolado sem acesso ao
    Task Scheduler real da maquina do editor nem a credenciais Cloudflare/
    Beehiiv ao vivo. Rodar manualmente apos o merge (ver
    docs/cursos-worker-alarm-setup.md), que tambem cobre a 1a execucao MANUAL
    do sync em si (nao so o registro da task). ***
#>
param(
    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$WrapperPs1 = Join-Path $RepoRoot "scripts\run-cursos-kv-sync.ps1"

$TaskName = "Diaria-Cursos-Kv-Sync"
$TaskDesc = "Diar.ia: sync diario do KV CURSOS_SUBSCRIBERS (#4320) - 09:15, full sync."

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

# Diario as 09:15 (once/dia; o sync e um full sync idempotente -- cada
# execucao substitui as chaves KV pelos assinantes ativos correntes).
$Trigger = New-ScheduledTaskTrigger -Daily -At (Get-Date -Hour 9 -Minute 15 -Second 0)

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
Write-Output "  Horario : 09:15 diario (full sync)"
Write-Output "  Log     : data\cursos-subscribers\.kv-sync.log"
Write-Output ""
Write-Output "Verificar: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Output "Remover  : .\scripts\setup-cursos-kv-sync-schedule.ps1 -Unregister"
Write-Output ""
