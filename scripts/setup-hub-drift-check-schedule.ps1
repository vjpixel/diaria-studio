<#
.SYNOPSIS
    Registra (ou remove) a task "Diaria-Hub-Drift-Check" no Task Scheduler --
    smoke-test de drift entre HUB_META e o Worker `arquivo` publicado (#4750),
    diaria as 10:00.

.DESCRIPTION
    Cria uma tarefa agendada que roda `run-hub-drift-check.ps1` (que chama
    `hub-drift-check.ts`) diariamente as 10:00. O script le HUB_META
    (workers/arquivo/src/hubs/meta.ts, sem lista hardcoded), bate
    GET {DIARIA_ARQUIVO_URL}/temas/{slug} em cada hub, e alarma o editor por
    e-mail (Gmail) quando algum hub nao responde 200 (404, 5xx) ou a chamada
    de rede falha -- sinal de que um link interno da navegacao "Por tema" do
    arquivo aponta pra um hub fora do ar.

    Cadencia: diaria as 10:00 (#5113, decisao do editor 260812 -- mudou de
    "a cada 6h"). O conserto (deploy do Worker/config do hub) e acao manual
    do editor de manha -- latencia de deteccao abaixo da latencia de
    resposta e desperdicada; ver o comentario de
    Diaria-Beehiiv-Home-Meta-Check em scripts/lib/scheduled-tasks.ts pro
    raciocinio completo (os drift-checks de superficie publica se citavam em
    circulo desde a origem do 6h, #4723/#4750/#4910). E idempotente por
    fingerprint do conjunto de hubs quebrados (nao reenvia o MESMO e-mail a
    cada execucao -- ver scripts/lib/hub-drift-check.ts).

    Fecha o follow-up registrado na issue #4750 (achado do fleet review da PR
    #4749): test/hub-registry-completeness.test.ts cruza HUB_LOADERS/
    HUB_REGISTRY/HUB_META entre si, mas e inteiramente test-time -- nada
    checava o que esta de fato servido pelo Worker publicado.

    StartWhenAvailable: se o horario for perdido (maquina desligada), roda
    quando disponivel.

    Idempotente: re-executar substitui a task. Use -Unregister para remover.

    *** Rodar SO no clone permanente do repo (path derivado do diretorio deste
    script). Em worktree temporario o path muda e a task apontaria pra um
    diretorio deletado. ***

.PARAMETER Unregister
    Remove a task "Diaria-Hub-Drift-Check".

.EXAMPLE
    # Registrar (ou atualizar):
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-hub-drift-check-schedule.ps1

    # Remover:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-hub-drift-check-schedule.ps1 -Unregister

.NOTES
    Issue: #4750.
    Requer: Windows + Task Scheduler + `data/.credentials.json` com o scope
    gmail.send (mesmo requisito dos outros alarmes locais deste repo -- so
    necessario pra ENVIAR o alarme quando ha drift; a checagem HTTP em si e
    um GET publico sem credencial nenhuma). NAO requer o junction data/ pra
    ler HUB_META (modulo do repo, local ao checkout) -- so pra persistir o
    estado de idempotencia em data/hub-drift-check/state.json.
    Sem Admin: a task roda no contexto do usuario (RunLevel Limited).

    *** NAO EXECUTADO nesta sessao (#4750) -- worktree isolado sem acesso ao
    Task Scheduler real da maquina do editor nem a data/.credentials.json/
    Gmail ao vivo, mesma disciplina do #4320/#4382/#4490/#4534/#4723/#4740.
    Rodar manualmente apos o merge, ver docs/hub-drift-check-setup.md. ***
#>
param(
    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$WrapperPs1 = Join-Path $RepoRoot "scripts\run-hub-drift-check.ps1"

$TaskName = "Diaria-Hub-Drift-Check"
$TaskDesc = "diar.ia.br: smoke-test de drift entre HUB_META e o Worker arquivo publicado (#4750) - diaria as 10:00, alarme por e-mail."

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

# Diaria as 10:00 (#5113, mudou de "a cada 6h" -- ver .DESCRIPTION).
$Trigger = New-ScheduledTaskTrigger -Daily -At (Get-Date -Hour 10 -Minute 0 -Second 0)

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
Write-Output "  Cadencia: diaria as 10:00"
Write-Output "  Log     : data\hub-drift-check\.drift-check.log"
Write-Output ""
Write-Output "Verificar: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Output "Remover  : .\scripts\setup-hub-drift-check-schedule.ps1 -Unregister"
Write-Output ""
