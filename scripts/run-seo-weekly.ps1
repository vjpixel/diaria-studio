<#
.SYNOPSIS
    Wrapper semanal do loop de SEO (para o Task Scheduler).

.DESCRIPTION
    Roda, em sequencia, no repo root:
      1. seo-index-check.ts --only-posts  -> cobertura de indexacao (KPI primario
         enquanto o Search Analytics nao tem historico).
      2. seo-index-check.ts --sitemap arquivo.diar.ia.br/sitemap.xml -> cobertura
         de /temas/{slug} (#4903 item 2 — antes so o host principal era medido;
         sem --only-posts, que zeraria essas 4 URLs). --out-suffix "arquivo"
         evita colidir com o JSON/MD do passo 1 (#4909).
      3. seo-pull.ts --days 28            -> CTR/posicao + oportunidades.
    Gravam em data/seo/ com a data no nome, entao a serie temporal se
    acumula sozinha. Registrado pela task "Diaria-SEO-Weekly"
    (setup-seo-schedule.ps1) — mesmos 3 passos de SCHEDULED_TASKS
    (scripts/lib/scheduled-tasks.ts), espelhados aqui porque este .ps1
    continua sendo a via de execucao real no Windows (ver CLAUDE.md).

    Log: mesmo padrao do #4047 — a run inteira e escrita num arquivo temporario
    FORA de data/ (que e junction pro OneDrive e trava intermitentemente) e so
    no fim e anexada ao log final, com retry. Falha de log reprova a run.

.NOTES
    Issue: #4105 (loop de SEO: #1896; seo-pull: #1989).
    Requer: junction data/ + data/.credentials.json com scope webmasters.
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
#    --limit 2000 (subiu de 250 no #5118 item 1a) -- a cota real e 2.000/dia
#    contra ~239 URLs/rodada; 250 truncava descartando as URLs MAIS ANTIGAS
#    sem marca nenhuma no relatorio (sitemap newest-first).
Write-TempLogLine "----- seo-index-check --only-posts -----"
& npx tsx "$IndexCheckScript" --only-posts --limit 2000 2>&1 | ForEach-Object { $_.ToString() } | Out-File -FilePath $TempLogPath -Append -Encoding utf8
$indexCode = $LASTEXITCODE

# 2. Cobertura de /temas/{slug} em arquivo.diar.ia.br (#4903 item 2). SEM
#    --only-posts (o filtro e /\/p\//, que zeraria as 4 URLs deste sitemap —
#    armadilha ja documentada no #4909) e com --out-suffix "arquivo" pra nao
#    colidir com o JSON/MD do passo 1 no mesmo dia. Mesmos args do step
#    "index-arquivo" em scripts/lib/scheduled-tasks.ts.
Write-TempLogLine "----- seo-index-check --sitemap arquivo.diar.ia.br -----"
& npx tsx "$IndexCheckScript" --sitemap "https://arquivo.diar.ia.br/sitemap.xml" --limit 10 --out-suffix "arquivo" 2>&1 | ForEach-Object { $_.ToString() } | Out-File -FilePath $TempLogPath -Append -Encoding utf8
$indexArquivoCode = $LASTEXITCODE

# 3. Search Analytics (CTR/posicao). Sem historico ainda retorna 0 linhas — ok,
#    nao e erro; o exit code so reprova em falha de API.
Write-TempLogLine "----- seo-pull --days 28 -----"
& npx tsx "$PullScript" --days 28 2>&1 | ForEach-Object { $_.ToString() } | Out-File -FilePath $TempLogPath -Append -Encoding utf8
$pullCode = $LASTEXITCODE

Write-TempLogLine "===== fim (index=$indexCode index-arquivo=$indexArquivoCode pull=$pullCode) ====="

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

$code = if ($indexCode -ne 0) { $indexCode } elseif ($indexArquivoCode -ne 0) { $indexArquivoCode } elseif ($pullCode -ne 0) { $pullCode } elseif (-not $logAppendOk) { 1 } else { 0 }
exit $code
