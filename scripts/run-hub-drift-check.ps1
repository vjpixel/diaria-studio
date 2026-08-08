<#
.SYNOPSIS
    Wrapper do smoke-test de drift entre HUB_META e o Worker `arquivo`
    publicado (#4750) -- para o Task Scheduler.

.DESCRIPTION
    Roda `npx tsx scripts/hub-drift-check.ts` no repo root e loga a saida
    (UTF-8) em data/hub-drift-check/.drift-check.log. O script le HUB_META
    (workers/arquivo/src/hubs/meta.ts), bate GET {DIARIA_ARQUIVO_URL}/temas/{slug}
    em cada hub, e manda um e-mail (Gmail) ao editor quando algum hub nao
    responde 200 (404, 5xx) ou a chamada de rede falha.

    Log resiliente + exit code honesto: molde compartilhado por
    scripts/lib/Invoke-DiariaScheduledWrapper.psm1 (#4756) -- escreve
    primeiro num arquivo temporario FORA de data/ (sem risco de lock do
    OneDrive) e so no final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Hub-Drift-Check"
    (setup-hub-drift-check-schedule.ps1).

.NOTES
    Issue: #4750. Modulo compartilhado: #4756.
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

if (-not $CheckScript) { $CheckScript = Join-Path $RepoRoot "scripts\hub-drift-check.ts" }
if (-not $LogPath)     { $LogPath     = Join-Path $RepoRoot "data\hub-drift-check\.drift-check.log" }
if (-not $TempLogPath) { $TempLogPath = Join-Path $env:TEMP "diaria-hub-drift-check-$PID.log" }

Import-Module (Join-Path $ScriptDir "lib\Invoke-DiariaScheduledWrapper.psm1") -Force

$code = Invoke-DiariaScheduledWrapper `
    -RepoRoot $RepoRoot `
    -ScriptPath $CheckScript `
    -LogPath $LogPath `
    -TempLogPath $TempLogPath `
    -Label "hub drift check" `
    -ExitCodeKey "check"

exit $code
