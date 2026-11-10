---
name: diaria-5-publicacao
description: Roda as Etapas 5 E 6 numa invocação só (#7983) — publicação auto (rascunho Kit + LinkedIn/Facebook/Instagram/Threads/X agendados + Brevo diária) seguida do gate humano de agendamento + Schedule + auto-reporter. Uso — `/diaria-5-publicacao [all|newsletter|social] AAMMDD`.
model: claude-sonnet-5-5
effort: low
---

# /diaria-5-publicacao

Dispara a Etapa 5 unificada (publicação paralela: newsletter + todos os canais sociais + canais de reativação/parceiro em paralelo, sem gate interativo) e, **na mesma sessão**, a Etapa 6 (gate humano de agendamento → Schedule → auto-reporter → relatório).

**Entrada normal desde #12591: o `/diaria-publica-video`.** A ordem `/diaria-video-montagem` → vídeo → Etapa 5 é obrigatória (o link do YouTube entra na edição, #12588), e a skill de vídeo lê este arquivo e o executa inteiro depois do horizontal, na mesma sessão, antes do vertical. Invocado direto, este comando serve para retomada, retry de canal (`newsletter`/`social`) e para a edição marcada sem vídeo. Nos dois casos o pré-requisito do Passo 0b barra a Etapa 5 sem o link do vídeo.

## Fusão 5+6 (#7983, decisão do editor 11/09/2026)

Este comando leva a edição do dispatch até o fim do pipeline. Ao terminar o Stage 5, **continue lendo `.claude/agents/orchestrator-stage-6.md` nesta mesma sessão** — não imprima "rode `/diaria-6-agendamento`" como próximo passo do editor.

**Por que dá pra fundir:** com o envio pelo Kit (desde #7388) nenhum dos dois stages toca o Chrome — o Schedule virou um PATCH de `send_at` com GET de verificação —, e tudo que o Stage 6 lê do Stage 5 é arquivo. A separação era resíduo do #1198 ("Schedule é sempre manual na Beehiiv"), já revogado pelo #6098.

**O que continua separado, de propósito:** os números dos stages, os dois sentinels (`.step-5-done.json`/`.step-6-done.json`), os invariants por stage, `find-current-edition --stage 5|6`, a statusline e o Studio. A fusão é de **invocação**, nunca de estado.

**O gate NÃO sai — e desde #8205 é a ÚNICA parada da skill inteira.** O gate de agendamento (§6c do playbook do Stage 6) é um dos dois gates de projeto do CLAUDE.md — critério 1, irreversível pra terceiros — e agora também pede explicitamente a revisão visual do e-mail de teste pelo editor. Tudo que antes tinha parada própria (pedidos editoriais registrados, auto-reporter) virou contexto dentro deste único gate ou execução automática sem pergunta — nunca uma 2ª parada.

**Exceção nomeada ao princípio #5578.** Esta é a única transição `/diaria-N-*` que encadeia sozinha (a outra fusão explícita é a do `/diaria-publica-video`, que entra aqui depois do horizontal e volta para o vertical no fim, #12591). O princípio segue valendo em todas as outras — inclusive na fronteira pós-gate 4 (#6171), que é quem garante que esta skill sempre começa em sessão nova.

**Vindo do `/diaria-publica-video` (#12591):** ao fim do Stage 6, voltar para a Parte B (vertical) daquela skill; o relato final é o dela, que inclui o desta.

**Retomada:** se a sessão morrer entre o dispatch e o gate, ou o editor sair e voltar horas depois, `/diaria-6-agendamento {AAMMDD}` retoma direto no gate (o sentinel do Stage 5 já está no disco).

## Canais (#6610)

Stage 5 dispatcha, hoje, **7 canais** — lista completa em `.claude/agents/orchestrator-stage-5.md` §5c-3/5c-3b (fonte de verdade operacional; não duplicar os detalhes de cada script aqui):

1. **Newsletter** — Kit (`publish-newsletter-kit.ts` — teste preferencialmente pelo "Send test email" da UI do Kit via `--draft-only-for-ui-test` + `--mark-ui-test-sent --at`, com fallback `--send-test` sem Chrome, #10395; detalhes no §5c-1-kit). A Beehiiv é só arquivo histórico (#11225).
2. **LinkedIn** — `publish-linkedin.ts --schedule` (Worker `diaria-linkedin-cron` + fallback Make webhook).
3. **Facebook** — `publish-facebook.ts --schedule` (Graph API).
4. **Instagram** — `publish-instagram.ts --schedule` (mesmo Worker do LinkedIn, `channel: "instagram"`; carrossel de 5 slides quando disponível, senão post single-image).
5. **Threads** — `publish-threads.ts --schedule` (mesmo Worker, `channel: "threads"`; só posts de 1 chunk ≤500 chars).
6. **Twitter/X** — via Buffer MCP (`prep-twitter-posts.ts` + `mcp__claude_ai_Buffer__create_post`), conduzido pelo orchestrator diretamente (não é script Bash puro — só alcançável de dentro da sessão de agente).
7. **Brevo diária** — `brevo-diaria-stage5-dispatch.ts` (segmento Pending/reativação; cria só o RASCUNHO, agendamento é Stage 6).

## Argumentos

- `/diaria-5-publicacao all AAMMDD` — roda publicação paralela (todos os canais acima) + auto-reporter
- `/diaria-5-publicacao newsletter AAMMDD` — re-dispara só a newsletter (Kit); útil pra fix isolado após template errado
- `/diaria-5-publicacao social AAMMDD` — re-dispara só os canais sociais (LinkedIn, Facebook, Instagram, Threads, Twitter/X); útil pra retry de social falhado sem regerar a newsletter

**Opt-out por canal (#1326):** flag `--skip {canal[,canal...]}` (CSV) ignora dispatch dos canais listados. Canais válidos: `newsletter`, `linkedin`, `facebook`, `instagram`, `threads`, `twitter`, `brevo`, `youtube` (#10659; desde o #12588 `--skip youtube` significa "publicar sem o link do vídeo no D1" — a Etapa 5 não sobe vídeo; ver `VALID` em `scripts/lib/publish-consent.ts`). Default = tudo auto. Exemplos:
- `/diaria-5-publicacao AAMMDD --skip newsletter` — só canais sociais/Brevo automáticos, newsletter manual
- `/diaria-5-publicacao AAMMDD --skip linkedin,facebook,instagram,threads,twitter` — só newsletter (+Brevo) automático
- `/diaria-5-publicacao AAMMDD --skip brevo` — pula o canal de reativação nesta edição. O token `kit` é recusado desde o #11225: o e-mail da diária é o canal `newsletter`
- `/diaria-5-publicacao AAMMDD --skip newsletter,linkedin,facebook,instagram,threads,twitter,brevo` — tudo manual

Se não passar data, rodar `npx tsx scripts/lib/find-current-edition.ts --stage 5` e parsear `candidates[]` do JSON de saída (#583):
  - **Se `candidates.length === 1`**: assumir essa edição. Logar info: `Assumindo edição em curso: {AAMMDD}`. Editor pode interromper se errado.
  - **Se `candidates.length === 0`**: erro. `Nenhuma edição com Stage 4 (Revisão) aprovado e Stage 5 incompleto. Rode /diaria-4-revisao primeiro ou passe AAMMDD explicitamente.`
  - **Se `candidates.length >= 2`**: default (#5321) — assumir a mais recente (`candidates[candidates.length - 1]`, lista vem ordenada ascendente) e imprimir banner: `Múltiplas edições em curso: {lista}. Assumindo a mais recente: {AAMMDD}. Passe AAMMDD explicitamente para outra.` Editor pode interromper se errado.

**`{EDITION_DIR}` (#2463/#3024):** diretório REAL da edição no disco — pode ser o layout flat legado OU o nested novo, dependendo de quando a edição foi criada. Resolver **uma vez** logo após ter `{AAMMDD}`, e usar em todo path abaixo que hoje aparece como `{EDITION_DIR}/`:
```bash
EDITION_DIR=$(npx tsx scripts/lib/find-current-edition.ts --resolve {AAMMDD})
```

Crítico: este é o stage **publicador** (newsletter + todos os canais sociais + Brevo diária); rodar na edição errada causa publicação real de conteúdo desatualizado.

## Pré-requisitos

- Etapas 1–4 completas: `02-reviewed.md`, `03-social.md`, `01-eia.md` + `01-eia-A/B.jpg`, `04-d{1,2,3}*.jpg`
- `_internal/newsletter-final.html` (pré-renderizado pelo Stage 4)
- Link do vídeo do D1 em `_internal/05-video-url.txt` (gravado pela Parte A do `/diaria-publica-video`), ou a edição marcada sem vídeo (`_internal/no-video.json`), ou `--skip youtube` — sem isso o Passo 0b para (#12588)
- Chrome com extensão **Claude in Chrome** ativa (ver `docs/browser-publish-setup.md`) — opcional: só o teste pela UI do Kit usa browser (sem ele, fallback `--send-test`); LinkedIn/Facebook/Instagram/Threads/Brevo/Kit são scripts shell puros
- **Beehiiv não é pré-requisito (#11225):** a conta é só arquivo histórico, não precisa estar logada nem com o conector no ar
- Bloco `publishing` em `platform.config.json` configurado (inclui `publishing.social.twitter.buffer_channel_id` pra X/Buffer)
- `FACEBOOK_PAGE_ACCESS_TOKEN` no env pra Graph API
- `DIARIA_LINKEDIN_CRON_URL`/`DIARIA_LINKEDIN_CRON_TOKEN` pro Worker (LinkedIn/Instagram/Threads); `INSTAGRAM_ACCESS_TOKEN`/`INSTAGRAM_BUSINESS_ACCOUNT_ID` e `THREADS_ACCESS_TOKEN`/`THREADS_USER_ID` como secrets do Worker (ausência = skip gracioso desses 2 canais, não bloqueia os demais)
- MCP `claude_ai_Buffer` conectado pra X/Twitter

## Passo -3 — Sincronizar código com origin/master (#2686, #8684)

**Sempre a primeira coisa que esta skill faz** (vindo do `/diaria-publica-video`, ele já rodou este passo no início da sessão e aqui roda de novo, idempotente, #12591). Desde #6171, Etapa 5/6 roda numa sessão **NOVA** — que nunca passa pelo Passo 0 de `/diaria-edicao` (o único lugar que hoje chama `sync-code.ts`, #2686). Entre o fim do Stage 4 (sessão anterior) e o começo desta sessão, rodadas overnight/develop/continuo concorrentes seguem mergeando PRs em `origin/master` — às vezes por horas. Sem este passo, esta sessão roda com o código que já estava em disco no checkout compartilhado no momento em que a sessão começou, que pode preceder correções já mergeadas (achado ao vivo, #8684: `publish-edition-site-page.ts --edition-dir data/editions/2609/260922 ...` saiu com `exit 3` — "checkout não está sincronizado com origin/master" — porque o checkout ainda não tinha puxado o commit que tornou esse próprio guard obsoleto pro caminho default, ver #8636).

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

**Default = tudo automático** (#1326). Editor pode opt-out por canal via flag `--skip` — o gate interativo (menu numérico) que existia aqui foi **removido (#5321, "Perguntar é exceção")**: o gate do Stage 4 já aconteceu, o editor já revisou o conteúdo, e nenhuma opção do menu passava no rubrico (nada irreversível — o Kit sai como rascunho, LinkedIn/Facebook/Instagram/Threads/X saem agendados 24h+ à frente, Brevo diária sai como rascunho, tudo reversível no dashboard de cada plataforma antes de ir ao ar).

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
Threads e X saem agendados 24h+ à frente; Brevo diária sai
como rascunho — tudo reversível no dashboard de cada plataforma antes de ir
ao ar. Pra excluir um canal desta edição, rode de novo com
--skip {canal[,canal...]} (newsletter, linkedin, facebook, instagram,
threads, twitter, brevo, youtube).
```

## Passo 0b — Pré-requisito: link do vídeo no D1 (#10943, gate desde #12588)

Ordem obrigatória (decisão do editor, 10/11/2026): `/diaria-edicao` → `/diaria-video-montagem` → `/diaria-publica-video` (que segue para esta Etapa 5 depois do horizontal, #12591), porque o link do YouTube entra na edição. Antes de qualquer dispatch, conferir:

```bash
npx tsx scripts/check-video-before-publish.ts {AAMMDD} --edition-dir {EDITION_DIR}
```

- **exit 0** → seguir. `status: "link-ready"`: `_internal/05-video-url.txt` existe e o Stage 5 põe o link no D1 de X, Threads e Facebook. `"link-may-not-open"` (#12598): o link vai para o D1 do mesmo jeito, mas o registro do upload (`05-youtube-published.json`, estado relido com `resolveYouTubeState`) diz que o vídeo está privado, sem estado confirmado ou agendado depois do D1: repetir o `[aviso]` no resumo e no gate da Etapa 6 (publicar ou agendar no Studio antes do D1) e seguir; só avisa, não bloqueia. `"no-video-marked"` (edição marcada sem vídeo, `set-d1-no-video.ts`, #11125) ou `"skipped-by-consent"` (`--skip youtube` nesta rodada, sem link gravado): repetir a linha `[aviso]` do stderr no resumo (o D1 sai sem o vídeo por decisão do editor) e seguir. Retry de canal com a Etapa 5 já concluída (`.step-5-done.json`) também sai 0, com o aviso, mesmo sem link: a 1ª rodada já decidiu o vídeo.
- **exit 3** (`status: "no-video"`, `"video-without-link"`, `"invalid-link"` ou `"no-video-stale"`, `blocking: true`) → **parar antes de qualquer dispatch**: `npx tsx scripts/render-halt-banner.ts --stage "5 — Publicação" --reason "D1 sem o link do vídeo (_internal/05-video-url.txt)" --action "{warning do JSON}"` e esperar o editor. As saídas estão no `warning`: rodar `/diaria-publica-video {AAMMDD}` (sobe o horizontal, grava o link e volta para cá), liberar o link de um vídeo já subido (`link-video-d1.ts {AAMMDD} --save`), marcar a edição sem vídeo (`set-d1-no-video.ts {AAMMDD}`, depois o upload em modo newsletter e o re-render do HTML) ou rodar de novo com `--skip youtube`. `"no-video-stale"` (#12618) é a edição marcada sem vídeo com o convite ainda em `06-public-images.json` (`d1_play`) ou em `_internal/newsletter-final.html`: o `warning` traz o upload em modo newsletter e o re-render. Até o #12588 isto era só aviso e o D1 saía sem o link em silêncio.
- **Qualquer outro exit** (2 = uso inválido ou pasta inexistente; 1 ou outro = erro inesperado) → halt com o stderr. Só o exit 0 segue.

Vale para todos os escopos, inclusive `newsletter`: o D1 da newsletter também leva o link do vídeo. `--skip youtube` só dispensa o pré-requisito: um link já gravado vai para o D1 do mesmo jeito (os publishers não leem o consent). Para tirar o vídeo de uma edição, `set-d1-no-video.ts`, que vence a URL na newsletter e nos posts.

O §5b-youtube do playbook (`stage5-youtube.ts`) **só lê** o link e registra o passo, com a mesma decisão deste Passo 0b, e sai 3 (halt antes do dispatch social) se o link faltar mesmo assim: desde o #12588 a Etapa 5 nunca busca nem sobe vídeo. Quem sobe o horizontal é só o `/diaria-publica-video`, depois do "pode publicar" (#11741). Não rodar `/diaria-publica-video` (nem os aliases `/diaria-youtube`/`/diaria-shorts`) de dentro desta skill: com o link faltando, o halt devolve a decisão ao editor.

## O que faz

Você (top-level Claude Code) **lê `.claude/agents/orchestrator-stage-5.md` como playbook e executa diretamente**.

### Etapa 5a — Pre-flight poll + upload de imagens sociais

```bash
npx tsx scripts/preflight-poll-dispatch.ts --edition {AAMMDD}
npx tsx scripts/upload-images-public.ts --edition-dir {EDITION_DIR}/ --mode social
```

### Etapa 5b — Publicação paralela (#38)

**Antes de tudo, o PR da página do site (§5b-site do playbook, #10160):** `publish-edition-site-page.ts --slug-from-d1 --sitemap ... --no-wait-merge` abre o PR e devolve na hora — nada no dispatch espera o merge; o merge trava o fim do Stage 6 (§6c-site + invariante `site-page-pr-merged`).

**Newsletter primeiro (ordem obrigatória, #2454 — `{edition_url}` só existe depois do draft), depois todos os canais sociais + Brevo em uma única mensagem:**

1. **Newsletter** — `publish-newsletter-kit.ts` (§5c-1-kit). Grava `_internal/05-edition-url.txt`.
2. `publish-facebook.ts --schedule` (Graph API, ~30s)
3. `publish-linkedin.ts --schedule` (Worker queue + Make webhook × 3)
4. `publish-instagram.ts --schedule` (Worker, `channel: "instagram"`; carrossel de 5 slides quando disponível)
5. `publish-threads.ts --schedule` (Worker, `channel: "threads"`; só chunk único ≤500 chars)
6. Twitter/X via Buffer MCP — `prep-twitter-posts.ts` + `mcp__claude_ai_Buffer__create_post` por post, conduzido pelo orchestrator diretamente (fora do dispatch paralelo de scripts Bash — só alcançável via sessão de agente)
7. `brevo-diaria-stage5-dispatch.ts` — só se `consent.brevo === "auto"`; cria só o RASCUNHO

Após todos retornarem, **loop de review-test-email** roda em cima do draft da newsletter (Kit) — só via Gmail MCP, sem fallback via Chrome (#8205).

**Stage 5 não tem gate próprio** — dispatch puro (#1326). A única parada de toda a skill é o gate único do Stage 6 (§6c) — revisão visual do e-mail de teste pelo editor + agendamento (#8205).

### Etapa 5c — Resumo e continuação para o Stage 6 (#7983, MESMA sessão)

Stage 5 encerra o dispatch (newsletter draft + todos os canais sociais agendados + Brevo diária como rascunho) e, na mesma sessão, segue direto para o **Stage 6 (Agendamento)** — leia `.claude/agents/orchestrator-stage-6.md` e execute-o em seguida. Auto-reporter roda sem gate dentro do Stage 6 (#8205); relatório por email é gerado ao final, depois que o editor confirma o Schedule da newsletter na parada única de §6c.

## Output

- `_internal/newsletter-kit-published.json` — `broadcast_id`, `subject`, `status` — e `_internal/05-review-kit.json` — `review_status` (newsletter)
- `_internal/06-social-published.json` — posts com `platform`, `destaque`, `url`, `status`, `scheduled_at` (LinkedIn, Facebook, Instagram, Threads, Twitter/X)
- `_internal/brevo-diaria-published.json` — canal Brevo diária
- `_internal/.step-5-done.json` — sentinel de conclusao do Stage 5
- `_internal/.step-6-done.json` — sentinel de conclusao do Stage 6 (rodado na mesma sessão, #7983)
- `_internal/issues-draft.json`, `_internal/edition-report.html` — auto-reporter + relatório (Stage 6)

## Notas

- **Newsletter fica como rascunho até o gate do Stage 6.** Test email enviado, loop review concluído no Stage 5. O Schedule do Kit é feito no gate humano de §6c, **na mesma sessão** (#7983). LinkedIn, Facebook, Instagram, Threads e X saem agendados automaticamente (`--schedule`/`dueAt`) ainda no Stage 5; Brevo diária sai como rascunho (agendamento também acontece no gate do Stage 6).
- **Resume-aware**: re-rodar pula o que ja existe.
- **Continua sozinho para o Stage 6** (#7983) — não imprima `/diaria-6-agendamento` como próximo passo do editor. Essa skill continua existindo só como porta de **retomada** (sessão morreu entre dispatch e gate, ou o editor voltou horas depois).
- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
