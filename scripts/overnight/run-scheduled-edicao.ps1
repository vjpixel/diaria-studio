<#
.SYNOPSIS
    Runner agendado da pipeline Diar.ia — roda /diaria-edicao D+1 (Stages 0-3 + pré-render Stage 4).

.DESCRIPTION
    Invocado pelo Task Scheduler (Windows) de dom-qui às 14:00 BRT.
    Calcula AAMMDD = amanhã em America/Sao_Paulo, invoca claude -p com
    --permission-mode acceptEdits e --max-turns.

    Usa --skip newsletter,linkedin,facebook: o Stage 4 executa pré-render completo
    (HTML + imagens + upload Worker + close-poll) mas NÃO dispatcha nenhum canal.
    O consent é gravado com todos os canais pending_manual via
    build-publish-consent.ts --skip (path 1 de §4b) — sem gate interativo,
    sem fallback default-auto (#1326/#2068).

    A run termina naturalmente após o pré-render. O editor, na manhã seguinte,
    roda /diaria-4-revisao {AAMMDD} (gate de revisão) e depois
    /diaria-5-publicacao {AAMMDD} (consent novo sobrescreve o do scheduled run),
    ou publica manualmente.

    --max-turns permanece como safety net para stalls inesperados.

    Logs:
      - data/run-log.jsonl  — via scripts/log-event.ts (structured, pipeline-wide)
      - data/overnight-schedule.log  — append-only, resumo linha por linha desta run

    GUARD DE PUBLICAÇÃO: Este script prepara conteúdos (Stages 0-3) e pré-renderiza
    o Stage 4, mas NÃO dispatcha nenhum canal. A publicação requer ação explícita do editor.

.NOTES
    Issue: #2068
    Registro da task: ver scripts/overnight/setup-edicao-schedule.ps1
    Documentação: docs/scheduled-edicao-setup.md
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# 1. Derivar paths a partir do próprio script (sem hardcode de usuário/máquina)
# ---------------------------------------------------------------------------
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = Resolve-Path (Join-Path $ScriptDir "../..")
$DataDir    = Join-Path $RepoRoot "data"
$LogFile    = Join-Path $DataDir "overnight-schedule.log"
$RunLogTs   = Join-Path $RepoRoot "scripts/log-event.ts"

# ---------------------------------------------------------------------------
# 2. Calcular AAMMDD = amanhã em America/Sao_Paulo
# ---------------------------------------------------------------------------
# Usa scripts/overnight/calc-next-edition-date.ts via npx tsx — roda a lógica
# de scripts/lib/next-edition-date.ts (testada por test/next-edition-date.test.ts).
# Se npx falhar (node não no PATH ou node_modules ausente), usa fallback PS puro.
$CalcScript = Join-Path $ScriptDir "calc-next-edition-date.ts"

$TsOutput = & npx tsx $CalcScript 2>$null
# $TsOutput pode ser string ou array — normalizar, trim \r, filtrar warnings do Node
$Aammdd = ($TsOutput -join "`n") -split "`n" |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -match '^\d{6}$' } |
    Select-Object -Last 1

if (-not $Aammdd) {
    # Fallback puro PowerShell com InvariantCulture — imune a locale/calendário
    $NowBrt   = (Get-Date).ToUniversalTime().AddHours(-3)
    $Tomorrow = $NowBrt.AddDays(1)
    $Aammdd   = $Tomorrow.ToString("yyMMdd", [System.Globalization.CultureInfo]::InvariantCulture)
}

$RunStart = Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz"

# ---------------------------------------------------------------------------
# 3. Helper: gravar no log de schedule (data/ pode não existir ainda)
# ---------------------------------------------------------------------------
function Write-ScheduleLog {
    param([string]$Message)
    if (-not (Test-Path $DataDir)) {
        # data/ é junction para OneDrive — se não existir, logar no console mas não falhar
        Write-Warning "data/ não encontrado. Log de schedule não gravado. Mensagem: $Message"
        return
    }
    $Line = "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz') | $Message"
    # try/catch: lock do OneDrive no log não deve abortar o script principal
    try {
        Add-Content -Path $LogFile -Value $Line -Encoding UTF8
    } catch {
        Write-Warning "Write-ScheduleLog: falha ao gravar em $LogFile — $_"
    }
}

# ---------------------------------------------------------------------------
# 4. Helper: logar no run-log.jsonl via log-event.ts
# ---------------------------------------------------------------------------
function Write-RunLog {
    param(
        [string]$Level,
        [string]$Message,
        [string]$Details = "{}"
    )
    if (-not (Test-Path $DataDir)) { return }
    $NpxArgs = @(
        "tsx", $RunLogTs,
        "--edition", $Aammdd,
        "--agent",   "scheduled-edicao",
        "--level",   $Level,
        "--message", $Message,
        "--details", $Details
    )
    try {
        & npx @NpxArgs 2>$null
    } catch {
        # Log de run-log falhou — não propagar; já temos o schedule log
    }
}

