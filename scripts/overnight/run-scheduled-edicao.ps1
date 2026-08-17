<#
.SYNOPSIS
    Wrapper Windows Task Scheduler da edição diária agendada — invoca o
    runner TS multiplataforma (scripts/overnight/run-scheduled-edicao.ts).

    *** STATUS (17/08/2026, #5611): via Windows RESTAURADA — reverte parte
    do cutover final #5115/#5162, que tinha removido o par .ps1 antigo
    (run-scheduled-edicao.ps1 + setup-edicao-schedule.ps1) por decisão do
    editor de que nenhuma máquina Windows rodava mais tasks Diaria-*. O
    editor reverteu essa decisão no mesmo dia: `Diaria-Edicao-Diaria`
    precisa do navegador (Claude in Chrome), então roda no Windows — o
    timer systemd em `predator` (Linux) foi desabilitado na mesma sessão.

.DESCRIPTION
    Ao contrário do .ps1 original (que duplicava toda a lógica em
    PowerShell — cálculo de data D+1, guard de idempotência, invocação
    do `claude`, logging), este wrapper é deliberadamente fino: delega
    100% da lógica para scripts/overnight/run-scheduled-edicao.ts, que já
    é multiplataforma desde a criação no #4998 (Node puro — node:fs,
    node:path, node:child_process — sem nada específico de Linux) e já
    carrega o filtro de auth do #5608 (`CLAUDE_CLI_STRIPPED_ENV_VARS` —
    remove ANTHROPIC_API_KEY/etc do ambiente do processo filho antes de
    invocar `claude`, para nunca deixar a sessão agendada trocar o login
    claude.ai pela API paga). O .ps1 antigo não tinha essa proteção porque
    foi escrito antes do #5608 — reimplementá-lo do zero reintroduziria
    esse risco. É por isso que esta issue prefere a rota (b) em vez da
    recuperação literal do .ps1 antigo via `git show`.

    O Windows Task Scheduler precisa de um executável/.ps1 como Action —
    é só isso que este arquivo fornece; nenhuma lógica de negócio vive aqui.

.NOTES
    Issue: #5611 (reverte parte do #5115/#5162; história original #2068/#4998)
    Registro da task: scripts/overnight/setup-edicao-schedule.ps1
    Documentação: docs/scheduled-edicao-setup.md
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Paths (derivados do próprio script — sem hardcode de usuário/máquina)
# ---------------------------------------------------------------------------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir "../..")).Path
$RunnerTs  = Join-Path $RepoRoot "scripts/overnight/run-scheduled-edicao.ts"

if (-not (Test-Path $RunnerTs)) {
    Write-Error "Runner TS não encontrado: $RunnerTs"
    exit 1
}

# ---------------------------------------------------------------------------
# CLAUDE_BIN explícito (achado desta issue, complementa o #5549)
# ---------------------------------------------------------------------------
# resolveClaudeBin() (scripts/lib/resolve-claude-bin.ts) varre o PATH
# procurando o nome LITERAL "claude" sem extensão — suficiente no
# Linux/systemd (onde foi escrita, #5549), mas no Windows o executável
# instalado via npm é `claude.cmd`/`claude.ps1`, então essa varredura nunca
# resolve sozinha por aqui. CLAUDE_BIN é o escape-hatch que a própria
# função já expõe pra este caso — mais barato que ensinar resolveClaudeBin
# sobre extensões do Windows para um único chamador.
$ClaudeCmd = Get-Command "claude" -ErrorAction SilentlyContinue
if ($ClaudeCmd) {
    $env:CLAUDE_BIN = $ClaudeCmd.Source
} else {
    Write-Warning "claude CLI não encontrado no PATH desta sessão do Task Scheduler. run-scheduled-edicao.ts vai falhar ao resolver o binário, com mensagem acionável no log (data/overnight-schedule.log)."
}

# ---------------------------------------------------------------------------
# Invocar o runner TS — toda a lógica (data D+1, guard de idempotência,
# invocação do claude, logging) vive lá; ver docstring do topo.
# ---------------------------------------------------------------------------
Set-Location $RepoRoot
& npx tsx $RunnerTs
exit $LASTEXITCODE
