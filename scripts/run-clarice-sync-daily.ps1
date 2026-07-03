<#
.SYNOPSIS
    Wrapper do sync incremental diário do store Clarice (para o Task Scheduler).

.DESCRIPTION
    Roda `npx tsx scripts/clarice-sync-brevo.ts --incremental` no repo root e loga
    stdout+stderr em data/clarice-subscribers/.brevo-sync-daily.log (append, com
    header/rodapé por run). Sai com o exit code do sync (o Task Scheduler registra
    sucesso/falha). Requer BREVO_CLARICE_API_KEY no .env local + o junction data/.

    Registrado pela task "Diaria-Clarice-Sync" (setup-clarice-sync-schedule.ps1).

.NOTES
    Issue: #2932 (sync incremental: #2928).
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$SyncTs    = Join-Path $RepoRoot "scripts\clarice-sync-brevo.ts"
$Log       = Join-Path $RepoRoot "data\clarice-subscribers\.brevo-sync-daily.log"

Set-Location $RepoRoot

"" | Out-File -FilePath $Log -Append -Encoding utf8
"===== $(Get-Date -Format o) - clarice-sync-brevo --incremental =====" | Out-File -FilePath $Log -Append -Encoding utf8

# *>> = redireciona TODOS os streams (stdout+stderr+warning+...) em append pro log.
& npx tsx "$SyncTs" --incremental *>> $Log
$code = $LASTEXITCODE

"===== fim (exit $code) =====" | Out-File -FilePath $Log -Append -Encoding utf8
exit $code
