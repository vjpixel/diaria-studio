<#
.SYNOPSIS
    Wrapper do alarme diario de diff pendente do sync apoio_nivel (#4485
    item 2) - para o Task Scheduler.

.DESCRIPTION
    Roda `npx tsx scripts/apoios-diff-alarm.ts` no repo root e loga a saida
    (UTF-8) em data/clarice-subscribers/.apoios-diff-alarm.log. O script
    computa o MESMO diff do dry-run de `sync-apoio-nivel-beehiiv.ts` e manda
    um e-mail (Gmail) ao editor quando ha diff pendente (adicoes/trocas/
    remocoes) -- NUNCA aplica --push, o gate humano de /diaria-apoios-sync
    continua sendo a unica forma de gravar de verdade.

    Log resiliente + exit code honesto: molde compartilhado por
    scripts/lib/Invoke-DiariaScheduledWrapper.psm1 (#4756) -- escreve
    primeiro num arquivo temporario FORA de data/ (sem risco de lock do
    OneDrive) e so no final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Apoios-Diff-Alarm"
    (setup-apoios-diff-alarm-schedule.ps1).

.NOTES
    Issue: #4485 item 2. Modulo compartilhado: #4756.
#>
param(
    # Overrides usados por teste de regressao para simular sucesso/falha sem
    # depender de credenciais reais nem do junction data/.
    [string]$AlarmScript,
    [string]$LogPath,
    [string]$TempLogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir "..")).Path

if (-not $AlarmScript) { $AlarmScript = Join-Path $RepoRoot "scripts\apoios-diff-alarm.ts" }
if (-not $LogPath)     { $LogPath     = Join-Path $RepoRoot "data\apoia-se\.diff-alarm.log" }
if (-not $TempLogPath) { $TempLogPath = Join-Path $env:TEMP "diaria-apoios-diff-alarm-$PID.log" }

Import-Module (Join-Path $ScriptDir "lib\Invoke-DiariaScheduledWrapper.psm1") -Force

$code = Invoke-DiariaScheduledWrapper `
    -RepoRoot $RepoRoot `
    -ScriptPath $AlarmScript `
    -LogPath $LogPath `
    -TempLogPath $TempLogPath `
    -Label "apoios diff alarm" `
    -ExitCodeKey "alarm"

exit $code
