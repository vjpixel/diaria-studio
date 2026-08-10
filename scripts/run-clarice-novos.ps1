<#
.SYNOPSIS
    Wrapper do envio diario aos cadastros novos da Clarice (#4941) - para o
    Task Scheduler.

.DESCRIPTION
    Roda `npx tsx scripts/clarice-novos-run.ts` no repo root e loga a saida
    (UTF-8) em data/clarice-subscribers/.novos-run.log. O script orquestra
    deterministicamente os Passos 0-7 de /diaria-clarice-novos (#4347):
    delta Stripe -> MV -> grupo 'novos' -> campanha Brevo -> disparo
    imediato -- sem gate humano, com o toggle
    data/clarice-novos-enabled.json (default enabled:false) como kill
    switch (#4941 E3).

    Log resiliente + exit code honesto: molde compartilhado por
    scripts/lib/Invoke-DiariaScheduledWrapper.psm1 (#4756) -- escreve
    primeiro num arquivo temporario FORA de data/ (sem risco de lock do
    OneDrive) e so no final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Clarice-Novos"
    (setup-clarice-novos-schedule.ps1).

.NOTES
    Issue: #4347, #4941. Modulo compartilhado: #4756.
#>
param(
    # Overrides usados por teste de regressao para simular sucesso/falha sem
    # depender de credenciais reais nem do junction data/.
    [string]$RunScript,
    [string]$LogPath,
    [string]$TempLogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir "..")).Path

if (-not $RunScript)   { $RunScript   = Join-Path $RepoRoot "scripts\clarice-novos-run.ts" }
if (-not $LogPath)     { $LogPath     = Join-Path $RepoRoot "data\clarice-subscribers\.novos-run.log" }
if (-not $TempLogPath) { $TempLogPath = Join-Path $env:TEMP "diaria-clarice-novos-run-$PID.log" }

Import-Module (Join-Path $ScriptDir "lib\Invoke-DiariaScheduledWrapper.psm1") -Force

$code = Invoke-DiariaScheduledWrapper `
    -RepoRoot $RepoRoot `
    -ScriptPath $RunScript `
    -LogPath $LogPath `
    -TempLogPath $TempLogPath `
    -Label "clarice novos run" `
    -ExitCodeKey "run"

exit $code
