<#
.SYNOPSIS
    Wrapper do guard matinal da onda Clarice ja agendada (decisoes do editor
    260811) -- para o Task Scheduler.

.DESCRIPTION
    Roda `scripts/clarice-envio-guard.ts` no repo root e loga a saida (UTF-8)
    em data/clarice-subscribers/.envio-guard.log. Segunda metade do par
    Diaria-Clarice-Envio: a onda e planejada e AGENDADA as 19:00 do dia
    anterior, e a Brevo congela destinatarios no AGENDAMENTO, nao no envio.
    Entre 19:00 e 06:00 chegam ~11h de bounce/unsub/spam da onda ANTERIOR --
    as 05:00 este passo reavalia o freio de risco de ISP com esse dado fresco
    e e a ultima chance de segurar o disparo das 06:00.

    Kill switch: data/clarice-envio-enabled.json (o MESMO do run das 19:00 --
    pausar a automacao pausa o par inteiro). Default LIGADO quando o arquivo
    esta ausente, o INVERSO do run-clarice-novos.ps1.

    Log resiliente + exit code honesto: molde compartilhado por
    scripts/lib/Invoke-DiariaScheduledWrapper.psm1 (#4756) -- escreve
    primeiro num arquivo temporario FORA de data/ (sem risco de lock do
    OneDrive) e so no final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Clarice-Envio-Guard"
    (setup-clarice-envio-schedule.ps1, o mesmo script que registra a task
    irma "Diaria-Clarice-Envio" das 19:00).

.NOTES
    Decisoes do editor 260811. Modulo compartilhado: #4756.
    Molde: run-clarice-novos.ps1 (#4347/#4941).
#>
param(
    # Overrides usados por teste de regressao para simular sucesso/falha sem
    # depender de credenciais reais nem do junction data/.
    [string]$GuardScript,
    [string]$LogPath,
    [string]$TempLogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir "..")).Path

if (-not $GuardScript) { $GuardScript = Join-Path $RepoRoot "scripts\clarice-envio-guard.ts" }
if (-not $LogPath)     { $LogPath     = Join-Path $RepoRoot "data\clarice-subscribers\.envio-guard.log" }
if (-not $TempLogPath) { $TempLogPath = Join-Path $env:TEMP "diaria-clarice-envio-guard-$PID.log" }

try {
    # Ver run-clarice-envio.ps1 para o porque deste try/catch cobrir so o
    # Import-Module (#4756 fleet review, achado CRITICAL).
    Import-Module (Join-Path $ScriptDir "lib\Invoke-DiariaScheduledWrapper.psm1") -Force -ErrorAction Stop
} catch {
    $failMsg = "ERRO FATAL: falha ao carregar Invoke-DiariaScheduledWrapper.psm1: $_"
    Write-Error $failMsg
    try {
        Add-Content -Path $LogPath -Encoding utf8 -Value "`n===== $(Get-Date -Format o) - clarice envio guard =====`n$failMsg`n===== fim (guard=1) =====" -ErrorAction Stop
    } catch {
        # melhor esforco -- falha de log aqui ja e o pior caso possivel, mas nao pode mascarar o exit code
    }
    exit 1
}

$code = Invoke-DiariaScheduledWrapper `
    -RepoRoot $RepoRoot `
    -ScriptPath $GuardScript `
    -LogPath $LogPath `
    -TempLogPath $TempLogPath `
    -Label "clarice envio guard" `
    -ExitCodeKey "guard"

exit $code
