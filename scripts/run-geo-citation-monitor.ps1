<#
.SYNOPSIS
    Wrapper do monitor semanal de citacao por assistente de IA (#4558 Parte C)
    - para o Task Scheduler.

.DESCRIPTION
    Roda `npx tsx scripts/geo-citation-monitor.ts` no repo root e loga a saida
    (UTF-8) em data/geo-citations/.monitor.log. O script pergunta a cada
    provedor configurado as perguntas fixas de GEO_QUESTIONS e registra em
    data/geo-citations/history.jsonl se a diar.ia.br foi citada.

    Por que agendar: o monitor foi mergeado no #4616 e ficou sem NUNCA ter
    rodado -- data/geo-citations/ nao existia no disco. Nenhum .ps1, nenhum
    workflow, nenhuma task o invocava, enquanto TODAS as outras tasks
    agendadas do repo ja seguiam esse padrao (13 em 07/ago; conferir com
    `ls scripts/setup-*-schedule.ps1`, o numero cresce). Sem cadencia o
    numero nunca acumula e o baseline de 07/ago morre sozinho.

    SEMANAL de proposito, nao diario: citacao por assistente muda em escala de
    semanas, a serie so tem valor como tendencia, e cada execucao gasta
    8 perguntas x N provedores em chamadas de API. Diario seria gastar 7x pra
    ler ruido.

    Fail-soft por provedor: o script pula quem nao tem API key configurada e
    reporta quais pulou (medido em 07/ago: rodou com OpenAI + Gemini,
    ANTHROPIC_API_KEY ausente). Isso NAO reprova a run -- meia medicao vale
    mais que nenhuma, e o log registra a cobertura parcial.

    Mesmo padrao de log resiliente do #4047/#4320: escreve primeiro num
    arquivo temporario FORA de data/ (sem risco de lock do OneDrive) e so no
    final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Geo-Citation-Monitor"
    (setup-geo-citation-monitor-schedule.ps1).

.NOTES
    Issue: #4558 Parte C.
#>
param(
    # Overrides usados por teste de regressao para simular sucesso/falha sem
    # depender de API keys reais nem do junction data/.
    [string]$MonitorScript,
    [string]$LogPath,
    [string]$TempLogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir "..")).Path

if (-not $MonitorScript) { $MonitorScript = Join-Path $RepoRoot "scripts\geo-citation-monitor.ts" }
if (-not $LogPath)       { $LogPath       = Join-Path $RepoRoot "data\geo-citations\.monitor.log" }
if (-not $TempLogPath)   { $TempLogPath   = Join-Path $env:TEMP "diaria-geo-citation-monitor-$PID.log" }

Set-Location $RepoRoot

function Write-TempLogLine {
    param([string]$Value)
    Add-Content -Path $TempLogPath -Encoding utf8 -Value $Value
}

Write-TempLogLine ""
Write-TempLogLine "===== $(Get-Date -Format o) - geo citation monitor ====="

# Pre-inicializa $LASTEXITCODE=$null ANTES da chamada nativa (#4343): sob
# Set-StrictMode, `npx` falhando a resolver deixa $LASTEXITCODE genuinamente
# indefinido (nao $null), e ler essa variavel lanca. Pre-setar aqui garante
# deteccao correta do caso "npx nao rodou".
#
# --strict (#4754): no caminho AGENDADO, sair 0 sem ter medido nada e uma
# mentira -- a task marcaria verde pra sempre enquanto history.jsonl congelava.
# Na invocacao manual o default (sem --strict) continua sendo 0, porque "sem
# key configurada" e estado valido por decisao do #4616.
$LASTEXITCODE = $null
& npx tsx "$MonitorScript" --strict 2>&1 | ForEach-Object { $_.ToString() } | Out-File -FilePath $TempLogPath -Append -Encoding utf8
$monitorCode = $LASTEXITCODE

if ($null -eq $monitorCode) {
    Write-TempLogLine "ERRO: npx nao executou (comando nao encontrado ou falha antes do processo iniciar)."
    $monitorCode = 1
}

Write-TempLogLine "===== fim (monitor=$monitorCode) ====="

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

# Exit code honesto: falha de log tambem reprova a run, mesmo que o monitor
# tenha ido bem -- sem isso, o Task Scheduler poderia achar que esta tudo ok
# sem nenhum log da run ter sido persistido.
$code = if ($monitorCode -ne 0) { $monitorCode } elseif (-not $logAppendOk) { 1 } else { 0 }
exit $code
