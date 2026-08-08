<#
.SYNOPSIS
    Wrapper do alarme de falha sustentada do catch-up de opens da Clarice
    (#4740, #4722 item 4) - para o Task Scheduler.

.DESCRIPTION
    Roda `npx tsx scripts/clarice-opens-catchup-alarm.ts` no repo root e loga
    a saida (UTF-8) em data/clarice-subscribers/.opens-catchup-alarm.log. O
    script le `data/clarice-subscribers/last-opens-catchup-status.json`
    (escrito por `extract-opens-catchup-status.ts`, chamado pela task diaria
    `Diaria-Clarice-Sync` logo apos cada sync incremental) e avanca um streak
    de falhas consecutivas do catch-up de opens (#4688) -- ao atingir o
    threshold, manda um e-mail (Gmail) ao editor.

    Log resiliente + exit code honesto: molde compartilhado por
    scripts/lib/Invoke-DiariaScheduledWrapper.psm1 (#4756) -- escreve
    primeiro num arquivo temporario FORA de data/ (sem risco de lock do
    OneDrive) e so no final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Clarice-Opens-Catchup-Alarm"
    (setup-clarice-opens-catchup-alarm-schedule.ps1).

.NOTES
    Issue: #4740 (#4722 item 4). Modulo compartilhado: #4756.
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

if (-not $AlarmScript) { $AlarmScript = Join-Path $RepoRoot "scripts\clarice-opens-catchup-alarm.ts" }
if (-not $LogPath)     { $LogPath     = Join-Path $RepoRoot "data\clarice-subscribers\.opens-catchup-alarm.log" }
if (-not $TempLogPath) { $TempLogPath = Join-Path $env:TEMP "diaria-opens-catchup-alarm-$PID.log" }

Import-Module (Join-Path $ScriptDir "lib\Invoke-DiariaScheduledWrapper.psm1") -Force

$code = Invoke-DiariaScheduledWrapper `
    -RepoRoot $RepoRoot `
    -ScriptPath $AlarmScript `
    -LogPath $LogPath `
    -TempLogPath $TempLogPath `
    -Label "clarice opens catchup alarm" `
    -ExitCodeKey "alarm"

exit $code
