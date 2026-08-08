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

    --strict (#4754): sob a task agendada, sair 0 sem ter medido nada e uma
    mentira -- a task marcaria verde pra sempre enquanto a serie congelava.
    Na invocacao manual o default (sem --strict) continua sendo 0, porque
    "sem key configurada" e estado valido por decisao do #4616.

    Log resiliente + exit code honesto: molde compartilhado por
    scripts/lib/Invoke-DiariaScheduledWrapper.psm1 (#4756) -- escreve
    primeiro num arquivo temporario FORA de data/ (sem risco de lock do
    OneDrive) e so no final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Geo-Citation-Monitor"
    (setup-geo-citation-monitor-schedule.ps1).

.NOTES
    Issue: #4558 Parte C. Modulo compartilhado: #4756.
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

Import-Module (Join-Path $ScriptDir "lib\Invoke-DiariaScheduledWrapper.psm1") -Force

$code = Invoke-DiariaScheduledWrapper `
    -RepoRoot $RepoRoot `
    -ScriptPath $MonitorScript `
    -ScriptArgs @("--strict") `
    -LogPath $LogPath `
    -TempLogPath $TempLogPath `
    -Label "geo citation monitor" `
    -ExitCodeKey "monitor"

exit $code
