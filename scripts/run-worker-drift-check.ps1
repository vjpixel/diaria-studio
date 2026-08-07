<#
.SYNOPSIS
    Wrapper do check de drift entre o código publicado de cada Worker e o
    master local (#4723) — para o Task Scheduler.

.DESCRIPTION
    Roda `npx tsx scripts/worker-drift-check.ts` no repo root e loga a saída
    (UTF-8) em data/worker-drift-check/.drift-check.log. O script descobre os
    workers em workers/*/wrangler.toml, consulta o último deploy publicado na
    Cloudflare, compara contra o último commit local de cada worker, e manda
    um e-mail (Gmail) ao editor quando algum worker está com deploy defasado
    (commit mais recente que o último `wrangler deploy`, ou nunca deployado).

    Mesmo padrão de log resiliente do #4047/#4320: escreve primeiro num
    arquivo temporário FORA de data/ (sem risco de lock do OneDrive) e só no
    final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Worker-Drift-Check"
    (setup-worker-drift-check-schedule.ps1).

.NOTES
    Issue: #4723.
#>
param(
    # Overrides usados por teste de regressão para simular sucesso/falha sem
    # depender de credenciais reais nem do junction data/.
    [string]$CheckScript,
    [string]$LogPath,
    [string]$TempLogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir "..")).Path

if (-not $CheckScript) { $CheckScript = Join-Path $RepoRoot "scripts\worker-drift-check.ts" }
if (-not $LogPath)     { $LogPath     = Join-Path $RepoRoot "data\worker-drift-check\.drift-check.log" }
if (-not $TempLogPath) { $TempLogPath = Join-Path $env:TEMP "diaria-worker-drift-check-$PID.log" }

Set-Location $RepoRoot

function Write-TempLogLine {
    param([string]$Value)
    Add-Content -Path $TempLogPath -Encoding utf8 -Value $Value
}

Write-TempLogLine ""
Write-TempLogLine "===== $(Get-Date -Format o) - worker drift check ====="

# Pre-inicializa $LASTEXITCODE=$null ANTES da chamada nativa (#4343): mesmo
# guard documentado em run-cursos-kv-sync.ps1/run-clarice-sync-daily.ps1 --
# sob Set-StrictMode, `npx` falhando a resolver deixa $LASTEXITCODE
# genuinamente indefinido (nao $null), e ler essa variavel lanca. Pre-setar
# aqui garante deteccao correta do caso "npx nao rodou".
$LASTEXITCODE = $null
& npx tsx "$CheckScript" 2>&1 | ForEach-Object { $_.ToString() } | Out-File -FilePath $TempLogPath -Append -Encoding utf8
$checkCode = $LASTEXITCODE

if ($null -eq $checkCode) {
    Write-TempLogLine "ERRO: npx nao executou (comando nao encontrado ou falha antes do processo iniciar)."
    $checkCode = 1
}

Write-TempLogLine "===== fim (check=$checkCode) ====="

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

# Exit code honesto: falha de log tambem reprova a run, mesmo que a checagem
# tenha ido bem -- sem isso, o Task Scheduler poderia achar que esta tudo ok
# sem nenhum log da run ter sido persistido.
$code = if ($checkCode -ne 0) { $checkCode } elseif (-not $logAppendOk) { 1 } else { 0 }
exit $code
