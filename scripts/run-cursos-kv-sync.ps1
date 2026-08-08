<#
.SYNOPSIS
    Wrapper do sync diario do KV CURSOS_SUBSCRIBERS (#4320) - para o Task Scheduler.

.DESCRIPTION
    Roda `npx tsx scripts/sync-cursos-subscribers-kv.ts` no repo root e loga a
    saida (UTF-8) em data/cursos-subscribers/.kv-sync.log. O script popula
    `subscriber:{sha256(email)}` -> "1" pra cada assinante ATIVO da diar.ia.br --
    fonte PRIMARIA de verificacao do gate `?email=` (workers/cursos/src/gate.ts).

    O script `sync-cursos-subscribers-kv.ts` (#4052) ja existia mas rodou
    manualmente 1x e nunca foi agendado -- follow-up reconhecido no PR #4088
    e nunca feito ate esta issue (#4320). Este wrapper fecha esse gap
    seguindo o MESMO padrao de `run-clarice-sync-daily.ps1` (#2932/#4047).

    Requer BEEHIIV_API_KEY (+ opcional BEEHIIV_PUBLICATION_ID) +
    CLOUDFLARE_ACCOUNT_ID + CURSOS_KV_NAMESPACE_ID no .env local + o junction
    data/ (OneDrive) -- so pro log, o script em si nao le/escreve em data/
    alem disso.

    Log resiliente + exit code honesto: molde compartilhado por
    scripts/lib/Invoke-DiariaScheduledWrapper.psm1 (#4756) -- escreve
    primeiro num arquivo temporario FORA de data/ (sem risco de lock do
    OneDrive) e so no final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Cursos-Kv-Sync" (setup-cursos-kv-sync-schedule.ps1).

.NOTES
    Issue: #4052 (script), #4320 (agendamento), #4756 (extracao do modulo compartilhado).
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

if (-not $SyncScript)  { $SyncScript  = Join-Path $RepoRoot "scripts\sync-cursos-subscribers-kv.ts" }
if (-not $LogPath)     { $LogPath     = Join-Path $RepoRoot "data\cursos-subscribers\.kv-sync.log" }
if (-not $TempLogPath) { $TempLogPath = Join-Path $env:TEMP "diaria-cursos-kv-sync-$PID.log" }

Import-Module (Join-Path $ScriptDir "lib\Invoke-DiariaScheduledWrapper.psm1") -Force

$code = Invoke-DiariaScheduledWrapper `
    -RepoRoot $RepoRoot `
    -ScriptPath $SyncScript `
    -LogPath $LogPath `
    -TempLogPath $TempLogPath `
    -Label "cursos kv sync" `
    -ExitCodeKey "sync"

exit $code
