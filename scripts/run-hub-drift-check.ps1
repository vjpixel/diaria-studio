<#
.SYNOPSIS
    Wrapper do smoke-test de drift entre HUB_META e o Worker `arquivo`
    publicado (#4750) -- para o Task Scheduler.

.DESCRIPTION
    Roda `npx tsx scripts/hub-drift-check.ts` no repo root e loga a saida
    (UTF-8) em data/hub-drift-check/.drift-check.log. O script le HUB_META
    (workers/arquivo/src/hubs/meta.ts), bate GET {DIARIA_ARQUIVO_URL}/temas/{slug}
    em cada hub, e manda um e-mail (Gmail) ao editor quando algum hub nao
    responde 200 (404, 5xx) ou a chamada de rede falha.

    Log resiliente + exit code honesto: molde compartilhado por
    scripts/lib/Invoke-DiariaScheduledWrapper.psm1 (#4756) -- escreve
    primeiro num arquivo temporario FORA de data/ (sem risco de lock do
    OneDrive) e so no final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Hub-Drift-Check"
    (setup-hub-drift-check-schedule.ps1).

.NOTES
    Issue: #4750. Modulo compartilhado: #4756.
#>
param(
    # Overrides usados por teste de regressao para simular sucesso/falha sem
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
        Add-Content -Path $LogPath -Encoding utf8 -Value "`n===== $(Get-Date -Format o) - hub drift check =====`n$failMsg`n===== fim (check=1) =====" -ErrorAction Stop
    } catch {
        # melhor esforco -- falha de log aqui ja e' o pior caso possivel, mas nao pode mascarar o exit code
    }
    exit 1
}

$code = Invoke-DiariaScheduledWrapper `
    -RepoRoot $RepoRoot `
    -ScriptPath $CheckScript `
    -LogPath $LogPath `
    -TempLogPath $TempLogPath `
    -Label "hub drift check" `
    -ExitCodeKey "check"

exit $code