# ---------------------------------------------------------------------------
# 5. Wrapper: grava no schedule log E no run-log em uma só chamada
# ---------------------------------------------------------------------------
# #2104: Write-ScheduleLog + Write-RunLog eram sempre chamados em par (4 sites).
# Write-Log é um wrapper que os une — mesma semântica, menos repetição.
function Write-Log {
    param(
        [string]$ScheduleMsg,
        [string]$Level,
        [string]$RunMsg,
        [string]$Details = "{}"
    )
    Write-ScheduleLog $ScheduleMsg
    Write-RunLog -Level $Level -Message $RunMsg -Details $Details
}

# ---------------------------------------------------------------------------
# 6. Início da run
# ---------------------------------------------------------------------------
Write-Log `
    -ScheduleMsg "START edition=$Aammdd pid=$PID" `
    -Level       "info" `
    -RunMsg      "scheduled-edicao: início" `
    -Details     "{`"edition`":`"$Aammdd`",`"trigger`":`"task-scheduler`"}"

# ---------------------------------------------------------------------------
# 7. Verificar se claude está no PATH
# ---------------------------------------------------------------------------
$ClaudePath = Get-Command "claude" -ErrorAction SilentlyContinue
if (-not $ClaudePath) {
    $Msg = "claude CLI não encontrado no PATH. Abortando. Verifique a instalação do Claude Code."
    Write-Warning $Msg
    Write-Log -ScheduleMsg "ERROR $Msg" -Level "error" -RunMsg "scheduled-edicao: $Msg"
    exit 1
}

# ---------------------------------------------------------------------------
# 8. Invocar claude -p /diaria-edicao AAMMDD --skip newsletter,linkedin,facebook
#
#    --permission-mode acceptEdits  → aceita edições de arquivos sem prompt
#    --max-turns 120                → safety net; run termina naturalmente após
#                                     o pré-render do Stage 4 (não aguarda gate)
#    --output-format text           → saída legível no log
#    --no-session-persistence       → não salvar sessão headless (economiza disco)
#
#    --skip newsletter,linkedin,facebook → Stage 4 grava consent pending_manual
#    em todos os canais (build-publish-consent.ts --skip, path 1 de §4b) e
#    encerra sem dispatchar. Elimina o fallback default-auto do pre-gate (#2068).
#
#    Nota: MCP servers claude.ai (beehiiv, gmail) são carregados via .mcp.json
#    do repo + keychain. Em sessão headless eles ficam disponíveis se o
#    usuário estiver autenticado no Claude (OAuth). Sem MCPs, o orquestrador
#    faz halt fail-fast (#738) e a run encerra com erro gravado no run-log.
# ---------------------------------------------------------------------------
$Prompt = "/diaria-edicao $Aammdd --skip newsletter,linkedin,facebook"

Write-Output "[$RunStart] Iniciando: claude -p '$Prompt'"

try {
    $Output = & claude `
        --print `
        --permission-mode acceptEdits `
        --max-turns 120 `
        --output-format text `
        --no-session-persistence `
        $Prompt `
        2>&1

    $ExitCode = $LASTEXITCODE
} catch {
    $ExitCode = 1
    $Output   = $_.Exception.Message
}

# ---------------------------------------------------------------------------
# 9. Registrar resultado
# ---------------------------------------------------------------------------
$RunEnd = Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz"

if ($ExitCode -eq 0) {
    Write-Log `
        -ScheduleMsg "OK    edition=$Aammdd exit=0 end=$RunEnd" `
        -Level       "info" `
        -RunMsg      "scheduled-edicao: concluído" `
        -Details     "{`"edition`":`"$Aammdd`",`"exit_code`":0}"
} else {
    # Truncar output para evitar linhas gigantes no log (últimas 20 linhas)
    # Normalizar CRLF e trim para evitar tokens com CR a direita
    $Tail = (($Output -join "`n") -split "`n" |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ -ne '' } |
        Select-Object -Last 20) -join " | "
    Write-Log `
        -ScheduleMsg "FAIL  edition=$Aammdd exit=$ExitCode end=$RunEnd tail=$Tail" `
        -Level       "error" `
        -RunMsg      "scheduled-edicao: falha (exit $ExitCode)" `
        -Details     "{`"edition`":`"$Aammdd`",`"exit_code`":$ExitCode}"
    exit $ExitCode
}
