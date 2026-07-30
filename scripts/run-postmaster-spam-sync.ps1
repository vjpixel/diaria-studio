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

    Requer data/.credentials.json com o scope postmaster.readonly (ver
    scripts/oauth-setup.ts) + CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_WORKERS_TOKEN
    no .env local + o junction data/ (OneDrive).

    Mesmo padrao de log resiliente do #4047/#4064 (run-clarice-*.ps1): escreve
    primeiro num arquivo temporario FORA de data/ (sem risco de lock do
    OneDrive) e so no final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Postmaster-Spam-Sync"
    (setup-postmaster-spam-sync-schedule.ps1).

.NOTES
    Issue: #4154.
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

Set-Location $RepoRoot

function Write-TempLogLine {
    param([string]$Value)
    Add-Content -Path $TempLogPath -Encoding utf8 -Value $Value
}

Write-TempLogLine ""
Write-TempLogLine "===== $(Get-Date -Format o) - postmaster spam sync ====="

& npx tsx "$SyncScript" 2>&1 | ForEach-Object { $_.ToString() } | Out-File -FilePath $TempLogPath -Append -Encoding utf8
$syncCode = $LASTEXITCODE

Write-TempLogLine "===== fim (sync=$syncCode) ====="

# Anexa o log temporario (fora de data/, sem risco de lock OneDrive) ao log
# final dentro de data/, com retry curto -- o lock do OneDrive costuma liberar
# em milissegundos (mesmo padrao do #4047/#4064).
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
# tenha rodado bem -- sem isso, o Task Scheduler poderia achar que esta tudo
# ok sem nenhum log da run ter sido persistido.
$code = if ($syncCode -ne 0) { $syncCode } elseif (-not $logAppendOk) { 1 } else { 0 }
exit $code
