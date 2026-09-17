---
name: diaria-6-agendamento
description: Roda a Etapa 6 (agendamento — gate humano + Schedule Beehiiv + auto-reporter). Desde #7983 o caminho normal é `/diaria-5-publicacao` encadear pra cá sozinho na mesma sessão — use este comando pra RETOMAR quando isso não aconteceu. Uso — `/diaria-6-agendamento [AAMMDD]`.
---

# /diaria-6-agendamento

Dispara a Etapa 6: apresenta resumo de agendamento ao editor, aguarda confirmacao, executa o Schedule do Beehiiv e roda o auto-reporter.

## Porta de retomada (#7983, 11/09/2026)

Desde a fusão 5+6, o caminho normal é `/diaria-5-publicacao` continuar direto pra este stage, na mesma sessão, sem o editor precisar digitar um segundo comando. Esta skill continua existindo pra RETOMAR quando isso não aconteceu — a sessão morreu entre o dispatch e o gate, o editor saiu e voltou horas depois, ou é um retry do agendamento em si. Nesses casos ela funciona exatamente como antes: lê o sentinel do Stage 5 do disco e segue normal a partir daqui.

## Argumentos

- `AAMMDD` (opcional) — se omitido, rodar `npx tsx scripts/lib/find-current-edition.ts --stage 6` e parsear `candidates[]` do JSON de saida (#583):
  - **Se `candidates.length === 1`**: assumir essa edicao. Logar info: `Assumindo edicao em curso: {AAMMDD}`.
  - **Se `candidates.length === 0`**: erro. `Nenhuma edicao com Stage 5 (Publicacao) aprovado e Stage 6 incompleto. Rode /diaria-5-publicacao primeiro ou passe AAMMDD explicitamente.`
  - **Se `candidates.length >= 2`**: default (#5321) — assumir a mais recente (`candidates[candidates.length - 1]`, lista vem ordenada ascendente) e imprimir banner: `Múltiplas edições em curso: {lista}. Assumindo a mais recente: {AAMMDD}. Passe AAMMDD explicitamente para outra.` Editor pode interromper se errado.

Critico: este e o stage que **agenda** a newsletter no Beehiiv; rodar na edicao errada causa agendamento de conteudo incorreto.

## Pre-requisitos

- Etapas 1-5 completas: `_internal/.step-5-done.json` + `_internal/05-published.json` com `draft_url`.
- Chrome com extensao **Claude in Chrome** ativa, logado em Beehiiv.
- `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` configurados para Drive sync (relatorio final).

## O que faz

Voce (top-level Claude Code) **le `.claude/agents/orchestrator-stage-6.md` como playbook e executa diretamente**.

### Etapa 6a — Pre-requisitos + leitura de estado

Ler `_internal/05-published.json` e `_internal/06-social-published.json` para compor o resumo de agendamento.

### Etapa 6b — GATE HUMANO ÚNICO (#8205)

**A revisão visual do e-mail de teste pelo editor é a única parada desta skill.** Apresentar o gate único (texto completo e mecanismo em `.claude/agents/orchestrator-stage-6.md` §6c) — pede pra conferir o e-mail de teste na caixa (`publishing.newsletter.test_email`), mostra o resumo consolidado (rascunho, review automático + lints, social agendado, avisos de guard de slug/pedidos editoriais como contexto, nunca como perguntas separadas) e aceita:

```
  ok           → agenda para 06:00 BRT do dia da edição (default)
  ok HH:MM     → agenda para {horario informado} BRT do dia da edição
  abortar      → nao agenda nada; rascunho permanece
```

Se `--no-gates`: pular o gate e auto-agendar com o default (06:00 BRT **da data da edição**, via `resolve-edition-scheduled-at.ts` — nunca "amanhã" pelo relógio, #8207).

### Etapa 6c — Schedule (Beehiiv ou Kit) + verificacao

Executar Schedule seguindo `context/publishers/beehiiv-playbook.md` §9-10 (backend Beehiiv) ou `schedule-newsletter-kit.ts` (backend Kit). Verificar estado via `scripts/verify-scheduled-post.ts` (#2074). O guard de slug do bloco WhatsApp já rodou ANTES do gate (§6b-slug) — se divergiu, o editor já viu o aviso no gate e decidiu seguir; não há um 2º ponto de parada aqui (#8205).

### Etapa 6d — Auto-reporter (sem gate, #8205) + relatorio

Coletar sinais (`collect-edition-signals.ts`), disparar `auto-reporter` — cria/comenta issues diretamente, sem esperar aprovação (decisão coberta pela regra "nunca perguntar se deve criar issue" do CLAUDE.md) —, enviar relatorio por email (`send-edition-report.ts`).

## Output

- `_internal/05-published.json` atualizado com `scheduled_at` + `status: "scheduled"`
- `_internal/.step-6-done.json` (sentinel)
- `_internal/issues-draft.json` (se auto-reporter rodou)
- `_internal/edition-report.html`

## Notas

- **Proximo passo → /diaria-edicao** encerrado. Pipeline 0-6 completo.
- **Resume-aware**: re-rodar pula o que ja existe (se `.step-6-done.json` presente, pipeline encerrado).
- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
