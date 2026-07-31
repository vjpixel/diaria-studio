<#
.SYNOPSIS
    Wrapper do alarme de erro do worker cursos (#4320) - para o Task Scheduler.

.DESCRIPTION
    Roda `npx tsx scripts/cursos-error-alarm.ts` no repo root e loga a saida
    (UTF-8) em data/cursos-subscribers/.error-alarm.log. Sem automacao
    disparando este script, o alarme fica implementado e testado mas nunca
    dispara sozinho -- mesma licao do "finding 1" do #4131 (guardrail
    Clarice), aplicada aqui de proposito antes de repetir o gap.

    Requer CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_WORKERS_TOKEN + CURSOS_KV_NAMESPACE_ID
    no .env local (#4382: leitura de contadores KV, não mais
    CLOUDFLARE_API_TOKEN/Analytics API) + data/.credentials.json com o scope
    gmail.send (ver docstring de scripts/cursos-error-alarm.ts) + o junction
    data/ (OneDrive).

    Mesmo padrao de log resiliente do #4047 (run-clarice-sync-daily.ps1):
    escreve primeiro num arquivo temporario FORA de data/ (sem risco de lock
    do OneDrive) e so no final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Cursos-Error-Alarm"
    (setup-cursos-error-alarm-schedule.ps1).

.NOTES
    Issue: #4320.
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

if (-not $AlarmScript) { $AlarmScript = Join-Path $RepoRoot "scripts\cursos-error-alarm.ts" }
if (-not $LogPath)     { $LogPath     = Join-Path $RepoRoot "data\cursos-subscribers\.error-alarm.log" }
if (-not $TempLogPath) { $TempLogPath = Join-Path $env:TEMP "diaria-cursos-error-alarm-$PID.log" }

Set-Location $RepoRoot

function Write-TempLogLine {
    param([string]$Value)
    Add-Content -Path $TempLogPath -Encoding utf8 -Value $Value
}

Write-TempLogLine ""
Write-TempLogLine "===== $(Get-Date -Format o) - cursos error alarm ====="

# Pre-inicializa $LASTEXITCODE=$null ANTES da chamada nativa (#4343): sob
# Set-StrictMode -Version Latest, se `npx` for a 1a invocacao nativa da
# sessao e falhar a resolver (CommandNotFoundException -- PATH nao herdado
# corretamente sob o Task Scheduler), $LASTEXITCODE fica genuinamente
# INDEFINIDO (nao $null) -- ler uma variavel indefinida sob StrictMode lanca
# erro (nao-terminante, engolido por $ErrorActionPreference = Continue), e
# o guard abaixo nunca dispara porque a propria comparacao "$null -eq
# $alarmCode" tambem lanca (verificado empiricamente, mesmo padrao do
# #4343/#4342). Pre-setar aqui garante que a variavel ja existe (com valor
# $null) antes da tentativa -- uma invocacao nativa que falha a resolver NAO
# toca $LASTEXITCODE (permanece no valor anterior), entao o guard consegue
# detectar o caso.
$LASTEXITCODE = $null
& npx tsx "$AlarmScript" 2>&1 | ForEach-Object { $_.ToString() } | Out-File -FilePath $TempLogPath -Append -Encoding utf8
$alarmCode = $LASTEXITCODE

# $LASTEXITCODE so e setado por um processo nativo que de fato rodou. Se o
# `npx` nao puder ser resolvido/spawnado neste contexto (ex: PATH nao
# herdado corretamente sob o Task Scheduler), o guard acima ja garante que
# $alarmCode fica $null (nunca indefinido) -- "$null -ne 0" avalia $true,
# entao sem este guard `exit $null` resolveria pra exit 0 (falso sucesso)
# exatamente no caso mais provavel de falha de uma invocacao
# nao-supervisionada (#4343).
if ($null -eq $alarmCode) {
    Write-TempLogLine "ERRO: npx nao executou (comando nao encontrado ou falha antes do processo iniciar)."
    $alarmCode = 1
}

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
