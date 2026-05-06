---
name: diaria-4-publicar
description: Roda a Etapa 4 (publicação paralela — newsletter Beehiiv + 6 posts sociais) com gate único, e auto-reporter. Uso — `/diaria-4-publicar [all|newsletter|social] AAMMDD`.
---

# /diaria-4-publicar

Dispara a Etapa 4 unificada (publicação paralela: Beehiiv + Facebook + LinkedIn em paralelo, gate único) e em seguida o auto-reporter.

## Argumentos

- `/diaria-4-publicar all AAMMDD` — roda publicação paralela + auto-reporter
- `/diaria-4-publicar newsletter AAMMDD` — re-dispara só `publish-newsletter` (Beehiiv); útil pra fix isolado após template errado
- `/diaria-4-publicar social AAMMDD` — re-dispara só `publish-facebook` + `publish-social`; útil pra retry de social falhado sem regerar Beehiiv

**Se não passar data, perguntar explicitamente** ao usuário antes de prosseguir — nunca inferir a partir de `today()`. Crítico aqui: este é o stage **publicador** (Beehiiv + LinkedIn + Facebook); rodar na edição errada causa publicação real de conteúdo desatualizado. Sugerir hoje/ontem como atalhos mas exigir confirmação.

## Pré-requisitos

- Etapas 1–3 completas: `02-reviewed.md`, `03-social.md`, `01-eia.md` + `01-eia.jpg`, `04-d{1,2,3}.jpg`
- Chrome com extensão **Claude in Chrome** ativa (ver `docs/browser-publish-setup.md`)
- Logado em Beehiiv, LinkedIn e Facebook (Meta Business Suite) no Chrome
- Bloco `publishing` em `platform.config.json` configurado
- `FACEBOOK_PAGE_ACCESS_TOKEN` no env pra Graph API

## Passo 0 — Confirmar modo de publicação antes de qualquer dispatch (#336)

**OBRIGATÓRIO — executar antes de qualquer Agent ou Bash de publicação.** Perguntar explicitamente ao editor por canal:

```
Modo de publicação para esta edição:

  [1] Beehiiv automático  — Claude in Chrome cria rascunho + envia email de teste
  [2] Beehiiv manual      — você faz o paste no Beehiiv; arquivo está em data/editions/{AAMMDD}/02-reviewed.md
  [3] LinkedIn automático — Make.com webhook agenda/posta 3 posts (#506)
  [4] LinkedIn manual     — você posta; copy em data/editions/{AAMMDD}/03-social.md
  [5] Facebook automático — Graph API agenda os 3 posts
  [6] Facebook manual     — você posta; copy em data/editions/{AAMMDD}/03-social.md

Digite os números separados por vírgula (ex: "1,3,5" pra tudo automático)
ou "all" pra automático em tudo, ou "none" pra encerrar sem publicar:
```

Default se o editor não responder explicitamente = **manual em tudo** (não publicar nada automaticamente).

Aguardar resposta antes de prosseguir. Só dispatchar os agents/scripts que o editor autorizou.

## O que faz

### Etapa 4a.0 — Pre-upload de imagens sociais pro Drive (#725)

**Executar antes do dispatch paralelo** — LinkedIn precisa de URL pública pra `image_url` no payload Make.com. O upload é rápido (~2s por imagem, 3 imagens) e popula o cache `{edition_dir}/06-public-images.json`.

```bash
npx tsx scripts/upload-images-public.ts \
  --edition-dir data/editions/{AAMMDD}/ \
  --mode social
```

Resume-aware: re-execuções pularão imagens já no cache. Falha = **warning**, nunca bloqueia — `publish-linkedin.ts` faz graceful fallback pra `null` se o cache não existir (comportamento anterior: post sem imagem).

### Etapa 4a — Publicação paralela (#38)

**3 dispatches em uma única mensagem** (ver `.claude/agents/orchestrator.md` § Etapa 4):
1. `publish-facebook.ts --schedule` (Graph API, ~30s) — `--schedule` é obrigatório (#503); nunca chamar sem essa flag
2. `publish-newsletter` (Chrome → Beehiiv) — cria rascunho + envia email de teste
3. `publish-linkedin.ts` (Make.com webhook → LinkedIn company page) — 3 posts (#506):
   ```bash
   npx tsx scripts/publish-linkedin.ts --edition-dir data/editions/{AAMMDD} --schedule
   ```

LinkedIn não usa mais Chrome — sem necessidade de tab isolada para LinkedIn.

Após todos retornarem, **loop de review-test-email** roda em cima do draft Beehiiv (não bloqueia social, que já está pronto).

**Gate único**: URL Beehiiv + status do test email + tabela 6 social posts + checklist de upload manual de imagens. Editor aprova → segue auto-reporter.

### Etapa 4b — Auto-reporter (#57 / #79)

1. Coleta sinais da edição (`collect-edition-signals.ts`).
2. Se `signals_count > 0` e não é test_mode: dispara agent `auto-reporter` (gate humano de issues GitHub).
3. Pula auto-reporter se test_mode/auto_approve.

## Output

- `05-published.json` — `draft_url`, `test_email_sent_at`, `template_used`, `review_completed`
- `06-social-published.json` — 6 posts com `platform`, `destaque`, `url`, `status`, `scheduled_at`
- `_internal/issues-draft.json` (se auto-reporter rodou) — sinais coletados

## Notas

- **Nada é publicado automaticamente.** Newsletter vira rascunho + teste; social vira rascunho ou agendado. Editor dispara manualmente.
- **Resume-aware**: re-rodar pula o que já existe (newsletter rascunho, social posts).
- **Tab isolation**: agents Chrome usam tabs próprias — sem conflito mesmo rodando em paralelo.
- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
