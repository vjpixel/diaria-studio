<#
.SYNOPSIS
    Wrapper do circuit breaker de campanha do canal Brevo Pending (#4476 item 9) - para o Task Scheduler.

.DESCRIPTION
    Roda `npx tsx scripts/check-brevo-diaria-guardrail.ts` no repo root e loga
    a saida (UTF-8) em data/brevo-diaria/.guardrail-check.log. Avalia bounce/
    spam/unsub agregados da conta Brevo `brevo_diaria` contra os mesmos
    limiares do ramp Clarice (ver scripts/lib/brevo-diaria-guardrail.ts) e
    PAUSA o backfill de sync-pending-to-brevo.ts (latch persistido em
    data/brevo-diaria/guardrail-state.json) se algum breaker de bounce/spam/
    unsub for cruzado -- abertura sozinha nunca pausa (issue #4476: cohort
    fria, esperado).

    Requer BREVO_DIARIA_API_KEY no .env local + o junction data/ (OneDrive).
    Alarme por e-mail (Gmail) e best-effort -- se falhar, o estado ja
    persistido (rollout pausado) NAO e revertido, so o e-mail nao sai.

    Log resiliente + exit code honesto: molde compartilhado por
    scripts/lib/Invoke-DiariaScheduledWrapper.psm1 (#4756) -- escreve
    primeiro num arquivo temporario FORA de data/ (sem risco de lock do
    OneDrive) e so no final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Brevo-Diaria-Guardrail"
    (setup-check-brevo-diaria-guardrail-schedule.ps1).

.NOTES
    Issue: #4476 item 9. Modulo compartilhado: #4756.
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

if (-not $CheckScript) { $CheckScript = Join-Path $RepoRoot "scripts\check-brevo-diaria-guardrail.ts" }
if (-not $LogPath)     { $LogPath     = Join-Path $RepoRoot "data\brevo-diaria\.guardrail-check.log" }
if (-not $TempLogPath) { $TempLogPath = Join-Path $env:TEMP "diaria-check-brevo-diaria-guardrail-$PID.log" }

Import-Module (Join-Path $ScriptDir "lib\Invoke-DiariaScheduledWrapper.psm1") -Force

$code = Invoke-DiariaScheduledWrapper `
    -RepoRoot $RepoRoot `
    -ScriptPath $CheckScript `
    -LogPath $LogPath `
    -TempLogPath $TempLogPath `
    -Label "check brevo diaria guardrail" `
    -ExitCodeKey "check"

exit $code
