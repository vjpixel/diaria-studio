---
name: diaria-5-publicacao
description: Roda a Etapa 5 (publicacao auto — draft Beehiiv/Kit + LinkedIn/Facebook/Instagram/Threads/X agendados + Brevo diária/Kit diária). Sem gate. Uso — `/diaria-5-publicacao [all|newsletter|social] AAMMDD`.
---

# /diaria-5-publicacao

Dispara a Etapa 5 unificada (publicação paralela: newsletter + todos os canais sociais + canais de reativação/parceiro em paralelo, sem gate interativo) e em seguida o auto-reporter.

## Canais (#6610)

Stage 5 dispatcha, hoje, **8 canais** — lista completa em `.claude/agents/orchestrator-stage-5.md` §5c-3/5c-3b (fonte de verdade operacional; não duplicar os detalhes de cada script aqui):

1. **Newsletter** — Beehiiv (draft + test email, via `context/publishers/beehiiv-playbook.md`) OU Kit (`publish-newsletter-kit.ts --send-test`), conforme `publishing.newsletter.backend` em `platform.config.json`.
2. **LinkedIn** — `publish-linkedin.ts --schedule` (Worker `diaria-linkedin-cron` + fallback Make webhook).
3. **Facebook** — `publish-facebook.ts --schedule` (Graph API).
4. **Instagram** — `publish-instagram.ts --schedule` (mesmo Worker do LinkedIn, `channel: "instagram"`; carrossel de 5 slides quando disponível, senão post single-image).
5. **Threads** — `publish-threads.ts --schedule` (mesmo Worker, `channel: "threads"`; só posts de 1 chunk ≤500 chars).
6. **Twitter/X** — via Buffer MCP (`prep-twitter-posts.ts` + `mcp__claude_ai_Buffer__create_post`), conduzido pelo orchestrator diretamente (não é script Bash puro — só alcançável de dentro da sessão de agente).
7. **Brevo diária** — `brevo-diaria-stage5-dispatch.ts` (segmento Pending/reativação; cria só o RASCUNHO, agendamento é Stage 6).
8. **Kit diária** — `kit-diaria-stage5-dispatch.ts` (canal PARALELO ao Beehiiv/Kit newsletter — audiência exclusiva por tag `kit_diaria.audience_tag`; só roda com `consent.kit === "auto"` **e** `kit_diaria.enabled === true` em `platform.config.json`; cria só o RASCUNHO).

## Argumentos

- `/diaria-5-publicacao all AAMMDD` — roda publicação paralela (todos os canais acima) + auto-reporter
- `/diaria-5-publicacao newsletter AAMMDD` — re-dispara só a newsletter (Beehiiv ou Kit, conforme backend); útil pra fix isolado após template errado
- `/diaria-5-publicacao social AAMMDD` — re-dispara só os canais sociais (LinkedIn, Facebook, Instagram, Threads, Twitter/X); útil pra retry de social falhado sem regerar a newsletter

