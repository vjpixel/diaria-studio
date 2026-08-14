# Precompute horário do dashboard clarice-dashboard (Diaria-Clarice-Dashboard-Precompute)

Issues: [#5217](https://github.com/vjpixel/diaria-studio/issues/5217), [#5216](https://github.com/vjpixel/diaria-studio/issues/5216).

## O problema (causa raiz — cache órfão, não rate-limit)

`workers/brevo-dashboard` (o dashboard `clarice-dashboard`) serve `dash:lastgood:campaigns` como fallback quando a Brevo entra em rate-limit ou sai do ar (#2733/#4251). Esse KV é **write-through**: gravado a cada `GET /` bem-sucedido fora de `?fresh=1` — mas até esta unidade, **nada reabastecia esse KV entre visitas humanas**. O Cron Trigger que fazia isso foi removido de propósito (#3553/#3639 — "a dashboard não deve mais se atualizar sozinha, só no reload"), e o clique em "Atualizar agora" (`?fresh=1`) faz fetch ao vivo mas **nunca persiste** (o gate `!isFresh` em `buildDashboardResponse` existe desde o #3079).

Achado ao vivo (13/08/2026): `dash:lastgood:campaigns` estava parado desde 16/07/2026 — mais de 4 semanas sem write. Sem um visitante humano regular carregando a página fora de `?fresh=1`, o fallback de rate-limit degrada pra um snapshot cada vez mais velho, exatamente o cenário que o #2733/#4251 existem pra evitar.

## Por que isso NÃO contraria a decisão do #3553

5 das 6 chaves de KV do painel já são mantidas quentes por job externo agendado (`Diaria-Clarice-Sync`, `Diaria-Clarice-Cohorts-Crawl`, `Diaria-Postmaster-Spam-Sync`, pushes próprios) — só `dash:lastgood:campaigns` não tinha zelador. O editor já abençoou esse padrão na própria #3553: "o push local das 03:40 permanece. O 'não atualizar sozinha' se refere só ao Cron Trigger do Worker". Este script é exatamente esse tipo de push **externo** ao Worker — não reintroduz o Cron Trigger dentro dele.

## O que a task faz

`scripts/clarice-dashboard-precompute.ts` bate `GET https://clarice-dashboard.diaria.workers.dev/` (**sem** `?fresh=1`), autenticado via `Authorization: Bearer <CLARICE_DASHBOARD_AUTH_TOKEN>`. A rota `/` roda o **mesmo caminho de código** que uma visita humana normal (`buildDashboardResponse` → `fetchRecentCampaigns` etc.) — o script não duplica nenhuma lógica de fetch, só aciona o caminho que já existe. Fora de `?fresh=1`, a request é tratada como `!isFresh` e passa pelo write-through de `dash:lastgood:campaigns`, que desde o #5216 é **gated por hash de conteúdo** (`dash:lastgood:campaigns:hash`, djb2) — só grava de fato quando `{ campaigns, scheduled, campaignsLimit }` mudou desde o último write bem-sucedido, então rodar a task 24×/dia nunca vira 24 escritas/dia se o conteúdo estiver estável.

## Auth: reusa o AUTH_TOKEN existente — trade-off aceito

Decisão do editor (13/08/2026): **nenhum secret novo**. O Worker já expõe `AUTH_TOKEN` (secret, `wrangler secret put AUTH_TOKEN`) pro login humano via cookie (`isAuthenticated`, `workers/brevo-dashboard/src/index.ts`). O #5217 estende `isAuthenticated` pra também aceitar `Authorization: Bearer <AUTH_TOKEN>` — equivalente ao cookie, checado primeiro só por ser mais barato de extrair (sem split de `Cookie`), sem precedência real quando ambos estão presentes.

**Trade-off registrado explicitamente**: como os dois caminhos (cookie humano, Bearer da task) validam contra o MESMO valor, **rotacionar `AUTH_TOKEN` desloga todo login humano ativo E quebra a task agendada ao mesmo tempo** — não há forma de rotacionar um sem o outro. Aceito porque (a) a rotação deste token é rara e sempre uma ação manual e deliberada do editor, que já sabe reautenticar via `/login`; (b) `CLARICE_DASHBOARD_AUTH_TOKEN` no `.env` local é fácil de atualizar no mesmo momento da rotação; (c) a task falhando por token desatualizado degrada pra "cache stale" (o mesmo estado de antes desta unidade), nunca pra leak de dado nem corrupção.

`/api/campaigns` e `/api/postmaster-spam` **continuam públicas** (decisão do #3081, não tocada aqui) — o Bearer novo só se aplica onde `isAuthenticated` já era chamado (rota `/`, `/login`, `/api/coupons`, `/api/eia/refresh`).

## Custo

Execução morna: ~2 chamadas Brevo (créditos do plano + agendadas, antes das campanhas enviadas — a maior parte do payload vem de KV/cache no caminho comum). Cadência horária (24 execuções/dia) usa ~44/100 do teto real de 100 req/hora da Brevo (#5215) — folgado. O editor checa o painel a partir das 10:00 — a cadência horária garante dado fresco já na 1ª olhada do dia sem precisar de um horário-âncora dedicado.

## Setup (ação local do coordenador/editor, DEPOIS do merge)

Requer `CLARICE_DASHBOARD_AUTH_TOKEN` no `.env` (mesmo valor do secret `AUTH_TOKEN` do Worker — ver `.env.example`). Sem ele, o script aborta com exit 1 antes de tentar qualquer request (fail loud, nunca "sucesso" silencioso sem ter feito nada).

**Esta unidade rodou num worktree isolado** (`.claude/worktrees/...`) — gerar o unit systemd de lá apontaria `WorkingDirectory=`/`ExecStart=` pro worktree, que é apagado no cleanup pós-merge (mesmo padrão documentado pro `Diaria-Clarice-Envio-Guard-Alarm`, #5220). O arme real precisa rodar da checkout compartilhada (`/home/vjpixel/diaria-studio`), depois do merge:

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Clarice-Dashboard-Precompute
systemctl --user daemon-reload
systemctl --user enable --now diaria-clarice-dashboard-precompute.timer
```

Confirmar: `systemctl --user is-active diaria-clarice-dashboard-precompute.timer` deve devolver `active`.

**Deploy do Worker**: `workers/brevo-dashboard` tem deploy automático via `.github/workflows/deploy-brevo-dashboard.yml` — dispara `wrangler deploy` a cada push em `master` que toque `workers/brevo-dashboard/**`. O merge desta PR já aciona esse deploy sozinho; **não é necessário** rodar `wrangler deploy` manualmente.

## Verificação manual (debug/auditoria)

```bash
npx tsx scripts/clarice-dashboard-precompute.ts --dry-run   # imprime o que faria, sem bater a rede
npx tsx scripts/clarice-dashboard-precompute.ts             # GET / real, autenticado
```

Log da task agendada: `data/clarice-dashboard/.precompute.log`.

**Nenhuma execução ao vivo desta task rodou nesta unidade** (worktree isolado, sem `CLARICE_DASHBOARD_AUTH_TOKEN` real configurado nem chamada de rede real permitida pela regra de dispatch overnight #738/#3453) — validado só via testes com a lógica pura + `fetchFn` mockado (`test/clarice-dashboard-precompute-5217.test.ts`, `test/brevo-dashboard-lastgood-hash-gate-5216.test.ts`) e via `test/scheduled-tasks.test.ts` (estrutura do registro), mesma disciplina do #4320/#4382/#4490/#4534/#4723/#4750/#4910/#5005/#5058/#5220.
