---
name: diaria-5-publicacao
description: Roda as Etapas 5 E 6 numa invocação só (#7983) — publicação auto (rascunho Kit + LinkedIn/Facebook/Instagram/Threads/X agendados + Brevo diária/Kit diária) seguida do gate humano de agendamento + Schedule + auto-reporter. Uso — `/diaria-5-publicacao [all|newsletter|social] AAMMDD`.
model: claude-sonnet-5-5
effort: low
---

# /diaria-5-publicacao

Dispara a Etapa 5 unificada (publicação paralela: newsletter + todos os canais sociais + canais de reativação/parceiro em paralelo, sem gate interativo) e, **na mesma sessão**, a Etapa 6 (gate humano de agendamento → Schedule → auto-reporter → relatório).

## Fusão 5+6 (#7983, decisão do editor 11/09/2026)

Este comando leva a edição do dispatch até o fim do pipeline. Ao terminar o Stage 5, **continue lendo `.claude/agents/orchestrator-stage-6.md` nesta mesma sessão** — não imprima "rode `/diaria-6-agendamento`" como próximo passo do editor.

**Por que dá pra fundir:** com `publishing.newsletter.backend === "kit"` (desde #7388) nenhum dos dois stages toca o Chrome — o Schedule virou um PATCH de `send_at` com GET de verificação —, e tudo que o Stage 6 lê do Stage 5 é arquivo. A separação era resíduo do #1198 ("Schedule é sempre manual na Beehiiv"), já revogado pelo #6098.

**O que continua separado, de propósito:** os números dos stages, os dois sentinels (`.step-5-done.json`/`.step-6-done.json`), os invariants por stage, `find-current-edition --stage 5|6`, a statusline e o Studio. A fusão é de **invocação**, nunca de estado.

**O gate NÃO sai — e desde #8205 é a ÚNICA parada da skill inteira.** O gate de agendamento (§6c do playbook do Stage 6) é um dos dois gates de projeto do CLAUDE.md — critério 1, irreversível pra terceiros — e agora também pede explicitamente a revisão visual do e-mail de teste pelo editor. Tudo que antes tinha parada própria (pedidos editoriais registrados, guard de slug do bloco WhatsApp, auto-reporter) virou contexto dentro deste único gate ou execução automática sem pergunta — nunca uma 2ª parada.

**Exceção nomeada ao princípio #5578.** Esta é a única transição `/diaria-N-*` que encadeia sozinha. O princípio segue valendo em todas as outras — inclusive na fronteira pós-gate 4 (#6171), que é quem garante que esta skill sempre começa em sessão nova.

**Retomada:** se a sessão morrer entre o dispatch e o gate, ou o editor sair e voltar horas depois, `/diaria-6-agendamento {AAMMDD}` retoma direto no gate (o sentinel do Stage 5 já está no disco).

## Canais (#6610)

Stage 5 dispatcha, hoje, **8 canais** — lista completa em `.claude/agents/orchestrator-stage-5.md` §5c-3/5c-3b (fonte de verdade operacional; não duplicar os detalhes de cada script aqui):

1. **Newsletter** — Kit (`publish-newsletter-kit.ts` — teste preferencialmente pelo "Send test email" da UI do Kit via `--draft-only-for-ui-test` + `--mark-ui-test-sent --at`, com fallback `--send-test` sem Chrome, #10395; detalhes no §5c-1-kit). Default `"kit"` em `publishing.newsletter.backend` (também com a chave ausente, #11225); a Beehiiv é só arquivo histórico e o ramo `"beehiiv"` foi removido.
2. **LinkedIn** — `publish-linkedin.ts --schedule` (Worker `diaria-linkedin-cron` + fallback Make webhook).
3. **Facebook** — `publish-facebook.ts --schedule` (Graph API).
4. **Instagram** — `publish-instagram.ts --schedule` (mesmo Worker do LinkedIn, `channel: "instagram"`; carrossel de 5 slides quando disponível, senão post single-image).
5. **Threads** — `publish-threads.ts --schedule` (mesmo Worker, `channel: "threads"`; só posts de 1 chunk ≤500 chars).
6. **Twitter/X** — via Buffer MCP (`prep-twitter-posts.ts` + `mcp__claude_ai_Buffer__create_post`), conduzido pelo orchestrator diretamente (não é script Bash puro — só alcançável de dentro da sessão de agente).
7. **Brevo diária** — `brevo-diaria-stage5-dispatch.ts` (segmento Pending/reativação; cria só o RASCUNHO, agendamento é Stage 6).
8. **Kit diária paralelo aposentado (#11225)** — não despachar; a audiência recebe pelo Kit principal.

## Argumentos

- `/diaria-5-publicacao all AAMMDD` — roda publicação paralela (todos os canais acima) + auto-reporter
- `/diaria-5-publicacao newsletter AAMMDD` — re-dispara só a newsletter (Kit); útil pra fix isolado após template errado
- `/diaria-5-publicacao social AAMMDD` — re-dispara só os canais sociais (LinkedIn, Facebook, Instagram, Threads, Twitter/X); útil pra retry de social falhado sem regerar a newsletter

**Opt-out por canal (#1326):** flag `--skip {canal[,canal...]}` (CSV) ignora dispatch dos canais listados. Canais válidos: `newsletter`, `linkedin`, `facebook`, `instagram`, `threads`, `twitter`, `brevo`, `kit`, `youtube` (#10659, §5b-youtube; ver `VALID` em `scripts/lib/publish-consent.ts`). Default = tudo auto. Exemplos:
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
- Chrome com extensão **Claude in Chrome** ativa (ver `docs/browser-publish-setup.md`) — opcional: só o teste pela UI do Kit usa browser (sem ele, fallback `--send-test`); LinkedIn/Facebook/Instagram/Threads/Brevo/Kit são scripts shell puros
- **Beehiiv não é pré-requisito (#11225):** a conta é só arquivo histórico, não precisa estar logada nem com o conector no ar
- Bloco `publishing` em `platform.config.json` configurado (inclui `publishing.social.twitter.buffer_channel_id` pra X/Buffer, `kit_diaria.enabled`/`kit_diaria.audience_tag` pro Kit diária)
- `FACEBOOK_PAGE_ACCESS_TOKEN` no env pra Graph API
- `DIARIA_LINKEDIN_CRON_URL`/`DIARIA_LINKEDIN_CRON_TOKEN` pro Worker (LinkedIn/Instagram/Threads); `INSTAGRAM_ACCESS_TOKEN`/`INSTAGRAM_BUSINESS_ACCOUNT_ID` e `THREADS_ACCESS_TOKEN`/`THREADS_USER_ID` como secrets do Worker (ausência = skip gracioso desses 2 canais, não bloqueia os demais)
- MCP `claude_ai_Buffer` conectado pra X/Twitter

## Passo -3 — Sincronizar código com origin/master (#2686, #8684)

**Sempre a primeira coisa que esta skill faz.** Desde #6171, Etapa 5/6 roda numa sessão **NOVA** — que nunca passa pelo Passo 0 de `/diaria-edicao` (o único lugar que hoje chama `sync-code.ts`, #2686). Entre o fim do Stage 4 (sessão anterior) e o começo desta sessão, rodadas overnight/develop/continuo concorrentes seguem mergeando PRs em `origin/master` — às vezes por horas. Sem este passo, esta sessão roda com o código que já estava em disco no checkout compartilhado no momento em que a sessão começou, que pode preceder correções já mergeadas (achado ao vivo, #8684: `publish-edition-site-page.ts --edition-dir data/editions/2609/260922 ...` saiu com `exit 3` — "checkout não está sincronizado com origin/master" — porque o checkout ainda não tinha puxado o commit que tornou esse próprio guard obsoleto pro caminho default, ver #8636).

Mesma invocação e mesmo timeout do Passo 0 de `/diaria-edicao` (ver `.claude/skills/diaria-edicao/SKILL.md`):

```bash
npx tsx scripts/sync-code.ts --edition-dir {EDITION_DIR}
```
(Bash tool: `timeout: 570000`)

`--edition-dir` grava `_internal/05-sync-code.json`; o invariant `sync-code-ran` do Stage 5 avisa (warning) quando o marker falta ou o checkout ficou defasado (#8690) — o passo deixa de depender só desta prosa.

**Fail-soft, igual ao Passo 0 da diária**: qualquer falha (offline, divergência, conflito de stash) vira warning — nunca bloqueia esta skill. Parsear o JSON do stdout (`outcome`, `branch_before`, `warnings`) e logar via `log-event.ts` com `--informational` (mesmos níveis da tabela do Passo 0 de `/diaria-edicao` — info pros 3 outcomes de sucesso, warn pros demais).

**Por que aqui e não só dentro de `publish-edition-site-page.ts`:** o `--worktree-dir` default do script (#8636) já isola o COMMIT/PUSH de um checkout divergente, e o script agora também tenta um `git fetch origin master` best-effort antes de criar esse worktree (#8684) — mas nenhum dos dois cobre o CÓDIGO do próprio script estar desatualizado no disco: `npx tsx` executa o que já está no checkout no momento da chamada, não o que está em `origin/master`. Só sincronizar a SESSÃO (este passo) antes de rodar qualquer script garante que toda a Etapa 5/6 — não só este script — rode com a versão mais recente do pipeline.

## Passo -2 — Pre-flight CORS check (#1132 P2.4)

```bash
npx tsx scripts/check-worker-cors.ts --worker-url https://eia.diar.ia.br
```

- Se `ok: true` → prosseguir normalmente.
- Se `ok: false` → halt + sugerir: "Worker CORS faltando. Faça `cd workers/poll && npx wrangler deploy` e re-rode."

## Passo -1 — Task tracking setup (#904)

**Defensive cleanup**: varrer `TaskList()` e marcar como `completed` qualquer task `in_progress` de Stages anteriores (`Stage 0*` a `Stage 4*`). Em seguida, criar tasks pra esta etapa: `Stage 5a — confirm channels`, `Stage 5b — dispatch publishers`, `Stage 5c — review-test-email loop`, `Stage 5d — gate humano final`, `Stage 5e — auto-reporter`. **No-op se TaskCreate/TaskUpdate não estiver disponível**.

## Passo 0 — Confirmar modo de publicação antes de qualquer dispatch (#336, invertido em #1326)

**Default = tudo automático** (#1326). Editor pode opt-out por canal via flag `--skip` — o gate interativo (menu numérico) que existia aqui foi **removido (#5321, "Perguntar é exceção")**: o gate do Stage 4 já aconteceu, o editor já revisou o conteúdo, e nenhuma opção do menu passava no rubrico (nada irreversível — Kit sai como rascunho, LinkedIn/Facebook/Instagram/Threads/X saem agendados 24h+ à frente, Brevo/Kit diária saem como rascunho, tudo reversível no dashboard de cada plataforma antes de ir ao ar).

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
Newsletter (Kit) sai como rascunho; LinkedIn, Facebook, Instagram,
Threads e X saem agendados 24h+ à frente; Brevo diária e Kit diária saem
como rascunho — tudo reversível no dashboard de cada plataforma antes de ir
ao ar. Pra excluir um canal desta edição, rode de novo com
--skip {canal[,canal...]} (newsletter, linkedin, facebook, instagram,
threads, twitter, brevo, kit, youtube).
```

## Passo 0b — Aviso de vídeo do D1 (#10943, aviso, não gate)

Fluxo ideal desde 22/10/2026 (#11209 juntou as duas skills de vídeo): `/diaria-edicao` → `/diaria-publica-video` → `/diaria-5-publicacao`, cada skill numa sessão própria, nenhuma encadeia (#5578). Antes do dispatch, conferir se o vídeo do dia já passou pelo `/diaria-publica-video`:

```bash
npx tsx scripts/check-video-before-publish.ts {AAMMDD} --edition-dir {EDITION_DIR}
```

- `status: "link-ready"` → `_internal/05-video-url.txt` existe; o Stage 5 põe o link no D1 de X, Threads e Facebook. Seguir.
- `status: "no-video"` ou `"video-without-link"` → mostrar ao editor a linha `[aviso]` do stderr (o D1 sairá **sem** o link do vídeo; no 2º caso, o comando `link-video-d1.ts` que libera o link) e **seguir com o dispatch sem esperar resposta**. Não é gate: o vídeo pode ainda não existir, e a Etapa 5 nunca para por isso. Este aviso é uma foto de ANTES do dispatch: o §5b-youtube do playbook (#10659) roda em todo caso com escopo `all`/`social` (pulado em `newsletter`, com `--skip youtube` e com `none`/consent `"skipped"` — `youtubeUploadEnabled`; no-op se `05-youtube-published.json` já registra o vídeo), baixa do Drive o `.mp4` horizontal com "final" como palavra no nome e o sobe com `publishAt` 06:00 BRT, fail-soft, antes do dispatch social. Enquanto `YOUTUBE_API_PROJECT_AUDITED` for `false`, vídeo agendado **não** grava `05-video-url.txt` (#10865): o D1 sai sem o link e o resumo aponta `link-video-d1.ts` (o caso agendado/privado no D1 é da PR #10975). **O resumo final da Etapa 5 é a autoridade** sobre o link do D1, não este aviso.
- Exit != 0 (uso inválido, erro inesperado) → logar warn e seguir.

Não rodar `/diaria-publica-video` (nem os aliases `/diaria-youtube`/`/diaria-shorts`) daqui — é skill standalone que o editor invoca.

## O que faz

Você (top-level Claude Code) **lê `.claude/agents/orchestrator-stage-5.md` como playbook e executa diretamente**.

### Etapa 5a — Pre-flight poll + upload de imagens sociais

```bash
npx tsx scripts/preflight-poll-dispatch.ts --edition {AAMMDD}
npx tsx scripts/upload-images-public.ts --edition-dir {EDITION_DIR}/ --mode social
```

### Etapa 5b — Publicação paralela (#38)

**Antes de tudo, o PR da página do site (§5b-site do playbook, #10160):** `publish-edition-site-page.ts --slug-from-d1 --sitemap ... --no-wait-merge` abre o PR e devolve na hora — nada no dispatch espera o merge; o merge trava o fim do Stage 6 (§6c-site + invariante `site-page-pr-merged`).

**Newsletter primeiro (ordem obrigatória, #2454 — `{edition_url}` só existe depois do draft), depois todos os canais sociais + Brevo + Kit diária em uma única mensagem:**

1. **Newsletter** — Kit (`publish-newsletter-kit.ts`: teste da UI do Kit ou fallback `--send-test`, §5c-1-kit). Não executar playbook Beehiiv (#11225).
2. `publish-facebook.ts --schedule` (Graph API, ~30s)
3. `publish-linkedin.ts --schedule` (Worker queue + Make webhook × 3)
4. `publish-instagram.ts --schedule` (Worker, `channel: "instagram"`; carrossel de 5 slides quando disponível)
5. `publish-threads.ts --schedule` (Worker, `channel: "threads"`; só chunk único ≤500 chars)
6. Twitter/X via Buffer MCP — `prep-twitter-posts.ts` + `mcp__claude_ai_Buffer__create_post` por post, conduzido pelo orchestrator diretamente (fora do dispatch paralelo de scripts Bash — só alcançável via sessão de agente)
7. `brevo-diaria-stage5-dispatch.ts` — só se `consent.brevo === "auto"`; cria só o RASCUNHO
8. `kit-diaria-stage5-dispatch.ts` — só se `consent.kit === "auto"` **e** `kit_diaria.enabled === true`; cria só o RASCUNHO

Após todos retornarem, **loop de review-test-email** roda em cima do draft da newsletter (Kit) — só via Gmail MCP, sem fallback via Chrome (#8205).

**Stage 5 não tem gate próprio** — dispatch puro (#1326). A única parada de toda a skill é o gate único do Stage 6 (§6c) — revisão visual do e-mail de teste pelo editor + agendamento (#8205).

### Etapa 5c — Resumo e continuação para o Stage 6 (#7983, MESMA sessão)

Stage 5 encerra o dispatch (newsletter draft + todos os canais sociais agendados + Brevo/Kit diária como rascunho) e, na mesma sessão, segue direto para o **Stage 6 (Agendamento)** — leia `.claude/agents/orchestrator-stage-6.md` e execute-o em seguida. Auto-reporter roda sem gate dentro do Stage 6 (#8205); relatório por email é gerado ao final, depois que o editor confirma o Schedule da newsletter na parada única de §6c.

## Output

- `_internal/newsletter-kit-published.json` — broadcast, teste e estado da newsletter Kit
- `_internal/06-social-published.json` — posts com `platform`, `destaque`, `url`, `status`, `scheduled_at` (LinkedIn, Facebook, Instagram, Threads, Twitter/X)
- `_internal/brevo-diaria-published.json` — canal Brevo diária
- `_internal/kit-diaria-published.json` — somente histórico, sem novo dispatch
- `_internal/.step-5-done.json` — sentinel de conclusao do Stage 5
- `_internal/.step-6-done.json` — sentinel de conclusao do Stage 6 (rodado na mesma sessão, #7983)
- `_internal/issues-draft.json`, `_internal/edition-report.html` — auto-reporter + relatório (Stage 6)

## Notas

- **Newsletter fica como rascunho até o gate do Stage 6.** Test email enviado, loop review concluído no Stage 5. O Schedule (Kit) é feito no gate humano de §6c, **na mesma sessão** (#7983). LinkedIn, Facebook, Instagram, Threads e X saem agendados automaticamente (`--schedule`/`dueAt`) ainda no Stage 5; Brevo diária e Kit diária saem como rascunho (agendamento também acontece no gate do Stage 6).
- **Resume-aware**: re-rodar pula o que ja existe.
- **Continua sozinho para o Stage 6** (#7983) — não imprima `/diaria-6-agendamento` como próximo passo do editor. Essa skill continua existindo só como porta de **retomada** (sessão morreu entre dispatch e gate, ou o editor voltou horas depois).
- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
