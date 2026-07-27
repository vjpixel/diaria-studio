<#
.SYNOPSIS
    Wrapper do alarme de guardrail furado do ramp Clarice (#4064) - para o Task Scheduler.

.DESCRIPTION
    Roda `npx tsx scripts/clarice-guardrail-alarm.ts` no repo root e loga a saida
    (UTF-8) em data/clarice-subscribers/.guardrail-alarm.log. Sem automacao
    disparando este script, o alarme do #4064 nunca dispara sozinho (achado
    "finding 1" do self-review do PR #4131) -- a logica (janela de 6h,
    idempotencia, e-mail) ja estava implementada e testada, so faltava o
    agendamento.

    Requer BREVO_CLARICE_API_KEY no .env local + data/.credentials.json com o
    scope gmail.send (ver docstring de scripts/clarice-guardrail-alarm.ts) + o
    junction data/ (OneDrive).

    Mesmo padrao de log resiliente do #4047 (run-clarice-sync-daily.ps1):
    escreve primeiro num arquivo temporario FORA de data/ (sem risco de lock
    do OneDrive) e so no final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Clarice-Guardrail-Alarm"
    (setup-clarice-guardrail-alarm-schedule.ps1).

.NOTES
    Issue: #4064 (alarme), #4131 finding 1 (agendamento).
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

if (-not $AlarmScript) { $AlarmScript = Join-Path $RepoRoot "scripts\clarice-guardrail-alarm.ts" }
if (-not $LogPath)     { $LogPath     = Join-Path $RepoRoot "data\clarice-subscribers\.guardrail-alarm.log" }
if (-not $TempLogPath) { $TempLogPath = Join-Path $env:TEMP "diaria-clarice-guardrail-alarm-$PID.log" }

Set-Location $RepoRoot

function Write-TempLogLine {
    param([string]$Value)
    Add-Content -Path $TempLogPath -Encoding utf8 -Value $Value
}

Write-TempLogLine ""
Write-TempLogLine "===== $(Get-Date -Format o) - clarice guardrail alarm ====="

& npx tsx "$AlarmScript" 2>&1 | ForEach-Object { $_.ToString() } | Out-File -FilePath $TempLogPath -Append -Encoding utf8
$alarmCode = $LASTEXITCODE

Write-TempLogLine "===== fim (alarm=$alarmCode) ====="

# Anexa o log temporario (fora de data/, sem risco de lock OneDrive) ao log
# final dentro de data/, com retry curto -- o lock do OneDrive costuma liberar
# em milissegundos (mesmo padrao do #4047).
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
# tenha rodado bem -- sem isso, o Task Scheduler poderia achar que esta tudo
# ok sem nenhum log da run ter sido persistido.
$code = if ($alarmCode -ne 0) { $alarmCode } elseif (-not $logAppendOk) { 1 } else { 0 }
exit $code
