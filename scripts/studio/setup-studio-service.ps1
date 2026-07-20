<#
.SYNOPSIS
    Registra (ou remove) a task "Diaria-Studio-Server" no Task Scheduler, que
    mantém o studio-server (`npm run studio`) sempre no ar.

.DESCRIPTION
    O studio-server (scripts/studio-ui/server.ts, http://127.0.0.1:4174) é o app
    de revisão/edição do pipeline fora do terminal (#3554). Rodado à mão via
    `npm run studio`, ele morre quando o terminal fecha. Esta task o sobe no
    logon do editor e o reinicia se cair — o mesmo padrão do túnel Cloudflare
    (Diaria-Studio-Tunnel, #3560) e do watchdog overnight (#2688).

    Com o túnel + esta task, o Studio fica acessível em https://studio.diar.ia.br
    (via Cloudflare Access) sem depender de nenhum terminal aberto.

    Idempotente: re-executar substitui a task existente (Register-ScheduledTask
    -Force). Use -Unregister para remover a task (não mata um `npm run studio`
    que você tenha aberto à mão num terminal).

.PARAMETER Port
    Porta local do studio-server (default: 4174, igual DEFAULT_PORT em
    scripts/studio-ui/server.ts e ao ingress do túnel). Repassada via --port.

.PARAMETER DryRun
    Mostra o que seria registrado sem mutar o Task Scheduler.

.PARAMETER Unregister
    Remove a task "Diaria-Studio-Server" do Task Scheduler.

.EXAMPLE
    # Registrar (ou atualizar) a task e deixar o Studio subindo no logon:
    powershell -NoProfile -ExecutionPolicy Bypass `
        -File scripts\studio\setup-studio-service.ps1

    # Iniciar agora sem esperar o próximo logon:
    Start-ScheduledTask -TaskName "Diaria-Studio-Server"

    # Parar / desligar o Studio agora (sem remover a task):
    Stop-ScheduledTask -TaskName "Diaria-Studio-Server"

    # Remover a task de vez:
    powershell -NoProfile -ExecutionPolicy Bypass `
        -File scripts\studio\setup-studio-service.ps1 -Unregister

.NOTES
    Issue: #3560 (epic Studio UI #3554)
    Requer: Windows com Task Scheduler, Node/npm no PATH.
#>
param(
    [int]$Port = 4174,
    [switch]$DryRun,
    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Paths (sem hardcode de usuário/máquina)
# ---------------------------------------------------------------------------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir "../..")).Path
$ServerTs  = Join-Path $RepoRoot "scripts\studio-ui\server.ts"

$TaskName = "Diaria-Studio-Server"
$TaskDesc = "Diar.ia Studio: mantém o studio-server (npm run studio) no ar pra revisão/edição fora do terminal (#3554) — roda no logon, reinicia se cair."

function Write-Step($msg) {
    Write-Output ""
    Write-Output "=== $msg ==="
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
    Write-Output ""
    Write-Output "Isso NÃO mata um 'npm run studio' aberto à mão num terminal."
    exit 0
}

# ---------------------------------------------------------------------------
# Guard: garantir que o server existe no path derivado
# ---------------------------------------------------------------------------
if (-not (Test-Path $ServerTs)) {
    Write-Error "studio-server não encontrado: $ServerTs"
    exit 1
}

# ---------------------------------------------------------------------------
# Action: `npx tsx scripts\studio-ui\server.ts --port <port>` no repo root
# (mesmo idioma do watchdog #2688 — npx resolvido via PATH do Task Scheduler)
# ---------------------------------------------------------------------------
$Action = New-ScheduledTaskAction `
    -Execute          "npx" `
    -Argument         "tsx `"$ServerTs`" --port $Port" `
    -WorkingDirectory $RepoRoot

$Trigger = New-ScheduledTaskTrigger -AtLogOn

# Processo de longa duração: reinicia se cair, sem limite de tempo de execução.
$Settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances    IgnoreNew `
    -StartWhenAvailable `
    -RestartCount         999 `
    -RestartInterval      (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit   (New-TimeSpan -Hours 0) # 0 = sem limite

if ($DryRun) {
    Write-Step "[-DryRun] Plano (nada é registrado)"
    Write-Output "  Task    : $TaskName"
    Write-Output "  Execute : npx tsx `"$ServerTs`" --port $Port"
    Write-Output "  WorkDir : $RepoRoot"
    Write-Output "  Trigger : AtLogOn (reinicia se cair, sem limite de tempo)"
    exit 0
}

# ---------------------------------------------------------------------------
# Registrar (idempotente). Register-ScheduledTask -Force cria OU sobrescreve e
# aceita -Description. NÃO usar Set-ScheduledTask no branch de update: ele não
# tem parâmetro -Description (falhava com "NamedParameterNotFound" — ver #3560,
# test/scheduled-task-registration.test.ts).
# ---------------------------------------------------------------------------
Write-Step "Registrando task '$TaskName' no Task Scheduler"
$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName    $TaskName `
    -Action      $Action `
    -Trigger     $Trigger `
    -Settings    $Settings `
    -Description $TaskDesc `
    -RunLevel    Limited `
    -Force | Out-Null

# #3780 (mesmo bug do #3775): Register-ScheduledTask -Force substitui a task
# INTEIRA (ao contrário de Set-ScheduledTask, que só atualiza os campos
# passados) — qualquer propriedade não especificada nesta chamada volta ao
# default, incluindo Enabled=True. Se o editor tinha desabilitado a task
# manualmente, restaurar esse estado aqui; senão o -Force reativa a task
# silenciosamente, sem log nem aviso.
if ($Existing -and $Existing.State -eq "Disabled") {
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
}

if ($Existing) {
    Write-Output "Task '$TaskName' atualizada."
} else {
    Write-Output "Task '$TaskName' registrada — vai iniciar automaticamente no próximo logon."
}

Write-Output ""
Write-Output "=== Resumo ==="
Write-Output "  Studio local : http://127.0.0.1:$Port"
Write-Output "  Task         : $TaskName (Task Scheduler, roda no logon)"
Write-Output "  Server        : $ServerTs"
Write-Output ""
Write-Output "Iniciar agora sem esperar o logon:"
Write-Output "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Output "Parar (desligar o Studio) sem remover a task:"
Write-Output "  Stop-ScheduledTask -TaskName '$TaskName'"
