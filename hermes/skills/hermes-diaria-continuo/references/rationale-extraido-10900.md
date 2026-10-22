---
name: hermes-diaria-continuo-rationale-10900
description: Rationale/histórico extraído do SKILL.md do hermes-diaria-continuo na v0.5.18 (#10900) para abrir espaço sob o teto de tamanho — o COMO segue no SKILL.md, aqui fica o PORQUÊ.
platforms: [linux]
metadata:
  hermes:
    tags: [continuo, rationale, historico]
---

Parágrafos movidos verbatim do `SKILL.md` na v0.5.18 (#10900, 22/10/2026),
quando o suporte multi-repo (issues do `vjpixel/diaria-design`) entrou e o
arquivo estava a 64 bytes do teto de `test/hermes-diaria-continuo-skill-size.test.ts`.
A instrução operacional (comando, condição) ficou no SKILL.md com um ponteiro
para cá.

## §1 — passo 1b: por que ler `last-tick-report.md` em vez de `context_from`

**Substitui `context_from: ["self"]` no job do cron, que foi removido:**
aquele mecanismo reinjetava o output ANTERIOR INTEIRO, e esse output é
`header + SKILL.md verbatim + prompt + relatório` — ou seja, reinjetava
uma 2ª cópia completa desta skill, que o tick já carrega fresco. Medido
em 05/09/2026: ~36 KB de duplicação (~10,6k tokens, ~20% do baseline de
54,3k medido no #6712) para trazer ~3 KB de relatório. Ler este arquivo
entrega a mesma continuidade sem a duplicação.

## §3 — §4 passo 0: por que o gate de coerência existe (#6752)

0. **Gate de coerência (#6752), ANTES do claim — barra cedo, não depois de
implementar.** Auditoria de 29/08/2026 mediu 2,4× de retrabalho em PRs
`continuo` vs `overnight`/`develop` da mesma janela — não por qualidade
de diff isolado (notas próximas), mas por FALTA DE MEMÓRIA ENTRE PRs: o
caso canônico (#6699) é uma PR criando um módulo canônico em
`scripts/lib/shared/` e, dois commits depois, outra PR do mesmo dia
contornando essa mesma abstração com um literal hardcoded — a abstração
foi criada e imediatamente pisada pelo próprio autor. Decisão do editor
(#6752, 30/08/2026): checagem MECÂNICA aqui no passo de seleção, **sem**
eixo novo em `classifyExecTrack` nem label dedicada — rejeitar aqui não
grava NADA na issue, ela só não é reivindicada NESTE tick, continua
`track=overnight` normal pro overnight/develop.

Ver `scripts/lib/continuo-coherence-gate.ts` pro que o gate mede
(overlap de path com PR aberta/merge recente, refactor/consolidação,
abstração compartilhada, fatia de épico, dependência cruzada explícita
de outra PR) e por que é mecânico em vez de julgamento — não é um
classificador perfeito (decide ANTES do diff existir), mas erra pro
lado de barrar mais, porque o custo do falso-positivo (issue boa espera
o overnight) é muito menor que o do falso-negativo medido (retrabalho
2,4×, 3 das 4 quebras recentes de master).

## §4 — §4 passo 2: por que o renovador de heartbeat é processo em background (#6885)

**Por que é um processo em background, não uma instrução pra chamar
heartbeat "de vez em quando"**: uma instrução em prosa depende do
agente lembrar de executá-la no meio de um trabalho que está
absorvendo a atenção dele — falha exatamente como a #6849 mediu pro
marcador de review (o comportamento correto existe só enquanto quem
executa coopera). Um renovador destacado, iniciado ANTES da delegação
e morto DEPOIS dela, não depende de julgamento nenhum: se o processo
pai (este tick) está vivo, o `wait`/`kill` no fim do bloco garante que
ele para; se o pai morre no meio (SIGKILL do gateway, #6885), o teto de
15 iterações (~45min, folga sobre os 40min do `--timeout`) garante que
o renovador nunca fica batendo heartbeat pra sempre num tick que já
morreu — o mesmo problema que existe pra resolver, só que órfão em vez
de esquecido.

## §5 — §4: `--budget` nunca para baixo (#6712)

**NUNCA baixar o `--budget` para "economizar" (#6712).** Ele não controla o
gasto desta pipeline — o CLI não reconhece o slug do gateway e estima o custo
a preço da Anthropic, ~14-18x o real, então um teto "econômico" aborta a
delegação no meio gastando centavos. Quem limita gasto é o teto diário da key
na OpenRouter, aplicado pelo provedor. Em 29/08/2026 o tick reagiu a
`Exceeded USD budget` tentando 1.5 e depois 1.0 — a direção errada: 3
delegações morreram, o tick de 40min produziu zero PRs e deixou worktree
órfão. Se este erro aparecer, o valor a mexer é para CIMA.
