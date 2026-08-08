<#
.SYNOPSIS
    Wrapper do sync automatico do spamRate do Google Postmaster Tools (#4154)
    - para o Task Scheduler.

.DESCRIPTION
    Roda `npx tsx scripts/postmaster-spam-sync.ts` no repo root e loga a saida
    (UTF-8) em data/clarice-subscribers/.postmaster-spam-sync.log. Sem essa
    automacao, o breaker de spam da Rampa depende de leitura MANUAL do painel
    do Postmaster (~1min antes de cada envio, facil de esquecer -> sinal fica
    indeterminate e trava o escalonamento de volume).

    Requer data/.credentials.json com o scope postmaster.traffic.readonly
    (v2, #4704/#4707/#4711 -- postmaster-spam-sync.ts migrou de
    postmaster.readonly/v1 pra domainStats:query/v2; ver scripts/oauth-setup.ts)
    + CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_WORKERS_TOKEN no .env local + o
    junction data/ (OneDrive).

    Log resiliente + exit code honesto: molde compartilhado por
    scripts/lib/Invoke-DiariaScheduledWrapper.psm1 (#4756) -- escreve
    primeiro num arquivo temporario FORA de data/ (sem risco de lock do
    OneDrive) e so no final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Postmaster-Spam-Sync"
    (setup-postmaster-spam-sync-schedule.ps1).

.NOTES
    Issue: #4154. Modulo compartilhado: #4756.
#>
param(
    # Overrides usados por teste de regressao para simular sucesso/falha sem
    # depender de credenciais reais nem do junction data/.
    [string]$SyncScript,
    [string]$LogPath,
    [string]$TempLogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir "..")).Path

if (-not $SyncScript)  { $SyncScript  = Join-Path $RepoRoot "scripts\postmaster-spam-sync.ts" }
if (-not $LogPath)     { $LogPath     = Join-Path $RepoRoot "data\clarice-subscribers\.postmaster-spam-sync.log" }
if (-not $TempLogPath) { $TempLogPath = Join-Path $env:TEMP "diaria-postmaster-spam-sync-$PID.log" }

Import-Module (Join-Path $ScriptDir "lib\Invoke-DiariaScheduledWrapper.psm1") -Force

$code = Invoke-DiariaScheduledWrapper `
    -RepoRoot $RepoRoot `
    -ScriptPath $SyncScript `
    -LogPath $LogPath `
    -TempLogPath $TempLogPath `
    -Label "postmaster spam sync" `
    -ExitCodeKey "sync"

exit $code
