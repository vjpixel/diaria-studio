---
name: diaria-edicao
description: Roda a pipeline completa da diar.ia.br (5 etapas). Uso — `/diaria-edicao AAMMDD [--no-gates] [--skip canal[,canal...]]`.
---

# /diaria-edicao

Executa a pipeline completa da diar.ia.br. **Modo default: pre-gate** (#1523) — Stages 0-3 rodam auto-approve, o gate humano principal é no Stage 4 (Revisão) antes do dispatch dos publishers. Editor revisa HTML preview + social; aprovado → Stage 5 (Publicação) dispara.

## Argumentos

- `$1` = data da edição no formato `AAMMDD` (ex: `260418`). **Se não passar, perguntar explicitamente** — nunca inferir a partir de `today()`. Sugerir amanhã como atalho principal (regra D+1 — edição é sempre o dia seguinte à pesquisa), com hoje como secundário, mas exigir confirmação:
  > "Você não passou a data da edição. Qual edição você quer processar? amanhã ({AAMMDD_amanha}) / hoje ({AAMMDD_hoje}) / outra (informe AAMMDD)"
- `--window N` (ou `--window-days N`, opcional) = janela de publicação em dias (inteiro ≥ 1). Quando presente, usar `window_days = N` direto, **sem perguntar**. Ausente → assumir o default (4 dias) silenciosamente, **sem gate** (#1751).
- `--no-gates` (opcional) = pular TODOS os gates, inclusive o gate de revisão do Stage 4 e a confirmação interativa do Stage 5. Auto-aprova tudo. Social scheduling e demais comportamentos permanecem normais.
- `--skip {canal[,canal...]}` (opcional, CSV) = encaminha lista de canais ao Stage 5 como `skip_channels`. Canais suportados: `newsletter`, `linkedin`, `facebook`, `instagram`, `threads`, `twitter`, `brevo` (#5772 — canal Brevo diária, segmento Pending/reativação). Canais listados ficam `pending_manual` no consent (`build-publish-consent.ts --skip "{lista}"`, path 1 de §5b); o Stage 5 executa pré-render completo mas NÃO dispatcha esses canais. Sem `--skip`, o comportamento default do Stage 5 (#1326) se aplica — se editor não responder ao gate interativo, tudo é automático. Use `--skip newsletter,linkedin,facebook` em runs headless/automáticas (Task Scheduler) para impedir dispatch sem supervisão (#2068).

## Pré-requisitos

Antes de iniciar, verifique:
1. `context/audience-profile.md` existe e não é placeholder. Se for, avise: rode `/diaria-atualiza-audiencia` primeiro (muda lento, rodar semanalmente/mensalmente).
2. `context/sources.md` existe. Se não, rode `npm run sync-sources`.
3. `data/past-editions.md` **não precisa estar atualizado** — o orchestrator regenera automaticamente via Beehiiv MCP no Stage 0.

## Passo 0 — Sincronizar código com origin/master (#2686)

**Antes de qualquer trabalho do Stage 0**, sincronizar o checkout local com `origin/master` para garantir que a edição rode com a versão mais recente do pipeline. Rodadas overnight/develop mergeiam frequentemente; código defasado re-introduz bugs corrigidos.

**Invocação longa — passar `timeout: 570000` (570s) explícito no tool Bash desta chamada.** `git-sync.ts` usa `GIT_FETCH_TIMEOUT_MS = 480000` (8min) internamente pro `git fetch origin` (#5302) — um checkout muito atrasado (muitos refs novos de uma vez) pode legitimamente levar perto disso. O default do tool Bash é 120000ms (2min): sem override, o harness mata o processo `npx tsx scripts/sync-code.ts` INTEIRO bem antes do `spawnSync` interno conseguir disparar seu próprio timeout e imprimir o diagnóstico `fetch_timeout` — pior que não ter timeout próprio nenhum. 570000ms fica abaixo do teto do tool Bash (600000ms) com margem pro `spawnSync` interno (480000ms) terminar + overhead de start/teardown do `npx tsx` (revisado no #5313, achado do review consolidado — a versão anterior desta nota pedia 600000ms, que empatava com o teto sem sobrar margem nenhuma):

```bash
npx tsx scripts/sync-code.ts
```
(Bash tool: `timeout: 570000`)

O script imprime JSON com o resultado (campos `outcome`, `branch_before`, `warnings`). **Parsear o JSON do stdout** e extrair os valores individuais — nunca passar o blob inteiro pro `--details`. Logar via `log-event.ts`, escolhendo `--level info` para os 3 outcomes de sucesso e `--level warn` para os demais (coluna `--level` da tabela):

```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 0 --agent orchestrator \
  --level {info ou warn, conforme a tabela} --informational --message "git-sync: {outcome}" \
  --details '{"outcome":"{outcome}","branch_before":"{branch_before}"}'
```

(`--informational` evita que warns de sync virem issues falsas no auto-reporter, análogo a §0k/§0l do preflight.)

**Comportamento por outcome:**

| outcome | `--level` | ação |
|---|---|---|
| `synced` / `synced_stashed` / `already_up_to_date` | `info` | ✅ prosseguir normalmente |
| `fetch_failed` | `warn` | ⚠️ avisar editor ("offline, erro de rede ou credencial — edição continua com código local") e prosseguir |
| `fetch_timeout` (#5302) | `warn` | ⚠️ `git fetch origin` foi morto pelo timeout (não necessariamente offline — fetch grande, refs remotos podem já estar atualizados localmente); avisar editor e prosseguir |
| `ff_failed` | `warn` | ⚠️ avisar editor ("código divergiu de origin — edição continua com cópia local; considere resolver manualmente") e prosseguir |
| `stash_failed` / `stash_pop_failed` | `warn` | ⚠️ avisar editor com a mensagem de warning do resultado e prosseguir |
| `stash_partial_failure` (#3411) | `warn` | ⚠️ stash saiu com erro mas CRIOU um stash apesar disso (ex: falha parcial ao limpar untracked) — recuperado automaticamente via pop; avisar editor com a mensagem e prosseguir |
| `stash_partial_failure_unrecovered` (#3411) | `warn` | 🛑 idem, mas o pop automático TAMBÉM falhou — stash preservado (nunca descartado), avisar editor com URGÊNCIA (mensagem cita o hash do stash para investigação manual) e prosseguir |
| `checkout_failed` | `warn` | ⚠️ avisar editor ("estava em outra branch e não foi possível voltar para master") e prosseguir |
| `sync_in_progress` (#3423) | `warn` | ⚠️ outro `syncCode()` já está rodando neste checkout (lock ativo) — sync desta rodada foi pulado para evitar popar o stash de um processo concorrente; avisar editor ("código pode estar levemente desatualizado, outra sincronização em andamento") e prosseguir |

**Regras invariáveis:**
- **Nunca bloquear a edição por falha de sync** — `proceed` é sempre `true` no resultado. Falha de sync vira warning, nunca halt.
- **Só no início, nunca mid-edição.**
- **Idempotente no resume.** Re-rodar `/diaria-edicao {mesmo AAMMDD}` faz o sync novamente sem efeito colateral indesejado.
- **Nunca forçar merge.** Usa `--ff-only` exclusivamente; divergência vira warn.

## Passo 1 — Confirmar janela de publicação aceita

Converter `$1` (AAMMDD) para ISO date interno:
```bash
node -e "const s='$1';process.stdout.write('20'+s.slice(0,2)+'-'+s.slice(2,4)+'-'+s.slice(4,6))"
```
Armazenar o resultado como `$ISO` (ex: `260423` → `2026-04-23`). Usar `$ISO` em todo Date math abaixo.

1. **Janela = 4 dias corridos terminando em D+0** (#315).
   Stage 1 roda em D+0 (dia antes da publicação). Endpoint superior = D+0 = `$ISO − 1 dia`.
   ```bash
   node -e "const d=new Date('$ISO');d.setUTCDate(d.getUTCDate()-1);process.stdout.write(d.toISOString().slice(0,10))"
   ```
   Armazenar como `WINDOW_END`. `window_days = 4` fixo.
   ```bash
   node -e "const d=new Date('$WINDOW_END');d.setUTCDate(d.getUTCDate()-3);process.stdout.write(d.toISOString().slice(0,10))"
   ```
   Armazenar como `window_start`.

**Resolução de `window_days` (#1751 — sem gate obrigatório):**

1. **Arg `--window N` / `--window-days N` presente:** validar N inteiro ≥ 1. Válido → `window_days = N`, recalcular `window_start` a partir de `WINDOW_END` (`WINDOW_END − (N−1)`). Seguir direto pro Passo 2, **sem perguntar**. Inválido (não-inteiro / < 1) → aí sim perguntar (fallback, ver abaixo).
2. **Sem arg de janela (caso comum):** assumir o **default 4 dias silenciosamente** e seguir pro Passo 2 — **sem o gate de confirmação**. (Antes exigia `ok`; #1751 torna implícito.) Logar a janela efetiva (opcional) em `data/run-log.jsonl` com `source: "default"`.
3. **`--no-gates`:** idêntico — usar os valores calculados sem perguntar.

Logar `window_days` efetiva com `source: "arg" | "default"` pra rastreabilidade (análogo a `_internal/05-publish-consent.json`, #1326), quando viável.

**Fallback (só quando `--window` veio inválido):** exibir e aguardar resposta:

   ```
   Janela de publicacao aceita: {window_start} -> {WINDOW_END} (4 dias)
   --window invalido. Digite ok para o default (4) ou um numero de dias:
   ```

   Interpretar: vazia / "ok" / "sim" → default 4; inteiro N ≥ 1 → `window_days = N`; outra coisa → repetir.

## Passo 2 — Stages 1-3 em sessões próprias, Stage 4+ no top-level (#5744)

**Rodar PRIMEIRO, antes de ler `orchestrator.md`:**

**Rodar em BACKGROUND** (`run_in_background: true` no tool Bash):

```bash
npx tsx scripts/run-edition-stages.ts --edition $1 --through 3
```

Este comando roda os Stages 1, 2 e 3 **cada um num processo `claude` próprio**. Sessão nova nasce com contexto limpo, o que é o efeito de um `/clear` entre stages — algo que esta sessão não consegue fazer em si mesma (`/clear` é comando de usuário).

**Por que background e não `timeout:`.** Os três stages somam tipicamente ~40min (na edição 260814: 13min + 34min + 3min). O teto do tool Bash é 600000ms — **10 minutos**, e não há valor maior a passar. Uma chamada síncrona seria cortada no meio em praticamente toda invocação, e o pior não é a demora: cortada, a sessão não recebe nem o resumo nem o exit code, e fica sem saber se o stage em andamento terminou, morreu ou continua rodando órfão. Em background o comando roda até o fim e a sessão é reinvocada quando ele sai.

Enquanto roda, **não ficar consultando o progresso** — cada consulta traz saída para a conversa, que é o contexto que este passo existe para não carregar. Esperar a notificação de término.

**Por que isto importa mais que qualquer outra otimização do pipeline.** Na edição 260814 o Stage 4 sozinho custou 581M dos 999M de tokens de entrada da edição inteira — não porque faça mais trabalho, mas porque herdava o contexto acumulado dos stages anteriores. Rodando com contexto limpo, caiu para 163M (#5738). Tirar os Stages 1-3 desta sessão faz o Stage 4 começar quase do zero, que é onde está o corte.

**O que NÃO fazer com a saída.** O script imprime só um resumo por stage (ok/pulado/falhou, duração). Ele descarta o stdout dos stages de propósito. **Não rodar de novo com `--json` "para ver o que aconteceu", não pedir o log completo, não colar a saída dos stages na conversa** — qualquer uma dessas coisas recria nesta sessão exatamente o contexto que o comando existe para evitar, e o ganho evapora sem que nada quebre.

**Se um stage falhar**, o script para ali (não roda os seguintes), devolve exit code != 0 e nomeia o stage no resumo. Reportar ao editor qual stage falhou e o tail da falha; não tentar consertar spawnando de novo às cegas. Reinvocar o mesmo comando é seguro e retoma de onde parou — stage com sentinela em disco não re-spawna.

**Depois que o comando voltar com exit 0**, seguir a partir da **§ 4 Etapa 4 — Revisão** do playbook, no top-level, como descrito abaixo. Os Stages 1-3 já estão feitos e seus sentinelas estão em disco; **não re-executar § 1, § 2 nem § 3.**

Os Stages 4, 5 e 6 continuam no top-level porque é onde ficam os dois gates humanos de projeto (revisão e agendamento) e o `javascript_tool` do `publish-newsletter`, que é restrito ao top-level.

## Passo 2b — Executar o restante do playbook no top-level (#207)

**Você (top-level Claude Code) lê `.claude/agents/orchestrator.md` e executa o playbook stage-a-stage diretamente.** **Não delegue a um subagente `orchestrator` via `Agent`** — o runtime bloqueia recursão de Agent dentro de subagentes (issue #207). O top-level tem `Agent` disponível e pode dispatchar `source-researcher`, `discovery-searcher`, `eia-composer`, `research-reviewer`, `scorer`, `writer`, `title-picker`, `social-writer` (#3991, reverte #3486), `social-curto` (#3992), `auto-reporter` em paralelo conforme cada stage prescreve. **`publish-newsletter` também é executado pelo top-level direto como playbook (#1054)** — não dispatchá-lo via `Agent` porque `javascript_tool` é restrita ao top-level e o paste-into-htmlSnippet falha em subagentes.

Variáveis pra alimentar o playbook (passar mentalmente como contexto, não como prompt de Agent):
- `edition_date = $1` (AAMMDD)
- `edition_iso = 20${AAMMDD.slice(0,2)}-${AAMMDD.slice(2,4)}-${AAMMDD.slice(4,6)}`
- `window_days = {valor confirmado no Passo 1}`
- `auto_approve = true` (Stages 1-3 sempre auto-approve em `/diaria-edicao` — pre-gate mode #1523). **Desde o #5744 os Stages 1-3 nem rodam aqui** (ver Passo 2): eles são spawnados por `run-edition-stages.ts`, que já passa `--no-gates` a cada um. Esta linha só continua valendo para uma execução manual do playbook inteiro no top-level, fora do fluxo normal.
- `pre_gate = true` se `--no-gates` NÃO foi passado (Stage 4 apresenta gate de revisão; Stage 5 apresenta confirmação de canais)
- `skip_channels = {csv passado em --skip, ou vazio}` — encaminhado ao Stage 5 §5b; se não-vazio, Stage 5 usa path 1 (`build-publish-consent.ts --skip "{skip_channels}"`) sem gate interativo, sem fallback default-auto (#1326/#2068)


Sequência de etapas (do playbook em `.claude/agents/orchestrator.md`). **Desde o #5744, entrar direto na § 4** — as três primeiras já rodaram nos processos spawnados no Passo 2, e a § 0 junto com elas:

- ~~**§ 0 Setup**~~ — **NÃO re-executar.** `/diaria-1-pesquisa` roda a § 0 inteira por conta própria (refresh de `past-editions.md`, inbox drain, probes de MCP), e o resultado já está persistido em disco pelo #5414. Repetir aqui gasta de novo os checks que o subprocesso do Stage 1 acabou de fazer — que é exatamente o custo que o Passo 2 existe para cortar. O resume-aware da § 0b evitaria reprocessar os Stages 1-3, mas não evita repetir os checks.
- ~~**§ 1 Etapa 1 — Pesquisa**~~ — feita no Passo 2 (sentinela em disco)
- ~~**§ 2 Etapa 2 — Escrita**~~ — feita no Passo 2 (sentinela em disco)
- ~~**§ 3 Etapa 3 — Imagens**~~ — feita no Passo 2 (sentinela em disco)
- **§ 4 Etapa 4 — Revisão** (#1694):
  1. Pré-render técnico (HTML + imagens + upload Worker + close-poll)
  2. **GATE HUMANO** — apresenta resumo consolidado: destaques, títulos, links, lints, preview HTML + social ao editor
  3. Aprovado → grava sentinel `.step-4-done.json`
  → aguarda Stage 5
- **§ 5 Etapa 5 — Publicação** (prereq: sentinel Stage 4 aprovado):
  1. Confirmação de canais (interativa ou via `--skip`)
  2. Dispatch publishers paralelos (Beehiiv + Facebook + LinkedIn)
  3. Test email + review loop
  4. Auto-reporter + relatório por email
  → fim

**Modo pre-gate (default):** Stages 1-3 auto-approve. Stage 4 gate de revisão é o único ponto de interação antes do dispatch. `auto_approve = true` internamente para Stages 1-3; Stage 4 consulta editor no gate de revisão; Stage 5 executa em sequência após aprovação.

**Se `--no-gates`:** auto-aprovar TUDO, inclusive o gate do Stage 4 e a confirmação interativa do Stage 5. Pipeline roda fim-a-fim sem interação.

Resume-aware: ao retomar, listar arquivos em `data/editions/{AAMMDD}/` e pular para o stage adequado conforme as condições do § 0 Setup.

## Execução stage-a-stage com contexto limpo (#5414) — recomendado, custo bem menor

`/diaria-edicao` roda a pipeline inteira numa conversa só, mas isso não é necessário nem ideal: o custo de uma edição é, com boa aproximação, turnos × contexto residente, e rodar tudo numa sessão só deixa o contexto crescer sem interrupção — a auditoria de 260816 (#5414) mediu ~708M tokens numa edição real (159k→933k de contexto entre Stage 0 e o fim do Stage 4, sem nenhuma compactação até o Stage 4 estar quase pronto) contra ~360M simulados rodando cada stage com contexto limpo — **corte de ~49%**, sem remover um único passo do pipeline.

Rodar stage a stage já era suportado antes desta issue (as skills isoladas `/diaria-1-pesquisa`, `/diaria-2-escrita`, `/diaria-3-imagens`, `/diaria-4-revisao`, `/diaria-5-publicacao`, `/diaria-6-agendamento` sempre existiram, e o resume via sentinelas em disco já era o mecanismo padrão). O que faltava era **descartar o contexto entre stages com segurança**: os playbooks tinham 17 pontos que mandavam "setar em sessão" / "capturar como" — sinais de saúde de MCP/REST apurados no Stage 0 (`CHROME_MCP`, `GMAIL_MCP`, `BEEHIIV_MCP`, `CLARICE_REST`, `CLOUDFLARE_TOKEN_OK`), o dispatch do É IA? em background (Stage 1 → Stage 3), e 2 valores computados no meio do Stage 4 (`whatsapp_url`, `meta_description_suggestion`) — cujo único lugar de existência era a conversa. Fechado pelo #5414: esses 9 valores agora são persistidos em `{EDITION_DIR}/_internal/` (`preflight-state.json`, `eia-dispatch-state.json`, `stage4-capture-state.json` — ver `scripts/lib/preflight-state.ts`, `scripts/lib/eia-dispatch-state.ts`, `scripts/lib/stage4-capture-state.ts`) e cada stage que precisa deles lê do disco no próprio início, em vez de depender de "lembrar" da conversa.

**Na prática:** abrir uma sessão nova por stage é seguro e é o jeito recomendado de economizar token numa edição — encerrar a sessão depois de `/diaria-1-pesquisa`, abrir outra pra `/diaria-2-escrita {AAMMDD}`, e assim por diante, cada uma com contexto limpo (só o system prompt + CLAUDE.md + o playbook do próprio stage). O resume via sentinelas em disco (§0b do Stage 0, e o preflight de sentinel no início de cada stage isolado) garante que a sessão nova retome exatamente de onde a anterior parou. `/diaria-edicao` numa sessão única continua funcionando igual — nada neste ponto mudou o comportamento dela, só passou a ser opcional manter tudo numa conversa só.

**O que isso não cobre:** só os 9 valores acima foram auditados e persistidos. Se uma sessão nova de algum stage notar um comportamento diferente do que rodar tudo numa conversa só (algo que só existia "na cabeça" do stage anterior e não em nenhum arquivo), é sinal de mais um ponto não identificado — reportar em issue nova (o #5419 cobre rodar uma edição de controle formal comparando os dois modos; até lá, tratar qualquer divergência como achado a investigar, não como esperado).

## Outputs

Todos em `data/editions/{AAMMDD}/` (ex: `260418/`):
- `01-categorized.md`, `01-eia.md`, `01-eia-A.jpg`, `01-eia-B.jpg` (edições antigas pré-#192: `01-eia-real.jpg`/`01-eia-ia.jpg`)
- `02-reviewed.md`
- `03-social.md`
- `04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-1x1.jpg`, `04-d3-1x1.jpg`
- `05-published.json`
- `06-social-published.json`
- `_internal/` — JSON intermediários, drafts, diffs, prompts