**Opt-out por canal (#1326):** flag `--skip {canal[,canal...]}` (CSV) ignora dispatch dos canais listados. Canais válidos: `newsletter`, `linkedin`, `facebook`, `instagram`, `threads`, `twitter`, `brevo`, `kit` (ver `VALID` em `scripts/lib/publish-consent.ts`). Default = tudo auto. Exemplos:
- `/diaria-5-publicacao AAMMDD --skip newsletter` — só canais sociais/Brevo/Kit automáticos, newsletter manual
- `/diaria-5-publicacao AAMMDD --skip linkedin,facebook,instagram,threads,twitter` — só newsletter (+Brevo/Kit) automático
- `/diaria-5-publicacao AAMMDD --skip brevo,kit` — pula os canais de reativação/parceiro nesta edição
- `/diaria-5-publicacao AAMMDD --skip newsletter,linkedin,facebook,instagram,threads,twitter,brevo,kit` — tudo manual

Se não passar data, rodar `npx tsx scripts/lib/find-current-edition.ts --stage 5` e parsear `candidates[]` do JSON de saída (#583):
  - **Se `candidates.length === 1`**: assumir essa edição. Logar info: `Assumindo edição em curso: {AAMMDD}`. Editor pode interromper se errado.
  - **Se `candidates.length === 0`**: erro. `Nenhuma edição com Stage 4 (Revisão) aprovado e Stage 5 incompleto. Rode /diaria-4-revisao primeiro ou passe AAMMDD explicitamente.`
  - **Se `candidates.length >= 2`**: default (#5321) — assumir a mais recente (`candidates[candidates.length - 1]`, lista vem ordenada ascendente) e imprimir banner: `Múltiplas edições em curso: {lista}. Assumindo a mais recente: {AAMMDD}. Passe AAMMDD explicitamente para outra.` Editor pode interromper se errado.

**`{EDITION_DIR}` (#2463/#3024):** diretório REAL da edição no disco — pode ser o layout flat legado OU o nested novo, dependendo de quando a edição foi criada. Resolver **uma vez** logo após ter `{AAMMDD}`, e usar em todo path abaixo que hoje aparece como `{EDITION_DIR}/`:
```bash
EDITION_DIR=$(npx tsx scripts/lib/find-current-edition.ts --resolve {AAMMDD})
```

Crítico: este é o stage **publicador** (newsletter + todos os canais sociais + Brevo diária + Kit diária); rodar na edição errada causa publicação real de conteúdo desatualizado.

## Pré-requisitos

- Etapas 1–4 completas: `02-reviewed.md`, `03-social.md`, `01-eia.md` + `01-eia-A/B.jpg`, `04-d{1,2,3}*.jpg`
- `_internal/newsletter-final.html` (pré-renderizado pelo Stage 4)
- Chrome com extensão **Claude in Chrome** ativa (ver `docs/browser-publish-setup.md`) — só newsletter Beehiiv usa browser; LinkedIn/Facebook/Instagram/Threads/Brevo/Kit são scripts shell puros
- Logado em Beehiiv no Chrome (quando backend = `"beehiiv"`)
- Bloco `publishing` em `platform.config.json` configurado (inclui `publishing.social.twitter.buffer_channel_id` pra X/Buffer, `kit_diaria.enabled`/`kit_diaria.audience_tag` pro Kit diária)
- `FACEBOOK_PAGE_ACCESS_TOKEN` no env pra Graph API
- `DIARIA_LINKEDIN_CRON_URL`/`DIARIA_LINKEDIN_CRON_TOKEN` pro Worker (LinkedIn/Instagram/Threads); `INSTAGRAM_ACCESS_TOKEN`/`INSTAGRAM_BUSINESS_ACCOUNT_ID` e `THREADS_ACCESS_TOKEN`/`THREADS_USER_ID` como secrets do Worker (ausência = skip gracioso desses 2 canais, não bloqueia os demais)
- MCP `claude_ai_Buffer` conectado pra X/Twitter

## Passo -2 — Pre-flight CORS check (#1132 P2.4)

```bash
npx tsx scripts/check-worker-cors.ts --worker-url https://eia.diar.ia.br
```

- Se `ok: true` → prosseguir normalmente.
- Se `ok: false` → halt + sugerir: "Worker CORS faltando. Faça `cd workers/poll && npx wrangler deploy` e re-rode."

## Passo -1 — Task tracking setup (#904)

**Defensive cleanup**: varrer `TaskList()` e marcar como `completed` qualquer task `in_progress` de Stages anteriores (`Stage 0*` a `Stage 4*`). Em seguida, criar tasks pra esta etapa: `Stage 5a — confirm channels`, `Stage 5b — dispatch publishers`, `Stage 5c — review-test-email loop`, `Stage 5d — gate humano final`, `Stage 5e — auto-reporter`. **No-op se TaskCreate/TaskUpdate não estiver disponível**.

## Passo 0 — Confirmar modo de publicação antes de qualquer dispatch (#336, invertido em #1326)

**Default = tudo automático** (#1326). Editor pode opt-out por canal via flag `--skip` — o gate interativo (menu numérico) que existia aqui foi **removido (#5321, "Perguntar é exceção")**: o gate do Stage 4 já aconteceu, o editor já revisou o conteúdo, e nenhuma opção do menu passava no rubrico (nada irreversível — Beehiiv/Kit sai como rascunho, LinkedIn/Facebook/Instagram/Threads/X saem agendados 24h+ à frente, Brevo/Kit diária saem como rascunho, tudo reversível no dashboard de cada plataforma antes de ir ao ar).

**Path 1 — flag `--skip` foi passado:**
```bash
npx tsx scripts/build-publish-consent.ts --edition {AAMMDD} --skip "{lista}"
```

**Path 2 — `auto_approve = true` (via `/diaria-edicao --no-gates`):**
```bash
npx tsx scripts/build-publish-consent.ts --edition {AAMMDD} --auto-approve
```

**Path 3 — nenhuma flag passada (default):**
```bash
npx tsx scripts/build-publish-consent.ts --edition {AAMMDD} --default-auto
```
Imprimir banner e seguir direto pro dispatch — sem esperar resposta:
```
Modo de publicação: TUDO AUTOMÁTICO (default, #1326/#5321).
Newsletter (Beehiiv/Kit) sai como rascunho; LinkedIn, Facebook, Instagram,
Threads e X saem agendados 24h+ à frente; Brevo diária e Kit diária saem
como rascunho — tudo reversível no dashboard de cada plataforma antes de ir
ao ar. Pra excluir um canal desta edição, rode de novo com
--skip {canal[,canal...]} (newsletter, linkedin, facebook, instagram,
threads, twitter, brevo, kit).
```

## O que faz

Você (top-level Claude Code) **lê `.claude/agents/orchestrator-stage-5.md` como playbook e executa diretamente**.

### Etapa 5a — Pre-flight poll + upload de imagens sociais

```bash
npx tsx scripts/preflight-poll-dispatch.ts --edition {AAMMDD}
npx tsx scripts/upload-images-public.ts --edition-dir {EDITION_DIR}/ --mode social
```

### Etapa 5b — Publicação paralela (#38)

**Newsletter primeiro (ordem obrigatória, #2454 — `{edition_url}` só existe depois do draft), depois todos os canais sociais + Brevo + Kit diária em uma única mensagem:**

1. **Newsletter** — Beehiiv (`context/publishers/beehiiv-playbook.md`, você lê e executa direto — **não tente dispatchar via `Agent`**, `javascript_tool` é restrito ao top-level. **Estado da Fase 3 (fetch in-page do Worker): `context/publishers/beehiiv-playbook.md` §Fase 3 é a fonte única de verdade — não duplicar o diagnóstico aqui (#4196).** Desde #4196 o fetch roda com timeout (`AbortController`, 25s) e qualquer falha aciona o fallback chunked automaticamente, sem seleção manual. Editor finaliza metadata na UI) OU Kit (`publish-newsletter-kit.ts --send-test`), conforme `publishing.newsletter.backend`.
2. `publish-facebook.ts --schedule` (Graph API, ~30s)
3. `publish-linkedin.ts --schedule` (Worker queue + Make webhook × 3)
4. `publish-instagram.ts --schedule` (Worker, `channel: "instagram"`; carrossel de 5 slides quando disponível)
5. `publish-threads.ts --schedule` (Worker, `channel: "threads"`; só chunk único ≤500 chars)
6. Twitter/X via Buffer MCP — `prep-twitter-posts.ts` + `mcp__claude_ai_Buffer__create_post` por post, conduzido pelo orchestrator diretamente (fora do dispatch paralelo de scripts Bash — só alcançável via sessão de agente)
7. `brevo-diaria-stage5-dispatch.ts` — só se `consent.brevo === "auto"`; cria só o RASCUNHO
8. `kit-diaria-stage5-dispatch.ts` — só se `consent.kit === "auto"` **e** `kit_diaria.enabled === true`; cria só o RASCUNHO

Após todos retornarem, **loop de review-test-email** roda em cima do draft da newsletter (Beehiiv ou Kit).

**Gate único** (legacy `pre_gate = false`) ou **auto-approve** (quando `pre_gate = true` e aprovação ocorreu no Stage 4).

### Etapa 5c — Resumo e encaminhamento ao Stage 6

Stage 5 encerra com o dispatch completo (newsletter draft + todos os canais sociais agendados + Brevo/Kit diária como rascunho). Auto-reporter e relatorio por email foram movidos para o **Stage 6 (Agendamento)** — rodam apos o editor confirmar o Schedule da newsletter.

## Output

- `_internal/05-published.json` — `draft_url`, `test_email_sent_at`, `template_used`, `review_completed` (newsletter Beehiiv) ou `_internal/newsletter-kit-published.json` (backend Kit)
- `_internal/06-social-published.json` — posts com `platform`, `destaque`, `url`, `status`, `scheduled_at` (LinkedIn, Facebook, Instagram, Threads, Twitter/X)
- `_internal/brevo-diaria-published.json` — canal Brevo diária
- `_internal/kit-diaria-published.json` — canal Kit diária
- `_internal/.step-5-done.json` — sentinel de conclusao do Stage 5

Auto-reporter + relatorio por email → Stage 6 (`/diaria-6-agendamento`).

## Notas

- **Newsletter fica como rascunho.** Test email enviado, loop review concluido. O Schedule (Beehiiv ou Kit) e feito no Stage 6 (`/diaria-6-agendamento`). LinkedIn, Facebook, Instagram, Threads e X saem agendados automaticamente (`--schedule`/`dueAt`); Brevo diária e Kit diária saem como rascunho (agendamento também é Stage 6).
- **Resume-aware**: re-rodar pula o que ja existe.
- **Proximo passo → /diaria-6-agendamento {AAMMDD}** — agendamento newsletter + Brevo/Kit diária + auto-reporter.
- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
