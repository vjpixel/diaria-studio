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

    Mesmo padrao de log resiliente do #4047: escreve primeiro num arquivo
    temporario FORA de data/ (sem risco de lock do OneDrive) e so no final
    anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Cursos-Kv-Sync" (setup-cursos-kv-sync-schedule.ps1).

.NOTES
    Issue: #4052 (script), #4320 (agendamento).
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

Set-Location $RepoRoot

function Write-TempLogLine {
    param([string]$Value)
    Add-Content -Path $TempLogPath -Encoding utf8 -Value $Value
}

Write-TempLogLine ""
Write-TempLogLine "===== $(Get-Date -Format o) - cursos kv sync ====="

# Pre-inicializa $LASTEXITCODE=$null ANTES da chamada nativa (#4343): mesmo
# guard documentado em run-clarice-sync-daily.ps1/run-cursos-error-alarm.ps1
# -- sob Set-StrictMode, `npx` falhando a resolver deixa $LASTEXITCODE
# genuinamente indefinido (nao $null), e ler essa variavel lanca. Pre-setar
# aqui garante deteccao correta do caso "npx nao rodou".
$LASTEXITCODE = $null
& npx tsx "$SyncScript" 2>&1 | ForEach-Object { $_.ToString() } | Out-File -FilePath $TempLogPath -Append -Encoding utf8
$syncCode = $LASTEXITCODE

if ($null -eq $syncCode) {
    Write-TempLogLine "ERRO: npx nao executou (comando nao encontrado ou falha antes do processo iniciar)."
    $syncCode = 1
}

Write-TempLogLine "===== fim (sync=$syncCode) ====="

# Anexa o log temporario (fora de data/, sem risco de lock OneDrive) ao log
# final dentro de data/, com retry curto -- o lock do OneDrive costuma liberar
# em milissegundos (#4047).
$logAppendOk = $false
$lastLogError = $null
for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
        $logDir = Split-Path -Parent $LogPath
        if (-not (Test-Path -LiteralPath $logDir)) {
            New-Item -ItemType Directory -Path $logDir -Force -ErrorAction Stop | Out-Null
        }
        $tempContent = Get-Content -LiteralPath $TempLogPath -Raw -ErrorAction Stop
        Add-Content -LiteralPath $LogPath -Encoding utf8 -Value $tempContent -ErrorAction Stop
        $logAppendOk = $true
        break
    } catch {
        $lastLogError = $_
        if ($attempt -lt 3) {
            Start-Sleep -Milliseconds (300 * $attempt)
        }
    }
}

if ($logAppendOk) {
    Remove-Item -LiteralPath $TempLogPath -ErrorAction SilentlyContinue
} else {
    Write-Host "AVISO: falha ao gravar o log final em $LogPath apos 3 tentativas ($lastLogError). Log temporario preservado em $TempLogPath."
}

# Exit code honesto: falha de log tambem reprova a run, mesmo que o sync
# tenha ido bem -- sem isso, o Task Scheduler poderia achar que esta tudo ok
# sem nenhum log da run ter sido persistido.
$code = if ($syncCode -ne 0) { $syncCode } elseif (-not $logAppendOk) { 1 } else { 0 }
exit $code
