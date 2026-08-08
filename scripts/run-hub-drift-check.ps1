<#
.SYNOPSIS
    Wrapper do smoke-test de drift entre HUB_META e o Worker `arquivo`
    publicado (#4750) — para o Task Scheduler.

.DESCRIPTION
    Roda `npx tsx scripts/hub-drift-check.ts` no repo root e loga a saída
    (UTF-8) em data/hub-drift-check/.drift-check.log. O script lê HUB_META
    (workers/arquivo/src/hubs/meta.ts), bate GET {DIARIA_ARQUIVO_URL}/temas/{slug}
    em cada hub, e manda um e-mail (Gmail) ao editor quando algum hub não
    responde 200 (404, 5xx) ou a chamada de rede falha.

    Mesmo padrao de log resiliente do #4047/#4320/#4723: escreve primeiro num
    arquivo temporario FORA de data/ (sem risco de lock do OneDrive) e so no
    final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Hub-Drift-Check"
    (setup-hub-drift-check-schedule.ps1).

.NOTES
    Issue: #4750.
#>
param(
    # Overrides usados por teste de regressão para simular sucesso/falha sem
    # depender de rede real nem do junction data/.
    [string]$CheckScript,
    [string]$LogPath,
    [string]$TempLogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir "..")).Path

if (-not $CheckScript) { $CheckScript = Join-Path $RepoRoot "scripts\hub-drift-check.ts" }
if (-not $LogPath)     { $LogPath     = Join-Path $RepoRoot "data\hub-drift-check\.drift-check.log" }
if (-not $TempLogPath) { $TempLogPath = Join-Path $env:TEMP "diaria-hub-drift-check-$PID.log" }

Set-Location $RepoRoot

function Write-TempLogLine {
    param([string]$Value)
    Add-Content -Path $TempLogPath -Encoding utf8 -Value $Value
}

Write-TempLogLine ""
Write-TempLogLine "===== $(Get-Date -Format o) - hub drift check ====="

# Pre-inicializa $LASTEXITCODE=$null ANTES da chamada nativa (#4343): mesmo
# guard documentado em run-worker-drift-check.ps1/run-cursos-kv-sync.ps1 --
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
