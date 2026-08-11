<#
.SYNOPSIS
    Wrapper do smoke-test do robots.txt SERVIDO pelos Workers de curadoria
    (#4910) -- para o Task Scheduler.

.DESCRIPTION
    Roda `npx tsx scripts/robots-txt-drift-check.ts` no repo root e loga a
    saida (UTF-8) em data/robots-txt-drift-check/.drift-check.log. O script
    descobre os hosts publicos via discoverWorkerPublicHosts (sem lista
    hardcoded), bate GET https://{host}/robots.txt em cada um, e manda um
    e-mail (Gmail) ao editor quando o arquivo SERVIDO ainda carrega o bloco
    gerenciado da Cloudflare (`# BEGIN Cloudflare Managed content`) e/ou
    bloqueia um bot fora do esperado (CURADORIA_BLOCKED_BOTS) ou um bot de
    recuperacao/citacao (OAI-SearchBot, Claude-SearchBot, PerplexityBot,
    Googlebot, Bingbot).

    Log resiliente + exit code honesto: molde compartilhado por
    scripts/lib/Invoke-DiariaScheduledWrapper.psm1 (#4756) -- escreve
    primeiro num arquivo temporario FORA de data/ (sem risco de lock do
    OneDrive) e so no final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Robots-Txt-Drift-Check"
    (setup-robots-txt-drift-check-schedule.ps1).

.NOTES
    Issue: #4910. Modulo compartilhado: #4756. Molde: run-hub-drift-check.ps1 (#4750).
#>
param(
    # Overrides usados por teste de regressao para simular sucesso/falha sem
    # depender de rede real nem do junction data/.
    [string]$CheckScript,
    [string]$LogPath,
    [string]$TempLogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir "..")).Path

if (-not $CheckScript) { $CheckScript = Join-Path $RepoRoot "scripts\robots-txt-drift-check.ts" }
if (-not $LogPath)     { $LogPath     = Join-Path $RepoRoot "data\robots-txt-drift-check\.drift-check.log" }
if (-not $TempLogPath) { $TempLogPath = Join-Path $env:TEMP "diaria-robots-txt-drift-check-$PID.log" }

try {
    # Mesmo guard de run-hub-drift-check.ps1 (#4756 fleet review, achado
    # CRITICAL): sem este bloco, falha ao CARREGAR o modulo compartilhado e'
    # um erro NAO-terminante sob $ErrorActionPreference="Continue" -- o
    # Import-Module fica dentro do try; a CHAMADA da funcao fica FORA dele
    # de proposito (o guard interno do modulo pro caso "npx nao resolve"
    # depende de rodar sem try/catch envolvente).
    Import-Module (Join-Path $ScriptDir "lib\Invoke-DiariaScheduledWrapper.psm1") -Force -ErrorAction Stop
} catch {
    $failMsg = "ERRO FATAL: falha ao carregar Invoke-DiariaScheduledWrapper.psm1: $_"
    Write-Error $failMsg
    try {
        Add-Content -Path $LogPath -Encoding utf8 -Value "`n===== $(Get-Date -Format o) - robots.txt drift check =====`n$failMsg`n===== fim (check=1) =====" -ErrorAction Stop
    } catch {
        # melhor esforco -- falha de log aqui ja e' o pior caso possivel, mas nao pode mascarar o exit code
    }
    exit 1
}

$code = Invoke-DiariaScheduledWrapper `
    -RepoRoot $RepoRoot `
    -ScriptPath $CheckScript `
    -LogPath $LogPath `
    -TempLogPath $TempLogPath `
    -Label "robots.txt drift check" `
    -ExitCodeKey "check"

exit $code
