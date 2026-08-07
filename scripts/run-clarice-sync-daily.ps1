<#
.SYNOPSIS
    Wrapper do sync incremental diário do store Clarice (para o Task Scheduler).

.DESCRIPTION
    Roda, em sequencia, no repo root:
      1. clarice-sync-brevo.ts --incremental  -> atualiza o STORE (SQLite).
      2. clarice-db-summary.ts                -> empurra o summary pra KV (DASHBOARD).
    Store e KV sao superficies SEPARADAS; sem o passo 2 o store fresco nao chega na
    dashboard. Loga tudo (UTF-8) em data/clarice-subscribers/.brevo-sync-daily.log.
    Requer BREVO_CLARICE_API_KEY + creds Cloudflare no .env local + o junction data/.

    Registrado pela task "Diaria-Clarice-Sync" (setup-clarice-sync-schedule.ps1).

    #4047: o log final mora em data/, que é uma directory junction pro OneDrive.
    `Add-Content` direto nesse path falhava intermitentemente ("O fluxo não era
    legível" — lock do OneDrive) e o script seguia como se nada tivesse
    acontecido, silenciosamente perdendo o log da run inteira, e o exit code
    não refletia isso. Fix: todo o log da run é escrito primeiro num arquivo
    temporário FORA de data/ (fora do OneDrive, sem risco de lock), e só no
    final é anexado ao log final com retry curto. Se o anexo falhar mesmo após
    retry, a run sai com exit != 0 mesmo que sync/summary tenham ido bem — o
    Task Scheduler/watchdog não pode achar que está tudo ok sem nenhum log
    tendo sido persistido.

.NOTES
    Issue: #2932 (sync incremental: #2928). Log resiliente: #4047.
#>
param(
    # Overrides usados pelo teste de regressão (#4047) para simular sucesso/
    # falha sem depender de credenciais reais nem do junction data/.
    [string]$SyncScript,
    [string]$SummaryScript,
    [string]$LogPath,
    [string]$TempLogPath,
    # #4740: overrides pro teste de regressão do passo de extração do status
    # do catch-up de opens — evita tocar o junction data/ real durante testes.
    [string]$ExtractScript,
    [string]$OpensStatusOut
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir "..")).Path

if (-not $SyncScript)     { $SyncScript     = Join-Path $RepoRoot "scripts\clarice-sync-brevo.ts" }
if (-not $SummaryScript)  { $SummaryScript  = Join-Path $RepoRoot "scripts\clarice-db-summary.ts" }
if (-not $LogPath)        { $LogPath        = Join-Path $RepoRoot "data\clarice-subscribers\.brevo-sync-daily.log" }
if (-not $TempLogPath)    { $TempLogPath    = Join-Path $env:TEMP "diaria-clarice-sync-daily-$PID.log" }
if (-not $ExtractScript)  { $ExtractScript  = Join-Path $RepoRoot "scripts\extract-opens-catchup-status.ts" }
if (-not $OpensStatusOut) { $OpensStatusOut = Join-Path $RepoRoot "data\clarice-subscribers\last-opens-catchup-status.json" }

Set-Location $RepoRoot

# Log em UTF-8 puro: `2>&1 | ForEach-Object { $_.ToString() }` achata os ErrorRecord
# de stderr nativo em texto (o clarice-sync escreve TODO o progresso em stderr) e
# grava via Out-File -Encoding utf8 — o `*>>` gravava o corpo em UTF-16LE e
# embrulhava cada linha de stderr num NativeCommandError multi-linha (review #2933).
#
# #4047: tudo é escrito primeiro em $TempLogPath (fora de data/, sem lock do
# OneDrive) e só no fim anexado ao log final com retry.

function Write-TempLogLine {
    param([string]$Value)
    Add-Content -Path $TempLogPath -Encoding utf8 -Value $Value
}

Write-TempLogLine ""
Write-TempLogLine "===== $(Get-Date -Format o) - clarice sync diario ====="

