# Histórico de incidentes — Stage 0 (Preflight)

Narrativa histórica extraída de `.claude/agents/orchestrator-stage-0-preflight.md`
(#4816 — prova de conceito da separação narrativa/operacional). A instrução
operacional atual permanece no playbook; este arquivo preserva só o "porquê"
— o incidente ou decisão passada que levou ao comportamento de hoje.

Cada seção referencia a âncora correspondente no playbook (`§0d`, `§0d.bis`,
etc.) para quem quiser ver a instrução viva ao lado do histórico.

## §0d — Refresh automático de dedup (#895)

Antes do #895, o refresh de dedup rodava via um subagente legado
(`refresh-dedup-runner`) que apontava para um UUID antigo de MCP que não
existe mais. Rodar o refresh inline no top-level via REST API direta (a
solução atual) corrigia essa dependência quebrada, mas nesse meio-tempo o
agent legado pulava a regeneração de `data/past-editions.md`, regredindo o
#162 (dedup ficava com base desatualizada sem sinalizar erro).

## §0d.bis — Maintain valid_editions window (#1233)

O script atual (`maintain-valid-editions-window.ts`) substitui o legado
`add-valid-edition.ts`, que só adicionava a edição corrente ao set no KV.
Caso real, 2026-05-13 (#1233): rodar o script legado contra um set vazio
criava um estado degenerado `[hoje]` — o gate de votos do Worker `poll`
passava a aceitar votos **apenas** da edição de hoje, rejeitando todas as
anteriores (subscribers que clicassem em emails de dias anteriores recebiam
410). A correção — manter uma janela de 7 dias de edições publicadas + a
corrente — é a instrução operacional vigente.

## §0d.bis — HALT obrigatório em exit 2 (#1366)

Até 260518, um `read_failed=true` (exit 2 de `maintain-valid-editions-window.ts`,
tipicamente KV virgem ou wrangler offline) era tratado como warn-and-continue.
Caso real, 260519: esse comportamento permitiu que 482 subscribers recebessem
o email da edição com botões de voto A/B que, ao serem clicados, retornariam
410 ("Essa edição não aceita mais votos") — rejeição silenciosa de **todos os
votos** da edição em produção, sem que ninguém no pipeline soubesse até o
editor notar externamente. Desde #1366, esse cenário (e qualquer exit `!=0`
do script) é HALT obrigatório — inclusive em `auto_approve = true` — até o
editor rodar `add-valid-edition.ts` manualmente uma vez para popular o set.

## §0b-bis — Auto-capture newsletters, guard determinístico (#2878)

Caso real: em 260703, no 2º dia seguido de erro `invalid_client` no OAuth do
Gmail, `captured_newsletter_count: 0` era indistinguível de "o editor
genuinamente não enviou newsletter nenhuma naquele dia" — a coverage line do
Stage 2 e o gate do Stage 4 reportavam simplesmente "0 submissões", sem
qualquer sinal de que a causa real era uma falha silenciosa de credencial (e
não ausência de conteúdo). Desde #2878, o script de captura grava um sentinel
de falha explícito (`_internal/.capture-newsletter-failed.json`) que o Stage 1
propaga para o marker de inject-inbox-urls — a coverage line troca "0
submissões" por um aviso explícito de indisponibilidade nesse cenário.
