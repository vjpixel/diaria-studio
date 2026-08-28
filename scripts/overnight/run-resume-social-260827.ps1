<#
.SYNOPSIS
    Wrapper Windows Task Scheduler — dispara UMA VEZ, retoma o dispatch
    social da edição 260827 (#6323/#6343) assim que o envio real do Kit
    tiver acontecido (broadcast_id 25622689, scheduled_at 2026-08-27T09:00:00Z).

.DESCRIPTION
    Mesmo padrão de scripts/overnight/run-scheduled-edicao.ps1 (transcript,
    resolução de CLAUDE_BIN), mas one-off: delega toda a lógica pra
    scripts/overnight/resume-social-dispatch-260827.ts, script ESPECÍFICO
    desta edição (não genérico), que já faz o poll do status do broadcast,
    o dispatch dos canais via script, e spawna uma sessão `claude --print`
    pra Twitter/Buffer MCP + fechar Stage 5/6.

    A task registrada por scripts/overnight/setup-resume-social-260827.ps1
    é um disparo ÚNICO (-Once) — não precisa de remoção manual depois,
    mas fica registrada no Task Scheduler até ser limpa (histórico).

.NOTES
    Issue: #6323 (achado ao vivo), #6343 (arquitetura definitiva)
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir "../..")).Path
$RunnerTs  = Join-Path $RepoRoot "scripts/overnight/resume-social-dispatch-260827.ts"
$LogPath   = Join-Path $RepoRoot "data/task-scheduler-resume-social-260827.log"

try {
    Start-Transcript -Path $LogPath -Append -ErrorAction Stop | Out-Null
} catch {
    Write-Warning "Não foi possível iniciar o transcript em $LogPath — continuando sem log de Task Scheduler."
}

$ExitCode = 1
try {
    if (-not (Test-Path $RunnerTs)) {
        Write-Error "Runner TS não encontrado: $RunnerTs"
        exit 1
    }

    $AllClaudeCmds = @(Get-Command "claude" -ErrorAction SilentlyContinue)
    $ClaudeCmd = $AllClaudeCmds | Select-Object -First 1
    if ($ClaudeCmd) {
        if ($AllClaudeCmds.Count -gt 1) {
            Write-Warning "Múltiplas instalações de 'claude' no PATH ($($AllClaudeCmds.Count)) — usando $($ClaudeCmd.Source)."
        }
        $env:CLAUDE_BIN = $ClaudeCmd.Source
    } else {
        Write-Warning "claude CLI não encontrado no PATH desta sessão do Task Scheduler."
    }

    Set-Location $RepoRoot
    & npx tsx $RunnerTs
    $ExitCode = $LASTEXITCODE
} finally {
    try { Stop-Transcript | Out-Null } catch {}
}

exit $ExitCode
