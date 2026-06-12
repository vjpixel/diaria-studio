---
name: diaria-6-agendamento
description: Roda a Etapa 6 (agendamento — gate humano + Schedule Beehiiv + auto-reporter). Uso — `/diaria-6-agendamento [AAMMDD]`.
---

# /diaria-6-agendamento

Dispara a Etapa 6: apresenta resumo de agendamento ao editor, aguarda confirmacao, executa o Schedule do Beehiiv e roda o auto-reporter.

## Argumentos

- `AAMMDD` (opcional) — se omitido, rodar `npx tsx scripts/lib/find-current-edition.ts --stage 6` e parsear `candidates[]` do JSON de saida (#583):
  - **Se `candidates.length === 1`**: assumir essa edicao. Logar info: `Assumindo edicao em curso: {AAMMDD}`.
  - **Se `candidates.length === 0`**: erro. `Nenhuma edicao com Stage 5 (Publicacao) aprovado e Stage 6 incompleto. Rode /diaria-5-publicacao primeiro ou passe AAMMDD explicitamente.`
  - **Se `candidates.length >= 2`**: perguntar ao editor qual.

Critico: este e o stage que **agenda** a newsletter no Beehiiv; rodar na edicao errada causa agendamento de conteudo incorreto.

## Pre-requisitos

- Etapas 1-5 completas: `_internal/.step-5-done.json` + `_internal/05-published.json` com `draft_url`.
- Chrome com extensao **Claude in Chrome** ativa, logado em Beehiiv.
- `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` configurados para Drive sync (relatorio final).

## O que faz

Voce (top-level Claude Code) **le `.claude/agents/orchestrator-stage-6.md` como playbook e executa diretamente**.

### Etapa 6a — Pre-requisitos + leitura de estado

Ler `_internal/05-published.json` e `_internal/06-social-published.json` para compor o resumo de agendamento.

### Etapa 6b — GATE HUMANO

Apresentar resumo consolidado ao editor:
```
📅 AGENDAMENTO — Edicao {AAMMDD}

Newsletter (rascunho): {draft_url}
Test email:            {status}
Social agendado:       LinkedIn+Facebook por destaque

Agendar envio da newsletter no Beehiiv?
  sim [HH:MM]  → agenda (default: amanha 06:00 BRT)
  abortar      → nao agenda; rascunho permanece
```

Se `--no-gates`: pular o gate e auto-agendar com o default (amanha 06:00 BRT).

### Etapa 6c — Schedule do Beehiiv + verificacao

Executar Schedule seguindo `context/publishers/beehiiv-playbook.md` §9-10. Verificar estado via `scripts/verify-scheduled-post.ts` (#2074).

### Etapa 6d — Auto-reporter + relatorio

Coletar sinais (`collect-edition-signals.ts`), disparar `auto-reporter`, enviar relatorio por email (`send-edition-report.ts`).

## Output

- `_internal/05-published.json` atualizado com `scheduled_at` + `status: "scheduled"`
- `_internal/.step-6-done.json` (sentinel)
- `_internal/issues-draft.json` (se auto-reporter rodou)
- `_internal/edition-report.html`

## Notas

- **Proximo passo → /diaria-edicao** encerrado. Pipeline 0-6 completo.
- **Resume-aware**: re-rodar pula o que ja existe (se `.step-6-done.json` presente, pipeline encerrado).
- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
