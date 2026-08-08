<#
.SYNOPSIS
    Wrapper do alarme de erro do worker cursos (#4320) - para o Task Scheduler.

.DESCRIPTION
    Roda `npx tsx scripts/cursos-error-alarm.ts` no repo root e loga a saida
    (UTF-8) em data/cursos-subscribers/.error-alarm.log. Sem automacao
    disparando este script, o alarme fica implementado e testado mas nunca
    dispara sozinho -- mesma licao do "finding 1" do #4131 (guardrail
    Clarice), aplicada aqui de proposito antes de repetir o gap.

    Requer CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_WORKERS_TOKEN + CURSOS_KV_NAMESPACE_ID
    no .env local (#4382: leitura de contadores KV, nao mais
    CLOUDFLARE_API_TOKEN/Analytics API) + data/.credentials.json com o scope
    gmail.send (ver docstring de scripts/cursos-error-alarm.ts) + o junction
    data/ (OneDrive).

    Log resiliente + exit code honesto: molde compartilhado por
    scripts/lib/Invoke-DiariaScheduledWrapper.psm1 (#4756) -- escreve
    primeiro num arquivo temporario FORA de data/ (sem risco de lock do
    OneDrive) e so no final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Cursos-Error-Alarm"
    (setup-cursos-error-alarm-schedule.ps1).

.NOTES
    Issue: #4320. Modulo compartilhado: #4756.
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

if (-not $AlarmScript) { $AlarmScript = Join-Path $RepoRoot "scripts\cursos-error-alarm.ts" }
if (-not $LogPath)     { $LogPath     = Join-Path $RepoRoot "data\cursos-subscribers\.error-alarm.log" }
if (-not $TempLogPath) { $TempLogPath = Join-Path $env:TEMP "diaria-cursos-error-alarm-$PID.log" }

Import-Module (Join-Path $ScriptDir "lib\Invoke-DiariaScheduledWrapper.psm1") -Force

$code = Invoke-DiariaScheduledWrapper `
    -RepoRoot $RepoRoot `
    -ScriptPath $AlarmScript `
    -LogPath $LogPath `
    -TempLogPath $TempLogPath `
    -Label "cursos error alarm" `
    -ExitCodeKey "alarm"

exit $code
