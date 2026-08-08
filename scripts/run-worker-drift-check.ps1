<#
.SYNOPSIS
    Wrapper do check de drift entre o codigo publicado de cada Worker e o
    master local (#4723) -- para o Task Scheduler.

.DESCRIPTION
    Roda `npx tsx scripts/worker-drift-check.ts` no repo root e loga a saida
    (UTF-8) em data/worker-drift-check/.drift-check.log. O script descobre os
    workers em workers/*/wrangler.toml, consulta o ultimo deploy publicado na
    Cloudflare, compara contra o ultimo commit local de cada worker, e manda
    um e-mail (Gmail) ao editor quando algum worker esta com deploy defasado
    (commit mais recente que o ultimo `wrangler deploy`, ou nunca deployado).

    Log resiliente + exit code honesto: molde compartilhado por
    scripts/lib/Invoke-DiariaScheduledWrapper.psm1 (#4756) -- escreve
    primeiro num arquivo temporario FORA de data/ (sem risco de lock do
    OneDrive) e so no final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Worker-Drift-Check"
    (setup-worker-drift-check-schedule.ps1).

.NOTES
    Issue: #4723. Modulo compartilhado: #4756.
#>
param(
    # Overrides usados por teste de regressao para simular sucesso/falha sem
    # depender de credenciais reais nem do junction data/.
    [string]$CheckScript,
    [string]$LogPath,
    [string]$TempLogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir "..")).Path

if (-not $CheckScript) { $CheckScript = Join-Path $RepoRoot "scripts\worker-drift-check.ts" }
if (-not $LogPath)     { $LogPath     = Join-Path $RepoRoot "data\worker-drift-check\.drift-check.log" }
if (-not $TempLogPath) { $TempLogPath = Join-Path $env:TEMP "diaria-worker-drift-check-$PID.log" }

Import-Module (Join-Path $ScriptDir "lib\Invoke-DiariaScheduledWrapper.psm1") -Force

$code = Invoke-DiariaScheduledWrapper `
    -RepoRoot $RepoRoot `
    -ScriptPath $CheckScript `
    -LogPath $LogPath `
    -TempLogPath $TempLogPath `
    -Label "worker drift check" `
    -ExitCodeKey "check"

exit $code
