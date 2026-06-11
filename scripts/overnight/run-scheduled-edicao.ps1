<#
.SYNOPSIS
    Runner agendado da pipeline Diar.ia — roda /diaria-edicao D+1 até o pre-gate.

.DESCRIPTION
    Invocado pelo Task Scheduler (Windows) de dom-qui às 14:00 BRT.
    Calcula AAMMDD = amanhã em America/Sao_Paulo, invoca claude -p com
    --permission-mode acceptEdits e --max-turns para parar antes que o
    pre-gate do Stage 4 bloqueie indefinidamente.

    Em modo headless (-p / print), o claude CLI roda de forma não-interativa:
    quando o orquestrador chega ao pre-gate do Stage 4 e emite a pergunta
    aguardando input do editor, não há TTY para responder — a run encerra
    naturalmente ao atingir --max-turns (sem resposta possível ao gate).
    O editor recebe os outputs de Stage 1-3 e dispara o Stage 4 manualmente
    via /diaria-4-publicar quando estiver pronto.

    Logs:
      - data/run-log.jsonl  — via scripts/log-event.ts (structured, pipeline-wide)
      - data/overnight-schedule.log  — append-only, resumo linha por linha desta run

    GUARD DE PUBLICAÇÃO: Este script apenas prepara os conteúdos (Stages 0-3).
    Ele NÃO publica nada — a publicação requer ação explícita do editor.

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

$Aammdd = & npx tsx $CalcScript 2>$null
if (-not $Aammdd -or $Aammdd -notmatch '^\d{6}$') {
    # Fallback puro PowerShell: UTC-3 fixo (BRT não tem DST desde 2019)
    $NowBrt = (Get-Date).ToUniversalTime().AddHours(-3)
    $Tomorrow = $NowBrt.AddDays(1)
    $Aammdd = $Tomorrow.ToString("yyMMdd")
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
    Add-Content -Path $LogFile -Value $Line -Encoding UTF8
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
# 5. Início da run
# ---------------------------------------------------------------------------
Write-ScheduleLog "START edition=$Aammdd pid=$PID"
Write-RunLog -Level "info" -Message "scheduled-edicao: início" `
    -Details "{`"edition`":`"$Aammdd`",`"trigger`":`"task-scheduler`"}"

# ---------------------------------------------------------------------------
# 6. Verificar se claude está no PATH
# ---------------------------------------------------------------------------
$ClaudePath = Get-Command "claude" -ErrorAction SilentlyContinue
if (-not $ClaudePath) {
    $Msg = "claude CLI não encontrado no PATH. Abortando. Verifique a instalação do Claude Code."
    Write-Warning $Msg
    Write-ScheduleLog "ERROR $Msg"
    Write-RunLog -Level "error" -Message "scheduled-edicao: $Msg"
    exit 1
}

# ---------------------------------------------------------------------------
# 7. Invocar claude -p /diaria-edicao AAMMDD
#
#    --permission-mode acceptEdits  → aceita edições de arquivos sem prompt
#    --max-turns 120                → ~2h de execução máxima a 1 turno/min
#                                     (o pre-gate Stage 4 aguarda input; em modo
#                                     headless não há resposta → run encerra ao
#                                     atingir o limite de turnos ou ao o
#                                     orquestrador completar Stage 3 normalmente).
#    --output-format text           → saída legível no log
#    --no-session-persistence       → não salvar sessão headless (economiza disco)
#
#    Nota: MCP servers claude.ai (beehiiv, gmail) são carregados via .mcp.json
#    do repo + keychain. Em sessão headless eles ficam disponíveis se o
#    usuário estiver autenticado no Claude (OAuth). Sem MCPs, o orquestrador
#    faz halt fail-fast (#738) e a run encerra com erro gravado no run-log.
# ---------------------------------------------------------------------------
$Prompt = "/diaria-edicao $Aammdd"

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
# 8. Registrar resultado
# ---------------------------------------------------------------------------
$RunEnd = Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz"

if ($ExitCode -eq 0) {
    Write-ScheduleLog "OK    edition=$Aammdd exit=0 end=$RunEnd"
    Write-RunLog -Level "info" -Message "scheduled-edicao: concluído" `
        -Details "{`"edition`":`"$Aammdd`",`"exit_code`":0}"
} else {
    # Truncar output para evitar linhas gigantes no log (últimas 20 linhas)
    $Tail = ($Output -split "`n" | Select-Object -Last 20) -join " | "
    Write-ScheduleLog "FAIL  edition=$Aammdd exit=$ExitCode end=$RunEnd tail=$Tail"
    Write-RunLog -Level "error" -Message "scheduled-edicao: falha (exit $ExitCode)" `
        -Details "{`"edition`":`"$Aammdd`",`"exit_code`":$ExitCode}"
    exit $ExitCode
}
