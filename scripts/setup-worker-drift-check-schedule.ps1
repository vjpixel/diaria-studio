<#
.SYNOPSIS
    Registra (ou remove) a task "Diaria-Worker-Drift-Check" no Task
    Scheduler -- check de drift entre o codigo publicado de cada Worker e o
    master local (#4723), a cada 6h.

.DESCRIPTION
    Cria uma tarefa agendada que roda `run-worker-drift-check.ps1` (que
    chama `worker-drift-check.ts`) a cada 6h. O script descobre os workers
    em workers/*/wrangler.toml (sem lista hardcoded), consulta o ultimo
    deploy publicado de cada um na Cloudflare, compara contra o ultimo
    commit local que tocou workers/{nome}/**, e alarma o editor por e-mail
    (Gmail) quando algum worker esta com deploy defasado -- commit mais
    recente que o ultimo `wrangler deploy`, ou nunca deployado apesar de ja
    ter codigo commitado.

    Cadencia: 6h e proporcional ao problema que motivou a issue -- um drift
    de 4 dias nao precisa de deteccao em minutos, mas tambem nao deveria
    levar dias pra ser notado. E idempotente por fingerprint do conjunto de
    workers com drift (nao reenvia o MESMO e-mail a cada execucao enquanto o
    editor nao rodar `wrangler deploy` -- ver scripts/lib/worker-drift-check.ts).

    Fecha a Opcao 1 recomendada no corpo da issue #4723 ("script que compara
    o timestamp do ultimo deploy publicado contra o timestamp do ultimo
    commit que tocou workers/{nome}/** -- se o commit for mais recente,
    alarma").

    StartWhenAvailable: se o horario for perdido (maquina desligada), roda
    quando disponivel.

    Idempotente: re-executar substitui a task. Use -Unregister para remover.

    *** Rodar SO no clone permanente do repo (path derivado do diretorio deste
    script). Em worktree temporario o path muda e a task apontaria pra um
    diretorio deletado. ***

.PARAMETER Unregister
    Remove a task "Diaria-Worker-Drift-Check".

.EXAMPLE
    # Registrar (ou atualizar):
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-worker-drift-check-schedule.ps1

    # Remover:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-worker-drift-check-schedule.ps1 -Unregister

.NOTES
    Issue: #4723.
    Requer: Windows + Task Scheduler + CLOUDFLARE_ACCOUNT_ID +
    CLOUDFLARE_WORKERS_TOKEN (token com permissao de LEITURA em Workers
    Scripts) + data/.credentials.json com o scope gmail.send. NAO requer o
    junction data/ pra ler estado do repo (workers/*/wrangler.toml e commits
    git sao locais ao checkout) -- so precisa dele pra persistir o estado de
    idempotencia em data/worker-drift-check/state.json.
    Sem Admin: a task roda no contexto do usuario (RunLevel Limited).

    *** NAO EXECUTADO nesta sessao (#4723) -- worktree isolado sem acesso ao
    Task Scheduler real da maquina do editor nem a credenciais Cloudflare/
    Gmail ao vivo, mesma disciplina do #4320/#4382/#4490/#4534. Rodar
    manualmente apos o merge, ver docs/worker-drift-check-setup.md. ***
#>
param(
    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$WrapperPs1 = Join-Path $RepoRoot "scripts\run-worker-drift-check.ps1"

$TaskName = "Diaria-Worker-Drift-Check"
$TaskDesc = "diar.ia.br: check de drift entre codigo publicado e master de cada Worker (#4723) - a cada 6h, alarme por e-mail."

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

# A cada 6h, comecando agora, indefinidamente. -Once e SWITCH (nao aceita
# valor posicional) -- o instante inicial vai em -At (#4155, mesma armadilha
# documentada em setup-cursos-error-alarm-schedule.ps1/setup-clarice-guardrail-alarm-schedule.ps1).
# -RepetitionDuration OMITIDO de proposito: sem ele a repeticao e indefinida
# (passar [TimeSpan]::MaxValue quebra o registro, ver #4155).
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 6)

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
Write-Output "  Cadencia: a cada 6h"
Write-Output "  Log     : data\worker-drift-check\.drift-check.log"
Write-Output ""
Write-Output "Verificar: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Output "Remover  : .\scripts\setup-worker-drift-check-schedule.ps1 -Unregister"
Write-Output ""
