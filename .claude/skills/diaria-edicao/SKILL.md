---
name: diaria-edicao
description: Roda as Etapas 1-4 da diar.ia.br (Pesquisa → Revisão). Uso — `/diaria-edicao AAMMDD [--no-gates] [--skip canal[,canal...]]`. Etapas 5-6 rodam em sessão separada — ver "Fronteira de contexto pós-gate 4" (#6171).
---

# /diaria-edicao

Executa as Etapas 1-4 da diar.ia.br (Pesquisa → Escrita → Imagens → Revisão). **Modo default: pre-gate** (#1523) — Stages 1-3 rodam auto-approve, o gate humano é no Stage 4 (Revisão); editor revisa HTML preview + social. Aprovado o gate, a sessão termina e instrui os comandos `/diaria-5-publicacao`/`/diaria-6-agendamento` numa sessão nova (#6171, ver "Fronteira de contexto pós-gate 4" no Passo 2b) — este comando não dispatcha publishers sozinho.

## Argumentos

- `$1` = data da edição no formato `AAMMDD` (ex: `260418`). **Se não passar, perguntar explicitamente** — nunca inferir a partir de `today()`. Sugerir amanhã como atalho principal (regra D+1 — edição é sempre o dia seguinte à pesquisa), com hoje como secundário, mas exigir confirmação:
  > "Você não passou a data da edição. Qual edição você quer processar? amanhã ({AAMMDD_amanha}) / hoje ({AAMMDD_hoje}) / outra (informe AAMMDD)"
- `--window N` (ou `--window-days N`, opcional) = janela de publicação em dias (inteiro ≥ 1). Quando presente, usar `window_days = N` direto, **sem perguntar**. Ausente → assumir o default (4 dias) silenciosamente, **sem gate** (#1751).
- `--no-gates` (opcional) = pular TODOS os gates, inclusive o gate de revisão do Stage 4 e a confirmação interativa do Stage 5. Auto-aprova tudo. Social scheduling e demais comportamentos permanecem normais.
- `--skip {canal[,canal...]}` (opcional, CSV) = **desde #6171, `/diaria-5-publicacao` roda numa sessão separada (ver "Fronteira de contexto pós-gate 4") — este comando não repassa `--skip` automaticamente.** Se passado aqui, a mensagem de próximo passo pós-gate 4 já inclui `--skip {lista}` no comando `/diaria-5-publicacao` sugerido (não precisa lembrar de repetir manualmente, só confirmar o comando impresso antes de rodar). Canais suportados: `newsletter`, `linkedin`, `facebook`, `instagram`, `threads`, `twitter`, `brevo` (#5772 — canal Brevo diária, segmento Pending/reativação). Sem `--skip`, o comportamento default do Stage 5 (#1326) se aplica — tudo automático. Ver `--skip` também documentado direto em `/diaria-5-publicacao` (mesma flag, mesmo efeito).

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

## Passo 1b — Rascunhar respostas a assinantes (§0-replies, #7166/#7168)

**Roda AQUI, no top-level desta sessão — nunca dentro do subprocesso spawnado no Passo 2.** Desde o #5744 os Stages 1-3 rodam num processo `claude -p` próprio (`scripts/run-edition-stages.ts`), que **não tem os conectores nativos claude.ai** (Gmail/Beehiiv/Chrome MCP só existem numa sessão interativa). §0-replies é 100% MCP — tentá-lo lá dentro (mesmo com `pre_gate=true` via `--session-supervised`) sempre falhou por falta de MCP, e é por isso que a seção parou de rodar desde o #5744 sem que ninguém notasse por ~2 semanas (#7166). A partir daqui, `--session-supervised` deixa de ter esse papel — não repassar a intenção de rodar §0-replies pro Passo 2; ela é decidida e executada aqui mesmo.

**Condição pra rodar:** roda **sempre que `--no-gates` NÃO foi passado** à invocação original de `/diaria-edicao` (editor presente) — equivalente a `shouldRunRepliesAtTopLevel(noGatesPassado)` (`scripts/lib/replies-top-level-gate.ts`, travado em teste). Com `--no-gates`: pular a seção inteira — **mesmo pulo, sempre logado**, ver parágrafo de skip abaixo (não existe caso "pular sem log" nesta seção: qualquer skip, por qualquer motivo, loga).

**Quando a condição bate**, seguir os passos 1-5 de `.claude/agents/orchestrator-stage-0-preflight.md` § "0-replies. Rascunhar respostas a assinantes" **exatamente como descritos ali**, com 2 ajustes:

1. **`{EDITION_DIR}`** ainda pode não existir em disco neste ponto (a criação acontece dentro do Stage 1, que só é spawnado no Passo 2 seguinte) — resolver o path via `npx tsx scripts/lib/find-current-edition.ts --resolve {AAMMDD}` (funciona mesmo pra edição nova, sem exigir que o diretório já exista) e `mkdir -p {EDITION_DIR}/_internal` antes de escrever `captured-replies.json`.
2. **Query de busca (passo 1 da seção referenciada, #7168):** usar `npx tsx -e "import { buildRepliesSearchQuery } from './scripts/lib/newsletter-reply-addresses.ts'; console.log(buildRepliesSearchQuery())"` em vez da string fixa `to:vjpixel@gmail.com subject:(Re OR Res) newer_than:7d` — a lista de endereços cobre agora `vjpixel@gmail.com`, `oi@news.diar.ia.br` (Kit) e `oi@reativa.diar.ia.br` (Brevo diária), com janela default de 14d. Backend de envio novo → adicionar 1 linha em `KNOWN_NEWSLETTER_REPLY_ADDRESSES` (mesmo arquivo).

**Skip (Gmail MCP indisponível, OU `--no-gates` foi passado): sempre logar antes de pular, nunca em silêncio** (#7166 item B — a causa da regressão de 2 semanas foi justamente um skip que não logou). Rodar diretamente (sem round-trip por `-e`/`join`, que quebraria o quoting do shell na mensagem/JSON de `--details`):
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 0 --agent orchestrator --level info \
  --message "0-replies skipped: Gmail MCP unavailable" \
  --details '{"section":"0-replies","reason":"gmail_mcp_unavailable"}'
```
(trocar por `"0-replies skipped: headless --no-gates"` / `"no_editor_supervision"` quando o motivo for `--no-gates`). Os textos exatos vêm de `buildRepliesSkipLogArgs()` (`scripts/lib/replies-skip-log.ts`) e estão travados em `test/replies-7166-7168.test.ts` — usar essas strings, não reformular.

**Primeiro efeito real em produção (declarar sempre no PR/anúncio que religa esta seção):** a seção não roda desde 260820 — a 1ª execução em produção processa até 14 dias de replies represadas de uma vez (backlog de assinantes que responderam nesse intervalo, incluindo os já creditados manualmente pro ciclo 2608 conforme `data/raffle-numbers.json`). Isso é seguro por desenho: (a) a seção só cria **rascunhos** no Gmail (`create_draft`, nunca `send`) — o editor revisa/edita/descarta cada um antes de qualquer envio; (b) a alocação de número de sorteio é idempotente por `(ciclo, email, edição)` — replies já creditadas manualmente não recebem número duplicado; (c) replies fora do prazo do concurso continuam sem número, guard já existente. Risco residual: um lote de vários rascunhos aparecendo de uma vez na caixa do editor no 1º run — cosmético, não funcional.

## Passo 2 — Stages 1-3 em sessões próprias, Stage 4+ no top-level (#5744)

**Rodar PRIMEIRO, antes de ler `orchestrator.md`:**

**Rodar em BACKGROUND** (`run_in_background: true` no tool Bash):

```bash
npx tsx scripts/run-edition-stages.ts --edition $1 --through 3{ --session-supervised se --no-gates NÃO foi passado à invocação ORIGINAL de /diaria-edicao}
```

Este comando roda os Stages 1, 2 e 3 **cada um num processo `claude` próprio**. Sessão nova nasce com contexto limpo, o que é o efeito de um `/clear` entre stages — algo que esta sessão não consegue fazer em si mesma (`/clear` é comando de usuário).

**`--session-supervised` (#6719) — sempre que o EDITOR está presente nesta sessão.** Todo spawn deste comando passa `--no-gates` a cada stage (é o que permite o subprocesso terminar sem ninguém ali para responder ao gate INTERNO dele) — mas isso não significa que a sessão é desassistida. Quando a invocação original de `/diaria-edicao` (esta conversa) **não** trazia `--no-gates`, o editor está presente e supervisionando, mesmo que os Stages 1-3 rodem headless por isolamento de contexto (#5744). **`--session-supervised` NÃO controla mais `orchestrator-stage-0-preflight.md` § 0-replies (#7166)** — essa seção já rodou no Passo 1b acima, no top-level, antes de qualquer spawn; o Stage 1 spawnado NUNCA tenta § 0-replies, independente desta flag (MCP não existe ali) — `pre_gate` fica sem consumidor dentro do Stage 1 spawnado a partir daqui (§ 0-replies era o único ponto que o lia). Continuar passando a flag é inofensivo (nenhum outro trecho do Stage 1 lê `pre_gate`) e preserva o sinal pra um futuro segundo consumidor; não vale a pena remover a plumbing por um campo vestigial. Omitir esta flag quando `--no-gates` FOI passado a `/diaria-edicao` — aí a sessão é de fato desassistida (comportamento inalterado).

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
- `pre_gate = true` se `--no-gates` NÃO foi passado (Stage 4 apresenta gate de revisão)
- `skip_channels = {csv passado em --skip, ou vazio}` — **não encaminhado internamente a nenhum stage** (Stage 5 nunca roda nesta sessão, ver "Fronteira de contexto pós-gate 4"). Serve só pra compor o comando `/diaria-5-publicacao {AAMMDD} --skip "{skip_channels}"` impresso na mensagem de próximo passo, quando não-vazio.


Sequência de etapas (do playbook em `.claude/agents/orchestrator.md`). **Desde o #5744, entrar direto na § 4** — as três primeiras já rodaram nos processos spawnados no Passo 2, e a § 0 junto com elas:

- ~~**§ 0 Setup**~~ — **NÃO re-executar.** `/diaria-1-pesquisa` roda a § 0 inteira por conta própria (refresh de `past-editions.md`, inbox drain, probes de MCP), e o resultado já está persistido em disco pelo #5414. Repetir aqui gasta de novo os checks que o subprocesso do Stage 1 acabou de fazer — que é exatamente o custo que o Passo 2 existe para cortar. O resume-aware da § 0b evitaria reprocessar os Stages 1-3, mas não evita repetir os checks.
- ~~**§ 1 Etapa 1 — Pesquisa**~~ — feita no Passo 2 (sentinela em disco)
- ~~**§ 2 Etapa 2 — Escrita**~~ — feita no Passo 2 (sentinela em disco)
- ~~**§ 3 Etapa 3 — Imagens**~~ — feita no Passo 2 (sentinela em disco)
- **§ 4 Etapa 4 — Revisão** (#1694):
  1. Pré-render técnico (HTML + imagens + upload Worker + close-poll)
  2. **GATE HUMANO** — apresenta resumo consolidado: destaques, títulos, links, lints, preview HTML + social ao editor
  3. Aprovado → grava sentinel `.step-4-done.json`
  → **PARE** (ver "Fronteira de contexto pós-gate 4" abaixo). `/diaria-edicao` termina aqui — Etapas 5 e 6 rodam como comandos separados.

**Modo pre-gate (default):** Stages 1-3 auto-approve. Stage 4 gate de revisão é o único ponto de interação antes do fim deste comando. `auto_approve = true` internamente para Stages 1-3; Stage 4 consulta editor no gate de revisão.

**Se `--no-gates`:** auto-aprovar Stages 1-3 e a confirmação do gate do Stage 4. `/diaria-edicao --no-gates` ainda termina no fim do Stage 4 — `--no-gates` pula CONFIRMAÇÕES, não a fronteira de sessão (ver abaixo). Etapa 5 (que teria dispatchado publishers automaticamente) só roda ao rodar `/diaria-5-publicacao {AAMMDD}` explicitamente.

### Fronteira de contexto pós-gate 4 (#6171)

`/diaria-edicao` **não** encadeia para a Etapa 5 no fim do Stage 4, mesmo tendo rodado as Etapas 1-4 na mesma invocação. Medição do #6171 (edição 260826, sessão de 989 turnos): o gate do Stage 4 sozinho — 433 turnos, 1h49 de revisão humana — inflou o contexto residente a ponto das Etapas 5 e 6 relerem esse histórico a cada tool call, ~268M tokens de `cache_read` evitáveis (a maior fatia dos ~US$115 da edição). Diferente dos Stages 1-3 (§Passo 2, #5744), que já rodam num processo `claude` isolado porque não têm gate, a Etapa 4 PRECISA da sessão do editor — não dá pra spawná-la headless. A fronteira segura fica então DEPOIS do gate: ao aprovar (ou auto-aprovar com `--no-gates`), o orchestrator escreve o sentinel do Stage 4, imprime as instruções de próximo passo, e a sessão termina — sem ler `orchestrator-stage-5.md`.

O editor (ou a automação que estiver conduzindo a sessão) abre uma sessão NOVA e roda:
```
/diaria-5-publicacao {AAMMDD}{ --skip "{skip_channels}" se --skip foi passado a /diaria-edicao}
```
seguido, quando esse comando terminar, de:
```
/diaria-6-agendamento {AAMMDD}
```
Cada uma dessas skills já é resumível via arquivo (#5578) — lê o estado da edição em `data/editions/{AAMMDD}/` e `_internal/`, não depende de nada que só existisse na conversa do Stage 4. O comportamento de publicação em si (dispatch automático dos canais, gates de Stage 5/6) **não muda** — só o ponto onde a sessão para de acumular contexto muda. Ver detalhe completo em `orchestrator-stage-4.md` §"Fluxo pós-gate — fronteira de contexto (#6171)".

Resume-aware: ao retomar, listar arquivos em `data/editions/{AAMMDD}/` e pular para o stage adequado conforme as condições do § 0 Setup — **com o teto do Stage 4 aplicado por cima**: se o § 0b determinar que o próximo stage acionável é 5 ou 6 (ex: sentinel `.step-4-done.json` já existe de uma run anterior), `/diaria-edicao` não lê `orchestrator-stage-5.md`/`orchestrator-stage-6.md` mesmo assim — imprime a mesma mensagem de "Fronteira de contexto pós-gate 4" acima e termina. O § 0b continua sendo a fonte de verdade sobre QUAL stage é o próximo; só quem decide SE esta sessão o executa é o teto do `/diaria-edicao`.

## Execução stage-a-stage com contexto limpo (#5414) — recomendado, custo bem menor

`/diaria-edicao` roda a pipeline inteira numa conversa só, mas isso não é necessário nem ideal: o custo de uma edição é, com boa aproximação, turnos × contexto residente, e rodar tudo numa sessão só deixa o contexto crescer sem interrupção — a auditoria de 260816 (#5414) mediu ~708M tokens numa edição real (159k→933k de contexto entre Stage 0 e o fim do Stage 4, sem nenhuma compactação até o Stage 4 estar quase pronto) contra ~360M simulados rodando cada stage com contexto limpo — **corte de ~49%**, sem remover um único passo do pipeline.

Rodar stage a stage já era suportado antes desta issue (as skills isoladas `/diaria-1-pesquisa`, `/diaria-2-escrita`, `/diaria-3-imagens`, `/diaria-4-revisao`, `/diaria-5-publicacao`, `/diaria-6-agendamento` sempre existiram, e o resume via sentinelas em disco já era o mecanismo padrão). O que faltava era **descartar o contexto entre stages com segurança**: os playbooks tinham 17 pontos que mandavam "setar em sessão" / "capturar como" — sinais de saúde de MCP/REST apurados no Stage 0 (`CHROME_MCP`, `GMAIL_MCP`, `BEEHIIV_MCP`, `CLARICE_REST`, `CLOUDFLARE_TOKEN_OK`), o dispatch do É IA? em background (Stage 1 → Stage 3), e 2 valores computados no meio do Stage 4 (`whatsapp_url`, `meta_description_suggestion`) — cujo único lugar de existência era a conversa. Fechado pelo #5414: esses 9 valores agora são persistidos em `{EDITION_DIR}/_internal/` (`preflight-state.json`, `eia-dispatch-state.json`, `stage4-capture-state.json` — ver `scripts/lib/preflight-state.ts`, `scripts/lib/eia-dispatch-state.ts`, `scripts/lib/stage4-capture-state.ts`) e cada stage que precisa deles lê do disco no próprio início, em vez de depender de "lembrar" da conversa.

**Na prática:** abrir uma sessão nova por stage é seguro e é o jeito recomendado de economizar token numa edição — encerrar a sessão depois de `/diaria-1-pesquisa`, abrir outra pra `/diaria-2-escrita {AAMMDD}`, e assim por diante, cada uma com contexto limpo (só o system prompt + CLAUDE.md + o playbook do próprio stage). O resume via sentinelas em disco (§0b do Stage 0, e o preflight de sentinel no início de cada stage isolado) garante que a sessão nova retome exatamente de onde a anterior parou. `/diaria-edicao` já aplica essa mesma receita automaticamente para as Etapas 1-3 (Passo 2, subprocessos via `run-edition-stages.ts`, #5744) e para a fronteira pós-Etapa-4 (acima, #6171) — o que resta opcional é só quebrar as Etapas 1-4 em sessões manuais adicionais, se o editor quiser medir custo por stage individualmente.

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
