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

    Log resiliente + exit code honesto: molde compartilhado por
    scripts/lib/Invoke-DiariaScheduledWrapper.psm1 (#4756) -- escreve
    primeiro num arquivo temporario FORA de data/ (sem risco de lock do
    OneDrive) e so no final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Geo-Citation-Staleness-Alarm"
    (setup-geo-citation-staleness-alarm-schedule.ps1).

.NOTES
    Issue: #4755. Modulo compartilhado: #4756.
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

try {
    # #4756 fleet review (achado CRITICAL): sem este guard, falha ao
    # CARREGAR o modulo compartilhado (path errado, .psm1 corrompido, erro
    # de sintaxe futuro) e' um erro NAO-terminante sob
    # $ErrorActionPreference="Continue" -- o script cai direto no
    # `Invoke-DiariaScheduledWrapper` (que nem existe mais como funcao),
    # produz um 2o erro nao-terminante, e chega no `exit $code` com $code
    # nunca atribuido, que sai 0 sob Set-StrictMode. So o Import-Module fica
    # dentro do try -- a CHAMADA da funcao fica de propriedade FORA dele: o
    # guard interno do modulo pro caso "npx nao resolve" (#4343, guard-*)
    # depende de rodar SEM um try/catch envolvente (o erro de comando nao
    # encontrado so degrada pra `$LASTEXITCODE=$null` quando nao ha catch
    # mais proximo pra interceptar a excecao terminante antes da checagem de
    # guard do proprio modulo rodar) -- confirmado ao vivo: envolver a
    # chamada quebrou esse guard existente (regressao pega pelo teste
    # #4343 durante o proprio fleet review desta correcao).
    Import-Module (Join-Path $ScriptDir "lib\Invoke-DiariaScheduledWrapper.psm1") -Force -ErrorAction Stop
} catch {
    $failMsg = "ERRO FATAL: falha ao carregar Invoke-DiariaScheduledWrapper.psm1: $_"
    Write-Error $failMsg
    try {
        Add-Content -Path $LogPath -Encoding utf8 -Value "`n===== $(Get-Date -Format o) - geo citation staleness alarm =====`n$failMsg`n===== fim (alarm=1) =====" -ErrorAction Stop
    } catch {
        # melhor esforco -- falha de log aqui ja e' o pior caso possivel, mas nao pode mascarar o exit code
    }
    exit 1
}

$code = Invoke-DiariaScheduledWrapper `
    -RepoRoot $RepoRoot `
    -ScriptPath $AlarmScript `
    -LogPath $LogPath `
    -TempLogPath $TempLogPath `
    -Label "geo citation staleness alarm" `
    -ExitCodeKey "alarm"

exit $code
