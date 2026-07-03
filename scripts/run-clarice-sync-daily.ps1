<#
.SYNOPSIS
    Wrapper do sync incremental diário do store Clarice (para o Task Scheduler).

.DESCRIPTION
    Roda, em sequencia, no repo root:
      1. clarice-sync-brevo.ts --incremental  -> atualiza o STORE (SQLite).
      2. clarice-db-summary.ts                -> empurra o summary pra KV (DASHBOARD).
    Store e KV sao superficies SEPARADAS; sem o passo 2 o store fresco nao chega na
    dashboard. Loga tudo (UTF-8) em data/clarice-subscribers/.brevo-sync-daily.log
    (append). Sai != 0 se qualquer passo falhar (o Task Scheduler registra falha).
    Requer BREVO_CLARICE_API_KEY + creds Cloudflare no .env local + o junction data/.

    Registrado pela task "Diaria-Clarice-Sync" (setup-clarice-sync-schedule.ps1).

.NOTES
    Issue: #2932 (sync incremental: #2928).
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$SyncTs    = Join-Path $RepoRoot "scripts\clarice-sync-brevo.ts"
$SummaryTs = Join-Path $RepoRoot "scripts\clarice-db-summary.ts"
$Log       = Join-Path $RepoRoot "data\clarice-subscribers\.brevo-sync-daily.log"

Set-Location $RepoRoot

# Log em UTF-8 puro: `2>&1 | ForEach-Object { $_.ToString() }` achata os ErrorRecord
# de stderr nativo em texto (o clarice-sync escreve TODO o progresso em stderr) e
# grava via Out-File -Encoding utf8 — o `*>>` gravava o corpo em UTF-16LE e
# embrulhava cada linha de stderr num NativeCommandError multi-linha (review #2933).

Add-Content -Path $Log -Encoding utf8 -Value ""
Add-Content -Path $Log -Encoding utf8 -Value "===== $(Get-Date -Format o) - clarice sync diario ====="

# 1. Sync incremental → atualiza o STORE (SQLite).
Add-Content -Path $Log -Encoding utf8 -Value "----- clarice-sync-brevo --incremental -----"
& npx tsx "$SyncTs" --incremental 2>&1 | ForEach-Object { $_.ToString() } | Out-File -FilePath $Log -Append -Encoding utf8
$syncCode = $LASTEXITCODE

# 2. Push do summary → atualiza a DASHBOARD (KV contacts:summary). Store e KV sao
#    superficies SEPARADAS; sem este passo, o store fresco nao chega na dashboard.
Add-Content -Path $Log -Encoding utf8 -Value "----- clarice-db-summary (push KV) -----"
& npx tsx "$SummaryTs" 2>&1 | ForEach-Object { $_.ToString() } | Out-File -FilePath $Log -Append -Encoding utf8
$sumCode = $LASTEXITCODE

$code = if ($syncCode -ne 0) { $syncCode } else { $sumCode }
Add-Content -Path $Log -Encoding utf8 -Value "===== fim (sync=$syncCode summary=$sumCode) ====="
exit $code
