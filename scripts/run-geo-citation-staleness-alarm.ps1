<#
.SYNOPSIS
    Wrapper do alarme de staleness do monitor de citacao GEO (#4755) - para
    o Task Scheduler.

.DESCRIPTION
    Roda `npx tsx scripts/geo-citation-staleness-alarm.ts` no repo root e loga
    a saida (UTF-8) em data/geo-citations/.staleness-alarm.log. O script le o
    `ts` do registro mais recente de data/geo-citations/history.jsonl
    (escrito pela task semanal "Diaria-Geo-Citation-Monitor") e, se fizer
    mais de ~3 semanas sem registro novo, manda um e-mail (Gmail) ao editor.

    Log resiliente + exit code honesto: molde compartilhado por
    scripts/lib/Invoke-DiariaScheduledWrapper.psm1 (#4756) -- escreve
    primeiro num arquivo temporario FORA de data/ (sem risco de lock do
    OneDrive) e so no final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Geo-Citation-Staleness-Alarm"
    (setup-geo-citation-staleness-alarm-schedule.ps1).

.NOTES
    Issue: #4755. Modulo compartilhado: #4756.
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

if (-not $AlarmScript) { $AlarmScript = Join-Path $RepoRoot "scripts\geo-citation-staleness-alarm.ts" }
if (-not $LogPath)     { $LogPath     = Join-Path $RepoRoot "data\geo-citations\.staleness-alarm.log" }
if (-not $TempLogPath) { $TempLogPath = Join-Path $env:TEMP "diaria-geo-staleness-alarm-$PID.log" }

Import-Module (Join-Path $ScriptDir "lib\Invoke-DiariaScheduledWrapper.psm1") -Force

$code = Invoke-DiariaScheduledWrapper `
    -RepoRoot $RepoRoot `
    -ScriptPath $AlarmScript `
    -LogPath $LogPath `
    -TempLogPath $TempLogPath `
    -Label "geo citation staleness alarm" `
    -ExitCodeKey "alarm"

exit $code
