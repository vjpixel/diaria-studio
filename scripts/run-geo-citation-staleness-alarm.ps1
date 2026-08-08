<#
.SYNOPSIS
    Wrapper do alarme de staleness do monitor de citacao GEO (#4755) - para
    o Task Scheduler.

.DESCRIPTION
    Roda `npx tsx scripts/geo-citation-staleness-alarm.ts` no repo root e loga
    a saida (UTF-8) em data/geo-citations/.staleness-alarm.log. O script le o
    `ts` do registro mais recente de data/geo-citations/history.jsonl
    (escrito pela task semanal "Diaria-Geo-Citation-Monitor") e, se fizer
    mais de ~3 semanas sem registro novo, manda um e-mail (Gmail) ao editor.

    Mesmo padrao de log resiliente do #4047/#4320/#4740: escreve primeiro num
    arquivo temporario FORA de data/ (sem risco de lock do OneDrive) e so no
    final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Geo-Citation-Staleness-Alarm"
    (setup-geo-citation-staleness-alarm-schedule.ps1).

.NOTES
    Issue: #4755.
#>
param(
    # Overrides usados por teste de regressao para simular sucesso/falha sem
    # depender de credenciais reais nem do junction data/.
    [string]$AlarmScript,
    [string]$LogPath,
    [string]$TempLogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir "..")).Path

if (-not $AlarmScript) { $AlarmScript = Join-Path $RepoRoot "scripts\geo-citation-staleness-alarm.ts" }
if (-not $LogPath)     { $LogPath     = Join-Path $RepoRoot "data\geo-citations\.staleness-alarm.log" }
if (-not $TempLogPath) { $TempLogPath = Join-Path $env:TEMP "diaria-geo-staleness-alarm-$PID.log" }

Set-Location $RepoRoot

function Write-TempLogLine {
    param([string]$Value)
    Add-Content -Path $TempLogPath -Encoding utf8 -Value $Value
}

Write-TempLogLine ""
Write-TempLogLine "===== $(Get-Date -Format o) - geo citation staleness alarm ====="

# Pre-inicializa $LASTEXITCODE=$null ANTES da chamada nativa (#4343): mesmo
# guard documentado em run-apoios-diff-alarm.ps1/run-clarice-opens-catchup-alarm.ps1 --
# sob Set-StrictMode, `npx` falhando a resolver deixa $LASTEXITCODE
# genuinamente indefinido (nao $null), e ler essa variavel lanca. Pre-setar
# aqui garante deteccao correta do caso "npx nao rodou".
$LASTEXITCODE = $null
& npx tsx "$AlarmScript" 2>&1 | ForEach-Object { $_.ToString() } | Out-File -FilePath $TempLogPath -Append -Encoding utf8
$alarmCode = $LASTEXITCODE

if ($null -eq $alarmCode) {
    Write-TempLogLine "ERRO: npx nao executou (comando nao encontrado ou falha antes do processo iniciar)."
    $alarmCode = 1
}

Write-TempLogLine "===== fim (alarm=$alarmCode) ====="

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

# Exit code honesto: falha de log tambem reprova a run, mesmo que o alarme
# tenha ido bem -- sem isso, o Task Scheduler poderia achar que esta tudo ok
# sem nenhum log da run ter sido persistido.
$code = if ($alarmCode -ne 0) { $alarmCode } elseif (-not $logAppendOk) { 1 } else { 0 }
exit $code
