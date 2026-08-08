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

    Log resiliente + exit code honesto: molde compartilhado por
    scripts/lib/Invoke-DiariaScheduledWrapper.psm1 (#4756) -- escreve
    primeiro num arquivo temporario FORA de data/ (sem risco de lock do
    OneDrive) e so no final anexa ao log final, com retry curto.

    Registrado pela task "Diaria-Brevo-Diaria-Evaluate"
    (setup-evaluate-brevo-diaria-schedule.ps1).

.NOTES
    Issue: #4534. Modulo compartilhado: #4756.
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

Import-Module (Join-Path $ScriptDir "lib\Invoke-DiariaScheduledWrapper.psm1") -Force

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
# scripts/lib/exec-mode.ts, resolvido aqui no nivel do .ps1. Passado ao
# modulo compartilhado como -PreCheck: roda ANTES da chamada nativa e aborta
# sem invocar o script quando o guard falha.
$code = Invoke-DiariaScheduledWrapper `
    -RepoRoot $RepoRoot `
    -ScriptPath $EvaluateScript `
    -ScriptArgs @("--push") `
    -LogPath $LogPath `
    -TempLogPath $TempLogPath `
    -Label "evaluate brevo diaria" `
    -ExitCodeKey "evaluate" `
    -PreCheck {
        if (-not (Test-Path -LiteralPath $ContactsJsonPath -PathType Leaf)) {
            return "contacts.json nao encontrado ($ContactsJsonPath) -- provavel junction data/ nao montada ainda; abortando por seguranca, NAO rodando --push."
        }
        return $null
    }

exit $code
