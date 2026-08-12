<#
.SYNOPSIS
    Registra (ou remove) a task "Diaria-Robots-Txt-Drift-Check" no Task
    Scheduler -- smoke-test do robots.txt SERVIDO pelos Workers de
    curadoria (#4910), diaria as 10:15.

.DESCRIPTION
    Cria uma tarefa agendada que roda `run-robots-txt-drift-check.ps1` (que
    chama `robots-txt-drift-check.ts`) diariamente as 10:15. O script
    descobre os hosts publicos via discoverWorkerPublicHosts
    (workers/*/wrangler.toml, sem lista hardcoded), bate GET
    https://{host}/robots.txt em cada um, e alarma o editor por e-mail
    (Gmail) quando o arquivo SERVIDO ainda carrega o bloco gerenciado da
    Cloudflare (`# BEGIN Cloudflare Managed content`) e/ou bloqueia um bot
    fora do esperado (CURADORIA_BLOCKED_BOTS) ou um bot de
    recuperacao/citacao (OAI-SearchBot, Claude-SearchBot, PerplexityBot,
    Googlebot, Bingbot).

    Cadencia: diaria as 10:15 (#5113, decisao do editor 260812 -- mudou de
    "a cada 6h"), mesmo raciocinio de
    scripts/setup-hub-drift-check-schedule.ps1 (#4750) -- o conserto e acao
    manual de dashboard do editor de manha, detectar de madrugada nao
    adianta nada.

    Fecha o item 3 da issue #4910: nenhum guard existente ate aqui olhava o
    que esta de fato SERVIDO (todos test-time contra renderCuradoriaRobotsTxt)
    -- se a Cloudflare mudar o bloco gerenciado (ex: bloquear um bot de
    recuperacao que hoje nao bloqueia), ninguem percebe sem este alarme.

    E idempotente por fingerprint do conjunto de hosts com drift (nao
    reenvia o MESMO e-mail a cada execucao -- ver
    scripts/lib/robots-txt-drift-check.ts).

    StartWhenAvailable: se o horario for perdido (maquina desligada), roda
    quando disponivel.

    Idempotente: re-executar substitui a task. Use -Unregister para remover.

    *** Rodar SO no clone permanente do repo (path derivado do diretorio deste
    script). Em worktree temporario o path muda e a task apontaria pra um
    diretorio deletado. ***

.PARAMETER Unregister
    Remove a task "Diaria-Robots-Txt-Drift-Check".

.EXAMPLE
    # Registrar (ou atualizar):
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-robots-txt-drift-check-schedule.ps1

    # Remover:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-robots-txt-drift-check-schedule.ps1 -Unregister

.NOTES
    Issue: #4910. Molde: setup-hub-drift-check-schedule.ps1 (#4750).
    Requer: Windows + Task Scheduler + `data/.credentials.json` com o scope
    gmail.send (mesmo requisito dos outros alarmes locais deste repo -- so
    necessario pra ENVIAR o alarme quando ha drift; a checagem HTTP em si e
    um GET publico sem credencial nenhuma). NAO requer o junction data/ pra
    descobrir hosts (le workers/*/wrangler.toml, local ao checkout) -- so
    pra persistir o estado de idempotencia em
    data/robots-txt-drift-check/state.json.
    Sem Admin: a task roda no contexto do usuario (RunLevel Limited).

    *** NAO EXECUTADO nesta sessao (#4910) -- worktree isolado sem acesso ao
    Task Scheduler real da maquina do editor nem a data/.credentials.json/
    Gmail ao vivo, nem chamada de rede real contra host de producao, mesma
    disciplina do #4320/#4382/#4490/#4534/#4723/#4750. Rodar manualmente
    apos o merge. ***
#>
param(
    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$WrapperPs1 = Join-Path $RepoRoot "scripts\run-robots-txt-drift-check.ps1"

$TaskName = "Diaria-Robots-Txt-Drift-Check"
$TaskDesc = "diar.ia.br: smoke-test do robots.txt SERVIDO pelos Workers de curadoria (#4910) - diaria as 10:15, alarme por e-mail."

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

# Diaria as 10:15 (#5113, mudou de "a cada 6h" -- ver .DESCRIPTION).
$Trigger = New-ScheduledTaskTrigger -Daily -At (Get-Date -Hour 10 -Minute 15 -Second 0)

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

# #3775: Register-ScheduledTask -Force substitui a task INTEIRA -- qualquer
# propriedade nao especificada nesta chamada volta ao default, incluindo
# Enabled=True. Se o editor tinha desabilitado a task manualmente, restaura
# esse estado aqui; senao o -Force reativa a task silenciosamente.
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
Write-Output "  Cadencia: diaria as 10:15"
Write-Output "  Log     : data\robots-txt-drift-check\.drift-check.log"
Write-Output ""
Write-Output "Verificar: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Output "Remover  : .\scripts\setup-robots-txt-drift-check-schedule.ps1 -Unregister"
Write-Output ""
