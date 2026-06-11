---
name: diaria-4-publicar
description: "[ALIAS RETROCOMPAT #1694] Roda Etapa 4 (Revisão) + Etapa 5 (Publicação) em sequência — equivalente ao comportamento antigo do /diaria-4-publicar. Para uso isolado, prefira /diaria-4-revisao ou /diaria-5-publicar."
---

# /diaria-4-publicar — alias retrocompat (#1694)

> **Esta skill foi dividida em duas** pelo #1694 (Stage Split):
>
> - **`/diaria-4-revisao AAMMDD`** — Revisão editorial assistida (pré-render HTML + resumo consolidado + gate humano pré-publicação)
> - **`/diaria-5-publicar AAMMDD`** — Publicação paralela (Beehiiv + LinkedIn + Facebook + auto-reporter)
>
> `/diaria-4-publicar` continua funcionando como atalho retrocompat: executa as duas etapas em sequência, replicando o comportamento anterior completo.

## O que este alias faz

Ao invocar `/diaria-4-publicar [args] [AAMMDD]`, você (top-level Claude Code) deve:

1. **Rodar `/diaria-4-revisao AAMMDD`** — lê `.claude/agents/orchestrator-stage-4.md` como playbook e executa a Revisão editorial (pré-render técnico + resumo consolidado + gate humano).

2. **Se aprovado** (sentinel `_internal/.step-4-done.json` gravado): **rodar `/diaria-5-publicar AAMMDD [--skip ...]`** — lê `.claude/agents/orchestrator-stage-5.md` como playbook e executa a Publicação.

3. **Se o editor abortar** no gate da Revisão (resposta `abortar`): encerrar sem iniciar a Publicação.

## Argumentos passados automaticamente

- `AAMMDD` — encaminhar como-está para ambas as skills.
- `--skip {canais}` — encaminhar apenas para `/diaria-5-publicar` (Stage 5 é o publicador).
- `--no-gates` — encaminhar para `/diaria-4-revisao` (pula gate de revisão) e para `/diaria-5-publicar` (pula confirmação interativa de canais).
- `all|newsletter|social` — encaminhar apenas para `/diaria-5-publicar`.

## Resolução de AAMMDD omitido

Se AAMMDD não foi passado, usar `/diaria-4-revisao` sem data — essa skill detecta a edição em curso via `find-current-edition.ts --stage 4` e pede confirmação ao editor antes de qualquer ação.

## Notas

- **Resume-aware**: se `.step-4-done.json` já existir ao entrar, pular direto para Stage 5.
- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
