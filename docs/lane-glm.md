# Lane de piloto em glm-5.3-flash (#6930)

Detalhamento da exceção apontada em `CLAUDE.md`, seção **"NUNCA trocar a conta
claude.ai pela API (#5608)"**. A regra ali continua valendo por padrão: nenhuma
sessão de Claude Code deste projeto autentica por API pay-per-token nem por
gateway de terceiro. Este arquivo descreve a **única** exceção aberta, e o que
ela não autoriza.

Mora fora do `CLAUDE.md` porque aquele arquivo é o único carregado
incondicionalmente em toda sessão e em todo dispatch de subagente — e está a
**1 byte** do teto de 76.800 (`test/claude-md-size.test.ts`, #5904). Ver #6935.

## O que é

Um lane de execução de **piloto**, decidido pelo editor em 01/09/2026, cujo
objetivo declarado é duplo: **drenar a fila técnica** (31 issues no track
`overnight` no dia da decisão) e **medir o custo** de `z-ai/glm-5.3-flash` sob
volume real.

Ele invoca `hermes/scripts/claude-openrouter.sh`, que seta `ANTHROPIC_BASE_URL`
+ `ANTHROPIC_AUTH_TOKEN` apontando para o OpenRouter — exatamente o padrão que
o #6714 proibiu. Daí precisar de exceção escrita.

## Condições — todas verificáveis; a (b) é mecânica

### (a) Só issues de aceite mecânico

Elegível é a issue cuja **correção seja decidida por teste/CI**, não por
julgamento. **Não existe label nem script que classifique isso** — não finja
que existe. É critério de seleção do coordenador no despacho, aplicado à mão e
registrado por unidade. `classifyExecTrack` (`scripts/lib/issue-exec-track.ts`)
responde outra pergunta: "qual sessão pega esta issue", não "o aceite dela é
mecânico".

### (b) Produtor apenas — imposto pelo `--tools`

O lane **não mergeia, não revisa, não faz triagem**. Isso é imposto pela
allowlist de ferramentas da invocação, que **omite** `gh pr merge`,
`gh pr review` e `gh issue close|edit` — no molde de
`hermes/scripts/continuo-pr-review.sh`.

**Instrução de prompt não conta.** O #6864 já concluiu neste repo que "remover a
capacidade é mais forte que confiar no texto", depois de o #6849 mostrar que
nenhum discriminador textual separava review legítimo de review fabricado.
`Bash` irrestrito reabre exatamente o que o #6864 fechou.

O lane abre PR em branch `continuo/*`; quem julga é `continuo-pr-review.sh`
(Sonnet, assinatura claude.ai) mais os portões determinísticos do #6926.

**#6926 ainda estava ABERTA quando esta exceção foi escrita**, e ela é
pré-requisito do piloto — não decoração. Enquanto não entrar, o único merger
de PR `continuo/*` é o pickup manual do `/diaria-overnight`, que roda quando o
editor o inicia. Sem merger automático, as PRs do lane empilham exatamente
como a #6901 empilhou por 10h29, e o lane barato vira uma fila que só o editor
drena. **O piloto não começa antes da #6926 mergear.**

### (c) `--model` explícito, sempre

A invocação passa **`--model z-ai/glm-5.3-flash`**. Não é detalhe: sem
`--model`, `claude-openrouter.sh` roda a `MODELS_DEFAULT` inteira
(`dots-studio/dots-3-note-preview:free` → `poolside/laguna-s-2.1:free` →
`z-ai/glm-5.3-flash`), e a exceção passaria a cobrir três modelos, dois deles
nunca avaliados aqui.

O `export` continua **escopado ao subprocesso** do wrapper, nunca persistente
no shell — o padrão de erro do #6714 segue proibido.

### (d) Custo medido, com o vazamento nomeado

- **Por dia e por modelo:** `GET /api/v1/activity` do OpenRouter, com
  `OPENROUTER_MANAGEMENT_KEY` (no Doppler). O endpoint **não cobre o dia
  corrente** — não serve para janela móvel de 24h.
- **Por unidade:** snapshot de `GET /api/v1/credits` antes e depois.

O relatório **tem** que separar GLM de Sonnet, porque **o vazamento do #6716
continua aberto**: nos dias medidos, o Sonnet auxiliar não-pedido custou mais
que todo o GLM do dia (31/08: US$ 0,96 de Sonnet, 100% do gasto do dia). Esta
exceção **não implica** que ele foi consertado.

## Teto e reversão

**Teto: 10 unidades.** Esgotadas, o piloto acaba — continuar exige decisão nova
e escrita. **Reverter é apagar o ponteiro no `CLAUDE.md` e este arquivo.**

**Critérios de morte adicionais (#6930/#6941, especificados durante a
construção do harness — mecânicos, em `scripts/lib/glm-lane-gate.ts`,
checados a cada despacho por `scripts/check-glm-lane-gate.ts`):**

2. **Zero PRs MERGEADAS nos 3 primeiros despachos** (corrigido de "abertas"
   pra "mergeadas" no #6953, achado ao vivo na unidade 2 — abrir PR que não
   consegue mergear não é sucesso) — sinal medido em #6922 (10 ticks
   consecutivos do primário mais barato: zero claims, zero PRs, relatório
   coerente). O modo de falha do modelo barato em trabalho autônomo não é
   "erra", é "para cedo e relata bem". `check-glm-lane-gate.ts` consulta o
   `gh` ao vivo pro estado de merge das PRs das 3 primeiras unidades a cada
   avaliação do gate — o merge pode acontecer bem depois do despacho que
   abriu a PR, então não dá pra gravar isso em `units.jsonl` (append-only)
   no momento do registro.
3. **Média de rodadas de review > 2** (inerte até um reconciliador de
   `reviewRounds` existir — ver `GlmLaneUnitRecord` em `glm-lane-gate.ts`).
4. **`$/issue` do GLM acima do equivalente no lane Sonnet** (inerte até
   `GLM_LANE_SONNET_COST_PER_ISSUE_USD` ser configurada — sem baseline, o
   repo não tem hoje uma fonte pronta pra esse número; decisão explícita de
   não inventar um).

Unidade que falhou por infraestrutura (timeout, rede — `status:
"infra-error"` em `units.jsonl`) ainda conta pro teto de 10, mas é excluída
dos critérios 2-4, que julgam o MODELO, não a infra.

## O que a exceção NÃO autoriza

- Não se pronuncia sobre a **delegação do contínuo**, que já usa o mesmo
  wrapper com a cadeia default e é anterior a esta decisão.
- Não afrouxa nada para as sessões do **pipeline editorial**, para
  `/diaria-edicao`, nem para qualquer sessão que **toque conector** claude.ai:
  para essas, "sessão de Claude Code, nunca" segue literal. O lane, por
  autenticar pelo gateway, **não tem** Beehiiv nem Gmail — nada que dependa
  deles vai para ele.

## Custo de referência medido

| dia | modelo | requests | USD | USD/request |
|---|---|---:|---:|---:|
| 29/08 | `z-ai/glm-5.3-flash` | 613 | 1,7160 | 0,0028 |
| 28/08 | `z-ai/glm-5.3-flash` | 69 | 0,1016 | 0,0015 |

## Harness (#6930, `--pr N` no #6953)

`scripts/dispatch-glm-lane-unit.sh <ISSUE> [--pr N]` — despacha 1 unidade.
Sem `--pr`, cria branch+worktree do zero a partir de `origin/master` (1ª
rodada). **Com `--pr N`** (#6953, achado ao vivo na unidade 2 — a #6950
recebeu 3 findings de review e não tinha como o harness endereçá-los sem
duplicar PR): faz checkout da branch HEAD da PR N existente (`gh pr view N
--json headRefName`), injeta no prompt os comentários de review já
postados nela (`gh pr view N --json comments`), e comita POR CIMA do que
já existe — `gh pr create` fica FORA do `--tools` desse modo
(mecanicamente impossível duplicar, mesma disciplina do resto do harness).
`git push` continua escopado à branch EXATA (agora a da PR). O prompt de
ambos os modos inclui um guard explícito contra esperar CI dentro da
unidade (`gh pr checks`/`gh run watch`/qualquer laço de poll) — achado ao
vivo: a unidade 2 ficou girando DEPOIS de abrir a PR (provavelmente
esperando CI), custando 22× mais que a unidade que não esperou nada
(US$0,2407 vs. US$0,0108).

**Retry via `--pr N` consome 1 slot do teto de 10 e entra normalmente no
critério "3 primeiras" (achado de review, #6953, não resolvido — registrado
de propósito):** cada invocação do script grava um registro NOVO em
`units.jsonl`, `--pr` incluso. Uma issue que precisou de 2 rodadas (1ª +
1 retry `--pr`) consome 2 dos 10 slots do piloto por 1 issue só, e se esse
retry cair entre as 3 primeiras unidades despachadas, o critério de morte 2
passa a julgar 2 registros da MESMA issue/PR em vez de 3 issues
independentes — dilui exatamente o tipo de sinal estatístico que o #6922
media (comportamento do modelo em trabalho autônomo através de issues
distintas). Não corrigido nesta PR — decisão a tomar quando/se isso
acontecer na prática (contar por issue única em vez de por registro?
excluir retries do teto?).

Impõe (b)
e (c) mecanicamente: `--tools` explícito omite `gh pr merge`/`gh pr
review`/`gh issue close|edit` E escopa `git`/`npm`/`npx` a subcomandos
específicos (nunca `Bash(git:*)`/`Bash(npm:*)`/`Bash(npx:*)` genéricos —
achado de review, #6941: esses genéricos permitiam `git push` direto pra
`master` e `npm exec -- gh pr merge` driblando o allowlist inteiro);
`--model z-ai/glm-5.3-flash` sempre passado. **NÃO reivindica a issue
sozinho** — a reivindicação é responsabilidade do COORDENADOR, como comando
standalone ANTES de chamar o script (`session-registry.ts claim-issue`;
achado de review: `--session-id` só é injetado automaticamente numa
chamada de TOPO da ferramenta Bash, nunca numa chamada enterrada dentro de
um script — um `claim-issue` daqui dentro sempre falharia). O script só
CONFERE que a claim existe (`is-claimed`) e recusa despachar se não achar.
Roda num worktree isolado (removido ao final, sucesso ou falha), invoca
`hermes/scripts/claude-openrouter.sh` UMA VEZ (nunca sessão de vida longa),
tira snapshot de `/api/v1/credits` (`scripts/glm-lane-credits.ts`) antes e
depois, e registra a unidade append-only em `data/glm-lane/units.jsonl`
(`scripts/record-glm-lane-unit.ts`) — incluindo se a invocação terminou
(`status: "completed"`) ou falhou por infra (`"infra-error"`, excluído dos
critérios de morte 2-4 acima).

Antes de CADA despacho, `scripts/check-glm-lane-gate.ts` (lógica pura em
`scripts/lib/glm-lane-gate.ts`) avalia o teto de 10 unidades e os critérios
de morte contra o histórico já registrado — recusa a 11ª unidade e
qualquer unidade além de um critério disparado, por construção. A condição
(a) — issue de aceite mecânico — continua seleção humana; o harness
recebe o número da issue já escolhida, nunca decide isso sozinho.

Testes: `test/glm-lane-gate.test.ts`, `test/glm-lane-credits.test.ts`,
`test/check-glm-lane-gate.test.ts`, `test/record-glm-lane-unit.test.ts`,
`test/dispatch-glm-lane-unit.test.ts`. **Duas unidades reais já
despachadas (01/09/2026):** #6928 (US$0,0108, 123s, GLM acertou) e #6950
(US$0,2407, review com 3 findings incluindo 1 P1 — insumo do teste do
`--pr N` acima, não corrigido manualmente de propósito).

**Risco residual, não fechado por este harness**: `--tools` restringe
subcomandos específicos, mas não é uma sandbox — um modelo adversarial com
`Write` ainda pode escrever um arquivo `.ts` que chama `gh pr merge` via
`execSync` e rodá-lo com `Bash(npx tsx:*)`. Fechar isso por completo exige
sandbox de processo/container, fora de escopo desta PR (mesmo risco que
já existe, sem escopo NENHUM de `--tools`, na delegação padrão do
contínuo — ver `hermes-diaria-continuo/SKILL.md` §4 passo 2).

## Relacionadas

#6930 (a proposta e o desenho), #6716 (o vazamento de Sonnet no wrapper),
#6926 (o merger automático de que o lane depende), #6864 (por que a condição
(b) é mecânica), #5608 e #6714 (a regra a que isto abre exceção), #6935 (o
teto do `CLAUDE.md`), #6922 (o modo de falha "para cedo e relata bem" que
motiva o critério de morte 2), #6941 (review do harness — achados que
endureceram `--tools`, `status`/infra-error, e moveram claim-issue pra
fora do script), #6953 (unidade 2 real expôs o gap "abriu PR" vs. "PR
mergeou" e o CI-wait dentro da unidade; adiciona `--pr N`).
