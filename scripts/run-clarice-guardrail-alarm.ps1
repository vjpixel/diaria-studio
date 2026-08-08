<#
.SYNOPSIS
    Wrapper do alarme de guardrail furado do ramp Clarice (#4064) - para o Task Scheduler.

.DESCRIPTION
    Roda `npx tsx scripts/clarice-guardrail-alarm.ts` no repo root e loga a saida
    (UTF-8) em data/clarice-subscribers/.guardrail-alarm.log. Sem automacao
    disparando este script, o alarme do #4064 nunca dispara sozinho (achado
    "finding 1" do self-review do PR #4131) -- a logica (janela de 6h,
    idempotencia, e-mail) ja estava implementada e testada, so faltava o
    agendamento.

    Requer BREVO_CLARICE_API_KEY no .env local + data/.credentials.json com o
    scope gmail.send (ver docstring de scripts/clarice-guardrail-alarm.ts) + o
    junction data/ (OneDrive).

    Log resiliente + exit code honesto: molde compartilhado por
    scripts/lib/Invoke-DiariaScheduledWrapper.psm1 (#4756) -- escreve
    primeiro num arquivo temporario FORA de data/ (sem risco de lock do
    OneDrive) e so no final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Clarice-Guardrail-Alarm"
    (setup-clarice-guardrail-alarm-schedule.ps1).

.NOTES
    Issue: #4064 (alarme), #4131 finding 1 (agendamento), #4756 (modulo compartilhado).
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

if (-not $AlarmScript) { $AlarmScript = Join-Path $RepoRoot "scripts\clarice-guardrail-alarm.ts" }
if (-not $LogPath)     { $LogPath     = Join-Path $RepoRoot "data\clarice-subscribers\.guardrail-alarm.log" }
if (-not $TempLogPath) { $TempLogPath = Join-Path $env:TEMP "diaria-clarice-guardrail-alarm-$PID.log" }

Import-Module (Join-Path $ScriptDir "lib\Invoke-DiariaScheduledWrapper.psm1") -Force

$code = Invoke-DiariaScheduledWrapper `
    -RepoRoot $RepoRoot `
    -ScriptPath $AlarmScript `
    -LogPath $LogPath `
    -TempLogPath $TempLogPath `
    -Label "clarice guardrail alarm" `
    -ExitCodeKey "alarm"

exit $code
