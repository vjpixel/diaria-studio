<#
.SYNOPSIS
    Wrapper semanal do loop de SEO (para o Task Scheduler).

.DESCRIPTION
    Roda, em sequencia, no repo root:
      1. seo-index-check.ts --only-posts  -> cobertura de indexacao (KPI primario
         enquanto o Search Analytics nao tem historico).
      2. seo-pull.ts --days 28            -> CTR/posicao + oportunidades.
    Ambos gravam em data/seo/ com a data no nome, entao a serie temporal se
    acumula sozinha. Registrado pela task "Diaria-SEO-Weekly"
    (setup-seo-schedule.ps1).

    Log: mesmo padrao do #4047 — a run inteira e escrita num arquivo temporario
    FORA de data/ (que e junction pro OneDrive e trava intermitentemente) e so
    no fim e anexada ao log final, com retry. Falha de log reprova a run.

.NOTES
    Issue: #4105 (loop de SEO: #1896; seo-pull: #1989).
    Requer: junction data/ + data/.credentials.json com scope webmasters.readonly.
#>
param(
    # Overrides usados pelo teste de regressao (sem credencial nem junction).
    [string]$IndexCheckScript,
    [string]$PullScript,
    [string]$LogPath,
    [string]$TempLogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir "..")).Path

if (-not $IndexCheckScript) { $IndexCheckScript = Join-Path $RepoRoot "scripts\seo-index-check.ts" }
if (-not $PullScript)       { $PullScript       = Join-Path $RepoRoot "scripts\seo-pull.ts" }
if (-not $LogPath)          { $LogPath          = Join-Path $RepoRoot "data\seo\.seo-weekly.log" }
if (-not $TempLogPath)      { $TempLogPath      = Join-Path $env:TEMP "diaria-seo-weekly-$PID.log" }

Set-Location $RepoRoot

function Write-TempLogLine {
    param([string]$Value)
    Add-Content -Path $TempLogPath -Encoding utf8 -Value $Value
}

Write-TempLogLine ""
Write-TempLogLine "===== $(Get-Date -Format o) - seo weekly ====="

# 1. Cobertura de indexacao (--only-posts: as institucionais poluem a metrica).
Write-TempLogLine "----- seo-index-check --only-posts -----"
& npx tsx "$IndexCheckScript" --only-posts --limit 250 2>&1 | ForEach-Object { $_.ToString() } | Out-File -FilePath $TempLogPath -Append -Encoding utf8
$indexCode = $LASTEXITCODE

# 2. Search Analytics (CTR/posicao). Sem historico ainda retorna 0 linhas — ok,
#    nao e erro; o exit code so reprova em falha de API.
Write-TempLogLine "----- seo-pull --days 28 -----"
& npx tsx "$PullScript" --days 28 2>&1 | ForEach-Object { $_.ToString() } | Out-File -FilePath $TempLogPath -Append -Encoding utf8
$pullCode = $LASTEXITCODE

Write-TempLogLine "===== fim (index=$indexCode pull=$pullCode) ====="

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

$code = if ($indexCode -ne 0) { $indexCode } elseif ($pullCode -ne 0) { $pullCode } elseif (-not $logAppendOk) { 1 } else { 0 }
exit $code
