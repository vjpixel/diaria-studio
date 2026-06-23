---
name: diaria-5-publicacao
description: Roda a Etapa 5 (publicacao auto — draft Beehiiv + Facebook/LinkedIn agendados). Sem gate. Uso — `/diaria-5-publicacao [all|newsletter|social] AAMMDD`.
---

# /diaria-5-publicacao

Dispara a Etapa 5 unificada (publicação paralela: Beehiiv + Facebook + LinkedIn em paralelo, gate único) e em seguida o auto-reporter.

## Argumentos

- `/diaria-5-publicacao all AAMMDD` — roda publicação paralela + auto-reporter
- `/diaria-5-publicacao newsletter AAMMDD` — re-dispara só `publish-newsletter` (Beehiiv); útil pra fix isolado após template errado
- `/diaria-5-publicacao social AAMMDD` — re-dispara só `publish-facebook` + `publish-linkedin`; útil pra retry de social falhado sem regerar Beehiiv

**Opt-out por canal (#1326):** flag `--skip {newsletter,linkedin,facebook}` (CSV) ignora dispatch dos canais listados. Default = tudo auto. Exemplos:
- `/diaria-5-publicacao AAMMDD --skip newsletter` — só social automático, newsletter manual
- `/diaria-5-publicacao AAMMDD --skip linkedin,facebook` — só newsletter automático
- `/diaria-5-publicacao AAMMDD --skip newsletter,linkedin,facebook` — tudo manual

Se não passar data, rodar `npx tsx scripts/lib/find-current-edition.ts --stage 5` e parsear `candidates[]` do JSON de saída (#583):
  - **Se `candidates.length === 1`**: assumir essa edição. Logar info: `Assumindo edição em curso: {AAMMDD}`. Editor pode interromper se errado.
  - **Se `candidates.length === 0`**: erro. `Nenhuma edição com Stage 4 (Revisão) aprovado e Stage 5 incompleto. Rode /diaria-4-revisao primeiro ou passe AAMMDD explicitamente.`
  - **Se `candidates.length >= 2`**: perguntar ao editor qual.

Crítico: este é o stage **publicador** (Beehiiv + LinkedIn + Facebook); rodar na edição errada causa publicação real de conteúdo desatualizado.

## Pré-requisitos

- Etapas 1–4 completas: `02-reviewed.md`, `03-social.md`, `01-eia.md` + `01-eia-A/B.jpg`, `04-d{1,2,3}*.jpg`
- `_internal/newsletter-final.html` (pré-renderizado pelo Stage 4)
- Chrome com extensão **Claude in Chrome** ativa (ver `docs/browser-publish-setup.md`)
- Logado em Beehiiv, LinkedIn e Facebook (Meta Business Suite) no Chrome
- Bloco `publishing` em `platform.config.json` configurado
- `FACEBOOK_PAGE_ACCESS_TOKEN` no env pra Graph API

## Passo -2 — Pre-flight CORS check (#1132 P2.4)

```bash
npx tsx scripts/check-worker-cors.ts --worker-url https://poll.diaria.workers.dev
```

- Se `ok: true` → prosseguir normalmente.
- Se `ok: false` → halt + sugerir: "Worker CORS faltando. Faça `cd workers/poll && npx wrangler deploy` e re-rode."

## Passo -1 — Task tracking setup (#904)

**Defensive cleanup**: varrer `TaskList()` e marcar como `completed` qualquer task `in_progress` de Stages anteriores (`Stage 0*` a `Stage 4*`). Em seguida, criar tasks pra esta etapa: `Stage 5a — confirm channels`, `Stage 5b — dispatch publishers`, `Stage 5c — review-test-email loop`, `Stage 5d — gate humano final`, `Stage 5e — auto-reporter`. **No-op se TaskCreate/TaskUpdate não estiver disponível**.

## Passo 0 — Confirmar modo de publicação antes de qualquer dispatch (#336, invertido em #1326)

**Default = tudo automático** (#1326). Editor pode opt-out por canal via flag `--skip` ou via gate interativo.

**Path 1 — flag `--skip` foi passado:**
```bash
npx tsx scripts/build-publish-consent.ts --edition {AAMMDD} --skip "{lista}"
```

**Path 2 — `auto_approve = true` (via `/diaria-edicao --no-gates`):**
```bash
npx tsx scripts/build-publish-consent.ts --edition {AAMMDD} --auto-approve
```

**Path 3 — gate interativo (sem `--skip` e sem `auto_approve`):**

```
Modo de publicação para esta edição (default = tudo automático):

  [1] Beehiiv automático  — top-level segue context/publishers/beehiiv-playbook.md
  [2] Beehiiv manual      — você faz o paste no Beehiiv
  [3] LinkedIn automático — Worker queue + Make webhook (agenda 17:00 BRT)
  [4] LinkedIn manual     — você posta; copy: data/editions/{AAMMDD}/03-social.md
  [5] Facebook automático — Graph API agenda os 3 posts
  [6] Facebook manual     — você posta; copy: data/editions/{AAMMDD}/03-social.md

Digite os números separados por vírgula (ex: "1,3,5" pra tudo automático)
ou "all" pra automático em tudo, ou "none" pra encerrar sem publicar.
Default se não responder = TUDO AUTOMÁTICO (#1326).
```

## O que faz

Você (top-level Claude Code) **lê `.claude/agents/orchestrator-stage-5.md` como playbook e executa diretamente**.

### Etapa 5a — Pre-flight poll + upload de imagens sociais

```bash
npx tsx scripts/preflight-poll-dispatch.ts --edition {AAMMDD}
npx tsx scripts/upload-images-public.ts --edition-dir data/editions/{AAMMDD}/ --mode social
```

### Etapa 5b — Publicação paralela (#38)

**Em uma única mensagem dispatcham 2 scripts em paralelo + você (top-level) executa o playbook newsletter:**

1. `publish-facebook.ts --schedule` (Graph API, ~30s)
2. `publish-linkedin.ts --schedule` (Worker queue + Make webhook × 3)
3. **Newsletter Beehiiv (#1054 / #207 / #1114)**: você lê `context/publishers/beehiiv-playbook.md` e executa direto. **Não tente dispatchar via `Agent`** — `javascript_tool` é restrito ao top-level. **⚠️ DEGRADADO desde 260623 (#2495) — o fetch da Fase 3 (in-page) está bloqueado por CSP; o upload da Fase 2 ainda funciona. O auto-fallback não dispara (fetch pendura com exit 0), então selecione o chunked base64 (apêndice do playbook) manualmente enquanto o bloqueio persistir (#2500). Editor finaliza metadata na UI. Ver playbook para instruções.**

Após todos retornarem, **loop de review-test-email** roda em cima do draft Beehiiv.

**Gate único** (legacy `pre_gate = false`) ou **auto-approve** (quando `pre_gate = true` e aprovação ocorreu no Stage 4).

### Etapa 5c — Resumo e encaminhamento ao Stage 6

Stage 5 encerra com o dispatch completo (newsletter draft + social agendado). Auto-reporter e relatorio por email foram movidos para o **Stage 6 (Agendamento)** — rodam apos o editor confirmar o Schedule do Beehiiv.

## Output

- `_internal/05-published.json` — `draft_url`, `test_email_sent_at`, `template_used`, `review_completed`
- `_internal/06-social-published.json` — 6 posts com `platform`, `destaque`, `url`, `status`, `scheduled_at`
- `_internal/.step-5-done.json` — sentinel de conclusao do Stage 5

Auto-reporter + relatorio por email → Stage 6 (`/diaria-6-agendamento`).

## Notas

- **Newsletter fica como rascunho.** Test email enviado, loop review concluido. O Schedule Beehiiv e feito no Stage 6 (`/diaria-6-agendamento`). Social (LinkedIn + Facebook) e agendado automaticamente (`--schedule`).
- **Resume-aware**: re-rodar pula o que ja existe.
- **Proximo passo → /diaria-6-agendamento {AAMMDD}** — agendamento Beehiiv + auto-reporter.
- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