# 1. Sync incremental → atualiza o STORE (SQLite).
Write-TempLogLine "----- clarice-sync-brevo --incremental -----"
# Pre-inicializa $LASTEXITCODE=$null ANTES de cada chamada nativa (#4343):
# sob Set-StrictMode -Version Latest, se `npx` for a 1a invocacao nativa da
# sessao e falhar a resolver (CommandNotFoundException -- PATH nao herdado
# corretamente sob o Task Scheduler), $LASTEXITCODE fica genuinamente
# INDEFINIDO (nao $null) -- ler uma variavel indefinida sob StrictMode lanca
# erro (nao-terminante, engolido por $ErrorActionPreference = Continue), e
# o guard abaixo nunca dispara porque a propria comparacao "$null -eq
# $syncCode" tambem lanca (verificado empiricamente). Pre-setar aqui garante
# que a variavel ja existe (com valor $null) antes da tentativa -- uma
# invocacao nativa que falha a resolver NAO toca $LASTEXITCODE (permanece no
# valor anterior), entao o guard consegue detectar o caso.
$LASTEXITCODE = $null
& npx tsx "$SyncScript" --incremental 2>&1 | ForEach-Object { $_.ToString() } | Out-File -FilePath $TempLogPath -Append -Encoding utf8
$syncCode = $LASTEXITCODE

# $LASTEXITCODE so e setado por um processo nativo que de fato rodou. Se o
# `npx` nao puder ser resolvido/spawnado neste contexto, o guard acima ja
# garante que $syncCode fica $null (nunca indefinido) -- "$null -ne 0"
# avalia $true, entao sem este guard `exit $null` resolveria pra exit 0
# (falso sucesso) exatamente no caso mais provavel de falha de uma
# invocacao nao-supervisionada (#4343, mesmo padrao do fix em
# run-postmaster-spam-sync.ps1, #4342).
if ($null -eq $syncCode) {
    Write-TempLogLine "ERRO: npx nao executou (comando nao encontrado ou falha antes do processo iniciar)."
    $syncCode = 1
}

# #4740: extrai o status do catch-up de opens (#4688) desta run pro alarme
# dedicado (Diaria-Clarice-Opens-Catchup-Alarm / clarice-opens-catchup-alarm.ts)
# consumir depois -- lido AQUI, com $TempLogPath contendo so a saida do passo 1
# (antes do passo 2 acrescentar mais linhas), evitando ambiguidade entre runs.
# Best-effort: nunca falha a run principal (extract-opens-catchup-status.ts
# sempre sai 0, mas o try/catch cobre falha de spawn do proprio npx).
try {
    & npx tsx "$ExtractScript" --log "$TempLogPath" --out "$OpensStatusOut" 2>&1 |
        ForEach-Object { $_.ToString() } | Out-File -FilePath $TempLogPath -Append -Encoding utf8
} catch {
    Write-TempLogLine "AVISO: extract-opens-catchup-status.ts falhou a rodar (nao bloqueia o sync): $_"
}

# 2. Push do summary → atualiza a DASHBOARD (KV contacts:summary). Store e KV sao
#    superficies SEPARADAS; sem este passo, o store fresco nao chega na dashboard.
Write-TempLogLine "----- clarice-db-summary (push KV) -----"
$LASTEXITCODE = $null
& npx tsx "$SummaryScript" 2>&1 | ForEach-Object { $_.ToString() } | Out-File -FilePath $TempLogPath -Append -Encoding utf8
$sumCode = $LASTEXITCODE

# Mesmo guard do passo 1 (#4343) -- o passo 2 tambem chama npx e pode falhar
# a spawnar sob o mesmo contexto de servico do Task Scheduler.
if ($null -eq $sumCode) {
    Write-TempLogLine "ERRO: npx nao executou (comando nao encontrado ou falha antes do processo iniciar)."
    $sumCode = 1
}

Write-TempLogLine "===== fim (sync=$syncCode summary=$sumCode) ====="

# Anexa o log temporário (fora de data/, sem risco de lock OneDrive) ao log
# final dentro de data/, com retry curto — o lock do OneDrive costuma liberar
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

# Exit code honesto (#4047): falha de log também reprova a run, mesmo que
# sync/summary tenham ido bem — sem isso, o Task Scheduler/watchdog achava
# que estava tudo ok sem nenhum log da run ter sido persistido.
$code = if ($syncCode -ne 0) { $syncCode } elseif ($sumCode -ne 0) { $sumCode } elseif (-not $logAppendOk) { 1 } else { 0 }
exit $code
