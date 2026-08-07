<#
.SYNOPSIS
    Wrapper do sync automatico do spamRate do Google Postmaster Tools (#4154)
    - para o Task Scheduler.

.DESCRIPTION
    Roda `npx tsx scripts/postmaster-spam-sync.ts` no repo root e loga a saida
    (UTF-8) em data/clarice-subscribers/.postmaster-spam-sync.log. Sem essa
    automacao, o breaker de spam da Rampa depende de leitura MANUAL do painel
    do Postmaster (~1min antes de cada envio, facil de esquecer -> sinal fica
    indeterminate e trava o escalonamento de volume).

    Requer data/.credentials.json com o scope postmaster.traffic.readonly
    (v2, #4704/#4707/#4711 — postmaster-spam-sync.ts migrou de
    postmaster.readonly/v1 pra domainStats:query/v2; ver scripts/oauth-setup.ts)
    + CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_WORKERS_TOKEN no .env local + o
    junction data/ (OneDrive).

    Mesmo padrao de log resiliente do #4047/#4064 (run-clarice-*.ps1): escreve
    primeiro num arquivo temporario FORA de data/ (sem risco de lock do
    OneDrive) e so no final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Postmaster-Spam-Sync"
    (setup-postmaster-spam-sync-schedule.ps1).

.NOTES
    Issue: #4154.
#>
param(
    # Overrides usados por teste de regressao para simular sucesso/falha sem
    # depender de credenciais reais nem do junction data/.
    [string]$SyncScript,
    [string]$LogPath,
    [string]$TempLogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir "..")).Path

if (-not $SyncScript)  { $SyncScript  = Join-Path $RepoRoot "scripts\postmaster-spam-sync.ts" }
if (-not $LogPath)     { $LogPath     = Join-Path $RepoRoot "data\clarice-subscribers\.postmaster-spam-sync.log" }
if (-not $TempLogPath) { $TempLogPath = Join-Path $env:TEMP "diaria-postmaster-spam-sync-$PID.log" }

Set-Location $RepoRoot

function Write-TempLogLine {
    param([string]$Value)
    Add-Content -Path $TempLogPath -Encoding utf8 -Value $Value
}

Write-TempLogLine ""
Write-TempLogLine "===== $(Get-Date -Format o) - postmaster spam sync ====="

# Pre-inicializa $LASTEXITCODE=$null ANTES da chamada nativa (#4375, mesmo
# gap do #4343): sob Set-StrictMode -Version Latest, se `npx` for a 1a
# invocacao nativa da sessao e falhar a resolver (CommandNotFoundException --
# PATH nao herdado corretamente sob o Task Scheduler), $LASTEXITCODE fica
# genuinamente INDEFINIDO (nao $null) -- ler uma variavel indefinida sob
# StrictMode lanca erro (nao-terminante, engolido por $ErrorActionPreference
# = Continue), e o guard abaixo nunca dispara porque a propria comparacao
# "$null -eq $syncCode" tambem lanca (verificado empiricamente no #4343).
# Pre-setar aqui garante que a variavel ja existe (com valor $null) antes da
# tentativa -- uma invocacao nativa que falha a resolver NAO toca
# $LASTEXITCODE (permanece no valor anterior), entao o guard consegue
# detectar o caso.
$LASTEXITCODE = $null
& npx tsx "$SyncScript" 2>&1 | ForEach-Object { $_.ToString() } | Out-File -FilePath $TempLogPath -Append -Encoding utf8
$syncCode = $LASTEXITCODE

# $LASTEXITCODE so e setado por um processo nativo que de fato rodou. Se o
# `npx` nao puder ser resolvido/spawnado neste contexto, o guard acima ja
# garante que $syncCode fica $null (nunca indefinido) -- "$null -ne 0"
# avalia $true, entao sem este guard `exit $null` resolveria pra exit 0
# (falso sucesso) exatamente no caso mais provavel de falha de uma
# invocacao nao-supervisionada (achado no self-review do #4342, gap
# fechado em #4375).
if ($null -eq $syncCode) {
    Write-TempLogLine "ERRO: npx nao executou (comando nao encontrado ou falha antes do processo iniciar)."
    $syncCode = 1
}

Write-TempLogLine "===== fim (sync=$syncCode) ====="

# Anexa o log temporario (fora de data/, sem risco de lock OneDrive) ao log
# final dentro de data/, com retry curto -- o lock do OneDrive costuma liberar
# em milissegundos (mesmo padrao do #4047/#4064).
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

# Exit code honesto: falha de log tambem reprova a run, mesmo que o sync
# tenha rodado bem -- sem isso, o Task Scheduler poderia achar que esta tudo
# ok sem nenhum log da run ter sido persistido.
$code = if ($syncCode -ne 0) { $syncCode } elseif (-not $logAppendOk) { 1 } else { 0 }
exit $code
