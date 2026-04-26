---
name: diaria-6-publicar
description: Roda o Stage 5 unificado (publish paralelo — newsletter Beehiiv + 6 posts sociais) com gate único, e Stage 6 (auto-reporter). Uso — `/diaria-6-publicar [all|newsletter|social] AAMMDD`.
---

# /diaria-6-publicar

Dispara o Stage 5 unificado (publish paralelo: Beehiiv + Facebook + LinkedIn em paralelo, gate único) e em seguida o Stage 6 (auto-reporter).

## Argumentos

- `/diaria-6-publicar all AAMMDD` — roda Stage 5 (paralelo) + Stage 6 (auto-reporter)
- `/diaria-6-publicar newsletter AAMMDD` — re-dispara só `publish-newsletter` (Beehiiv); útil pra fix isolado após template errado
- `/diaria-6-publicar social AAMMDD` — re-dispara só `publish-facebook` + `publish-social`; útil pra retry de social falhado sem regerar Beehiiv

**Se não passar data, perguntar explicitamente** ao usuário antes de prosseguir — nunca inferir a partir de `today()`. Crítico aqui: este é o stage **publicador** (Beehiiv + LinkedIn + Facebook); rodar na edição errada causa publicação real de conteúdo desatualizado. Sugerir hoje/ontem como atalhos mas exigir confirmação.

## Pré-requisitos

- Stages 1–4 completos: `02-reviewed.md`, `03-social.md`, `01-eai.md` + `01-eai.jpg`, `04-d{1,2,3}.jpg`
- Chrome com extensão **Claude in Chrome** ativa (ver `docs/browser-publish-setup.md`)
- Logado em Beehiiv, LinkedIn e Facebook (Meta Business Suite) no Chrome
- Bloco `publishing` em `platform.config.json` configurado
- `FACEBOOK_PAGE_ACCESS_TOKEN` no env pra Graph API

## O que faz

### Stage 5 — Publish paralelo (#38)

**3 dispatches em uma única mensagem** (ver `.claude/agents/orchestrator.md` § 5b):
1. `publish-facebook.ts` (Graph API, ~30s)
2. `publish-newsletter` (Chrome → Beehiiv) — cria rascunho + envia email de teste
3. `publish-social` (Chrome → LinkedIn) — 3 LinkedIn drafts

Cada agent Chrome usa tab isolada (`tabs_create_mcp`) — sem conflito.

Após todos retornarem, **loop de review-test-email** roda em cima do draft Beehiiv (não bloqueia social, que já está pronto).

**Gate único**: URL Beehiiv + status do test email + tabela 6 social posts + checklist de upload manual de imagens. Editor aprova → segue Stage 6.

### Stage 6 — Auto-reporter (#57 / #79)

1. Coleta sinais da edição (`collect-edition-signals.ts`).
2. Se `signals_count > 0` e não é test_mode: dispara agent `auto-reporter` (gate humano de issues GitHub).
3. Pula auto-reporter se test_mode/auto_approve.

## Output

- `05-published.json` — `draft_url`, `test_email_sent_at`, `template_used`, `review_completed`
- `06-social-published.json` — 6 posts com `platform`, `destaque`, `url`, `status`, `scheduled_at`
- `_internal/issues-draft.json` (se Stage 6 rodou) — sinais coletados

## Notas

- **Nada é publicado automaticamente.** Newsletter vira rascunho + teste; social vira rascunho ou agendado. Editor dispara manualmente.
- **Resume-aware**: re-rodar pula o que já existe (newsletter rascunho, social posts).
- **Tab isolation**: agents Chrome usam tabs próprias — sem conflito mesmo rodando em paralelo.
- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
