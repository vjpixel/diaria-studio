<#
.SYNOPSIS
    Registra (ou remove) a task "Diaria-SEO-Weekly" no Task Scheduler — loop de
    SEO semanal, segunda-feira as 04:10.

.DESCRIPTION
    Cria uma tarefa agendada que roda `run-seo-weekly.ps1` (seo-index-check +
    seo-pull) toda segunda as 04:10 — off-peak, depois do sync Clarice (03:40).

    Semanal (nao diario) de proposito: indexacao se move em dias/semanas, e a
    URL Inspection API tem quota de 2.000/dia. Uma rodada gasta ~223.

    StartWhenAvailable: se o horario for perdido (maquina desligada), roda
    quando disponivel. Idempotente: re-executar substitui a task.
    Use -Unregister para remover.

    *** Rodar SO no clone permanente do repo (path derivado do diretorio deste
    script). Em worktree temporario o path muda e a task apontaria pra um
    diretorio deletado. ***

.PARAMETER Unregister
    Remove a task "Diaria-SEO-Weekly".

.EXAMPLE
    # Registrar (ou atualizar):
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-seo-schedule.ps1

    # Remover:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-seo-schedule.ps1 -Unregister

.NOTES
    Issue: #4105 (loop de SEO: #1896).
    Requer: Windows + Task Scheduler + junction data/ + data/.credentials.json.
    Sem Admin: a task roda no contexto do usuario (RunLevel Limited).
#>
param(
    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$WrapperPs1 = Join-Path $RepoRoot "scripts\run-seo-weekly.ps1"

$TaskName = "Diaria-SEO-Weekly"
$TaskDesc = "Diar.ia: loop de SEO semanal (#4105) - segunda 04:10, cobertura de indexacao + Search Analytics."

if (-not (Test-Path $WrapperPs1)) {
    Write-Error "Wrapper nao encontrado: $WrapperPs1"
    exit 1
}

if ($Unregister) {
    $Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($Existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "Task '$TaskName' removida."
    } else {
        Write-Output "Task '$TaskName' nao encontrada (ja removida ou nunca registrada)."
    }
    exit 0
}

$Action = New-ScheduledTaskAction `
    -Execute  "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$WrapperPs1`"" `
    -WorkingDirectory $RepoRoot

# Segunda-feira as 04:10 (semanal; ver .DESCRIPTION pra o porque de nao ser diario).
$Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At (Get-Date -Hour 4 -Minute 10 -Second 0)

$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit   (New-TimeSpan -Hours 2) `
    -MultipleInstances    IgnoreNew `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

# Register-ScheduledTask -Force cria OU sobrescreve (idempotente) e aceita
# -Description. NAO usar Set-ScheduledTask no branch de update: ele nao tem
# parametro -Description (#3757/#3764).
$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName    $TaskName `
    -Action      $Action `
    -Trigger     $Trigger `
    -Settings    $Settings `
    -Description $TaskDesc `
    -RunLevel    Limited `
    -Force | Out-Null

# #3775: -Force substitui a task INTEIRA — qualquer propriedade nao especificada
# volta ao default, inclusive Enabled=True. Preserva o Disabled manual do editor.
if ($Existing -and $Existing.State -eq "Disabled") {
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
}

if ($Existing) {
    Write-Output "Task '$TaskName' atualizada."
} else {
    Write-Output "Task '$TaskName' registrada."
}

Write-Output ""
Write-Output "Configuracao:"
Write-Output "  Wrapper : $WrapperPs1"
Write-Output "  Repo    : $RepoRoot"
Write-Output "  Horario : segunda-feira 04:10 (semanal)"
Write-Output "  Log     : data\seo\.seo-weekly.log"
Write-Output "  Saidas  : data\seo\index-status-{data}.{json,md}, gsc-{data}.json"
