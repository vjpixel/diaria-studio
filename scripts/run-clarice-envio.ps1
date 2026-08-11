<#
.SYNOPSIS
    Wrapper do planejamento/agendamento diario da onda Clarice (decisoes do
    editor 260811) -- para o Task Scheduler.

.DESCRIPTION
    Roda `scripts/clarice-envio-run.ts` no repo root e loga a saida (UTF-8)
    em data/clarice-subscribers/.envio-run.log. O script levanta o estado dos
    ultimos envios, aplica o FREIO (so risco de ISP: hard bounce >=2%, bounce
    total >=5%, unsub >=3%, spam Postmaster >=0,3% -- janela dos ultimos 3
    dias de envio) e o ACELERADOR (escalada adaptativa pela folga ate os
    limiares, teto +25%/dia, janela 30 dias), e agenda a campanha da onda do
    dia seguinte pras 06:00 BRT (09:00 UTC).

    ABERTURA NAO FREIA VOLUME (decisao do editor 260811): a base de 1o envio
    e ~96% fria e abre ~1%; o limiar antigo (openRate < 15% => corta 30%) era
    uma catraca que zerava o envio (10.014 -> 322 -> 1.053 -> 817). Abertura
    virou metrica de observacao/tendencia (janela 60d), reportada e nunca
    aplicada como corte.

    Kill switch: data/clarice-envio-enabled.json. **Default LIGADO quando o
    arquivo esta ausente** -- o INVERSO do run-clarice-novos.ps1. Pausar e
    `npx tsx scripts/lib/clarice-envio-enabled.ts --set disabled`.

    Log resiliente + exit code honesto: molde compartilhado por
    scripts/lib/Invoke-DiariaScheduledWrapper.psm1 (#4756) -- escreve
    primeiro num arquivo temporario FORA de data/ (sem risco de lock do
    OneDrive) e so no final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Clarice-Envio"
    (setup-clarice-envio-schedule.ps1, que registra tambem a task irma
    "Diaria-Clarice-Envio-Guard" das 05:00).

.NOTES
    Decisoes do editor 260811. Modulo compartilhado: #4756.
    Molde: run-clarice-novos.ps1 (#4347/#4941).
#>
param(
    # Overrides usados por teste de regressao para simular sucesso/falha sem
    # depender de credenciais reais nem do junction data/.
    [string]$RunScript,
    [string]$LogPath,
    [string]$TempLogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir "..")).Path

if (-not $RunScript)   { $RunScript   = Join-Path $RepoRoot "scripts\clarice-envio-run.ts" }
if (-not $LogPath)     { $LogPath     = Join-Path $RepoRoot "data\clarice-subscribers\.envio-run.log" }
if (-not $TempLogPath) { $TempLogPath = Join-Path $env:TEMP "diaria-clarice-envio-run-$PID.log" }

try {
    # Mesmo guard de run-robots-txt-drift-check.ps1 (#4756 fleet review,
    # achado CRITICAL): sem este bloco, falha ao CARREGAR o modulo
    # compartilhado e um erro NAO-terminante sob
    # $ErrorActionPreference="Continue" -- o Import-Module fica dentro do
    # try; a CHAMADA da funcao fica FORA dele de proposito (o guard interno
    # do modulo pro caso "npx nao resolve" depende de rodar sem try/catch
    # envolvente).
    Import-Module (Join-Path $ScriptDir "lib\Invoke-DiariaScheduledWrapper.psm1") -Force -ErrorAction Stop
} catch {
    $failMsg = "ERRO FATAL: falha ao carregar Invoke-DiariaScheduledWrapper.psm1: $_"
    Write-Error $failMsg
    try {
        Add-Content -Path $LogPath -Encoding utf8 -Value "`n===== $(Get-Date -Format o) - clarice envio run =====`n$failMsg`n===== fim (run=1) =====" -ErrorAction Stop
    } catch {
        # melhor esforco -- falha de log aqui ja e o pior caso possivel, mas nao pode mascarar o exit code
    }
    exit 1
}

$code = Invoke-DiariaScheduledWrapper `
    -RepoRoot $RepoRoot `
    -ScriptPath $RunScript `
    -LogPath $LogPath `
    -TempLogPath $TempLogPath `
    -Label "clarice envio run" `
    -ExitCodeKey "run"

exit $code
