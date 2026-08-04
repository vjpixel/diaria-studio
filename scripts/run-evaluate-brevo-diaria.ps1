<#
.SYNOPSIS
    Wrapper diario do evaluate-brevo-diaria.ts --push (#4534, fecha o checkbox
    aberto da #4476) - para o Task Scheduler.

.DESCRIPTION
    Roda `npx tsx scripts/evaluate-brevo-diaria.ts --push` no repo root e loga
    a saida (UTF-8) em data/brevo-diaria/.evaluate.log. O script avalia cada
    contato `in_brevo` do canal Brevo proprio do editor (descadastro nativo +
    auto-confirmacao + promocao por score + supressao, desenho aprovado na
    #4476) e desvincula da lista quem for promovido/suprimido
    (`unlinkFromBrevoList`) - sem isso, so quem for desvinculado manualmente
    para de receber a diaria duas vezes (Beehiiv + Brevo).

    Mesmo padrao de log resiliente do #4047/#4320/#4485: escreve primeiro num
    arquivo temporario FORA de data/ (sem risco de lock do OneDrive) e so no
    final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Brevo-Diaria-Evaluate"
    (setup-evaluate-brevo-diaria-schedule.ps1).

.NOTES
    Issue: #4534.
#>
param(
    # Overrides usados por teste de regressao para simular sucesso/falha sem
    # depender de credenciais reais nem do junction data/.
    [string]$EvaluateScript,
    [string]$LogPath,
    [string]$TempLogPath,
    [string]$ContactsJsonPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir "..")).Path

if (-not $EvaluateScript)    { $EvaluateScript    = Join-Path $RepoRoot "scripts\evaluate-brevo-diaria.ts" }
if (-not $LogPath)           { $LogPath           = Join-Path $RepoRoot "data\brevo-diaria\.evaluate.log" }
if (-not $TempLogPath)       { $TempLogPath       = Join-Path $env:TEMP "diaria-evaluate-brevo-diaria-$PID.log" }
if (-not $ContactsJsonPath)  { $ContactsJsonPath  = Join-Path $RepoRoot "data\brevo-diaria\contacts.json" }

Set-Location $RepoRoot

function Write-TempLogLine {
    param([string]$Value)
    Add-Content -Path $TempLogPath -Encoding utf8 -Value $Value
}

Write-TempLogLine ""
Write-TempLogLine "===== $(Get-Date -Format o) - evaluate brevo diaria ====="

# Guard de junction nao montada (review PR #4552, achado HIGH silent-failure-
# hunter): readStore() em scripts/lib/brevo-diaria-store.ts trata "arquivo
# ausente" como "1a execucao legitima" (emptyStore(), sem distinguir isso de
# "o junction data/ do OneDrive ainda nao montou" -- ex: task disparando as
# 05:30 logo apos a maquina acordar/reiniciar). Sem esse guard, main() loga
# "0 contato(s) in_brevo a avaliar" (texto identico ao caso legitimo de fila
# vazia) e, como --push esta ativo, grava esse {"contacts":[]} de volta,
# sobrescrevendo os contatos reais do store. Guard fica aqui no WRAPPER (nao
# em evaluate-brevo-diaria.ts/brevo-diaria-store.ts, compartilhados fora
# deste fluxo) -- mesmo espirito de deteccao local/cloud de
# scripts/lib/exec-mode.ts, resolvido aqui no nivel do .ps1.
if (-not (Test-Path -LiteralPath $ContactsJsonPath -PathType Leaf)) {
    Write-TempLogLine "AVISO: contacts.json nao encontrado ($ContactsJsonPath) -- provavel junction data/ nao montada ainda; abortando por seguranca, NAO rodando --push."
    Write-TempLogLine "===== fim (evaluate=skip-guard) ====="
    $evaluateCode = 1
} else {
    # Pre-inicializa $LASTEXITCODE=$null ANTES da chamada nativa (#4343): mesmo
    # guard documentado em run-cursos-kv-sync.ps1/run-clarice-sync-daily.ps1/
    # run-apoios-diff-alarm.ps1 -- sob Set-StrictMode, `npx` falhando a resolver
    # deixa $LASTEXITCODE genuinamente indefinido (nao $null), e ler essa
    # variavel lanca. Pre-setar aqui garante deteccao correta do caso "npx nao
    # rodou".
    $LASTEXITCODE = $null
    & npx tsx "$EvaluateScript" --push 2>&1 | ForEach-Object { $_.ToString() } | Out-File -FilePath $TempLogPath -Append -Encoding utf8
    $evaluateCode = $LASTEXITCODE

    if ($null -eq $evaluateCode) {
        Write-TempLogLine "ERRO: npx nao executou (comando nao encontrado ou falha antes do processo iniciar)."
        $evaluateCode = 1
    }

    Write-TempLogLine "===== fim (evaluate=$evaluateCode) ====="
}

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

# Exit code honesto: falha de log tambem reprova a run, mesmo que o evaluate
# tenha ido bem -- sem isso, o Task Scheduler poderia achar que esta tudo ok
# sem nenhum log da run ter sido persistido.
$code = if ($evaluateCode -ne 0) { $evaluateCode } elseif (-not $logAppendOk) { 1 } else { 0 }
exit $code
