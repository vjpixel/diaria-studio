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

## Relacionadas

#6930 (a proposta e o desenho), #6716 (o vazamento de Sonnet no wrapper),
#6926 (o merger automático de que o lane depende), #6864 (por que a condição
(b) é mecânica), #5608 e #6714 (a regra a que isto abre exceção), #6935 (o
teto do `CLAUDE.md`).
