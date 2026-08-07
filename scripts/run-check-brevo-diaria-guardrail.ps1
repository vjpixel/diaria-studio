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

    Mesmo padrao de log resiliente do #4047/#4064 (run-clarice-guardrail-alarm.ps1):
    escreve primeiro num arquivo temporario FORA de data/ (sem risco de lock
    do OneDrive) e so no final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Brevo-Diaria-Guardrail"
    (setup-check-brevo-diaria-guardrail-schedule.ps1).

.NOTES
    Issue: #4476 item 9.
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

Set-Location $RepoRoot

function Write-TempLogLine {
    param([string]$Value)
    Add-Content -Path $TempLogPath -Encoding utf8 -Value $Value
}

Write-TempLogLine ""
Write-TempLogLine "===== $(Get-Date -Format o) - check brevo diaria guardrail ====="

# Pre-inicializa $LASTEXITCODE=$null ANTES da chamada nativa (#4343, mesmo
# guard de run-clarice-guardrail-alarm.ps1/run-evaluate-brevo-diaria.ps1) --
# sob Set-StrictMode, `npx` falhando a resolver deixa $LASTEXITCODE
# genuinamente indefinido (nao $null); ler essa variavel sob StrictMode
# lanca. Pre-setar aqui garante deteccao correta do caso "npx nao rodou".
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
