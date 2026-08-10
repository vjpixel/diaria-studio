# Auditoria de consumo de tokens — refresh de agosto (260809)

**Status:** levantamento concluído. Nenhum corte aplicado — este doc mede e
prioriza; a execução vai nas issues abertas ao final.

**Por que existe:** os três levantamentos de julho
(`overnight-token-analysis-3327.md`, `develop-token-analysis-3328.md`,
`context-caching-audit-3438.md`) foram feitos entre 260711 e 260716, **antes
do #4234** (260728), que devolveu `DEFAULT_EFFORT = "max"` ao review
automatizado por PR — trocando 1 agente por um fleet de 5. Essa é a mudança
mais cara do período e nenhum dos três a captura. Este doc refaz as medições
com dados de agosto.

**Método:** contagens diretas (bytes, `gh pr list`) + `subagent_tokens`
reportado pelo `harness_usage` nos relatórios de sessão de
`data/develop/*/report.md`. Estimativa de tokens de arquivo continua sendo a
heurística chars/4 de `scripts/audit-context-tokens.ts` — **piso aproximado**,
mesma ressalva do #3438.

---

## 1. Fleet review por PR — o gasto dominante (MEDIDO)

Duas sessões de agosto reportaram tokens por rodada de fleet review:

| Sessão | Rodadas de fleet review | Tokens por rodada | Média |
|---|---|---|---:|
| `develop/260808` | 5 (#4776, #4775, #4778, #4779, #4781) | 500.0k / 522.4k / 562.6k / 558.9k / 582.5k | **545k** |
| `develop/260806b` | 4 (#4715, #4716, #4717, #4721) | 361k / 621k / 639k / 523k | **536k** |

**Um fleet review custa ~540k tokens por PR**, com dispersão baixa entre as 9
rodadas medidas — o custo é função do fleet (5 agentes), não do tamanho do
diff.

### 1.1 Review vs. implementação, dentro da mesma sessão

| Sessão | Implementação/fixers | Fleet review | Review como % dos subagentes |
|---|---:|---:|---:|
| `develop/260808` | ~1,39M (7 unidades) | ~2,73M | **66%** |
| `develop/260806b` | ~1,03M | ~2,14M | **67%** |

Dois terços do orçamento de subagente vão para o review, não para o trabalho.
O relatório de `260806b` já registrava a conclusão de forma independente: *"a
maior parte do custo veio do fleet review de 5 agentes rodando 3× ... não da
implementação em si."*

### 1.2 Escala diária

PRs mergeados, 02–09/ago: 22, 25, 41, 13, 18, 23, 16, 11 → **169 em 8 dias,
média 21,1/dia**. Cada um dispara o hook `pr-create-review.mjs`, que resolve
`max` para tudo que não é branch `overnight/*`.

**21,1 PRs/dia × ~540k ≈ 11,4M tokens/dia só de fleet review.**

Para comparação de ordem de grandeza: o #3327 mediu uma **noite inteira** de
overnight (19 dispatches, 27 issues) em **3,97M tokens** — sob o regime `low`
do #3326, então essa medição não inclui fleet review nenhum.

### 1.3 Distribuição de tamanho dos PRs (o que abre espaço para corte)

169 PRs de agosto: mediana **497 linhas** e **6 arquivos**; p90 1.375 linhas.

| Faixa | PRs | % |
|---|---:|---:|
| ≤ 300 linhas | 57 | 34% |
| ≤ 500 linhas | 85 | 50% |
| > 1.000 linhas | 31 | 18% |

Um corte por tamanho de diff (`low` abaixo do limiar, `max` acima) economiza,
em regime:

| Limiar | PRs/dia afetados | Economia estimada/dia |
|---|---:|---:|
| 300 linhas | ~7,2 | **~3,1M tokens** |
| 500 linhas | ~10,5 | **~4,5M tokens** |

(Assume que `low` = 1 agente custa ~1/5 do fleet, portanto economia de ~432k
por PR desviado. **ESTIMADO** — o custo de um review `low` isolado não foi
medido em agosto.)

O p90 continua protegido nos dois limiares: PRs grandes seguem no fleet.

---

## 2. `CLAUDE.md` — já cortado uma vez, e voltou a crescer (MEDIDO — atualizado 260810)

**Correção sobre a própria medição desta seção:** a versão original (escrita
com o estado de 260809) media 75.726 bytes e listava o corte como
recomendação aberta (Prioridade #2 da Seção 6). **O corte já aconteceu** — é
o mesmo achado, já fechado: #4814 (mesmos 21.418→75.726 bytes, mesma lista de
7 parágrafos de tarefa agendada duplicando runbook em `docs/`) foi fechado
pelo PR #4851 ("enxugar CLAUDE.md de 75KB pra ~55KB"), mergeado
**2026-08-10T05:29:41Z** — antes deste doc ter sido commitado (21:39Z do
mesmo dia). A Prioridade #2 original está removida da Seção 6 por este
motivo.

| Data | Bytes |
|---|---:|
| 2026-06-01 | 21.418 |
| 2026-08-09 (antes do corte #4851) | 75.726 |
| 2026-08-10 (após #4851, medição atual) | **58.414** |

O corte reduziu 75.726→58.414 (-23%), abaixo do alvo de ~55KB do título do
PR — restam ~3,4KB de folga antes de reincidir. Composição pós-corte:

| Seção | Bytes |
|---|---:|
| `## Princípios operacionais invariáveis` | 30.850 |
| `## Como usar` | 15.276 |
| `## Otimização de tokens` | 3.717 |
| `## Pipeline` | 3.458 |
| `## Estrutura` | 1.674 |
| `## Regras invariáveis` | 1.310 |
| `## Estado atual` | 336 |

`Princípios operacionais invariáveis` já é 53% do arquivo e é a seção que
mais cresce por commit (histórico de incidente + decisão editorial
acumulando) — candidata mais provável a reincidir primeiro, não
`Como usar` (que foi o alvo principal do #4851).

---

## 3. `context/` — refresh do #3438

| | 260716 (#3438) | 260809 | Δ |
|---|---:|---:|---:|
| Arquivos | 24 | 36 | +50% |
| Bytes | 204.888 | 277.077 | +35% |
| ~Tokens | ~49.866 | ~67.398 | +35% |

`beehiiv-playbook.md` cresceu de 83.435 para **89.386 bytes** e segue sendo o
maior isolado (32% do diretório). Os invalidadores de cache continuam sendo
os mesmos **falsos-positivos** já auditados no #3438 (exemplos estáticos em
bloco de código + cabeçalho de metadata em arquivo gerado) — **nenhum
invalidador real**, veredito revalidado.

**Correção importante ao `CLAUDE.md`:** a seção "Otimização de tokens" afirma
que *"todo arquivo em `context/` entra no prompt cache"*. **Isso não é
verdade.** Não existe nenhum `@context/...` import no `CLAUDE.md` — `context/`
é lido **sob demanda**, como o próprio #3438 já havia constatado para o
`beehiiv-playbook.md` ("não é lido por toda chamada de agente"). A disciplina
de curadoria está apontada para o diretório errado: o arquivo que de fato
entra em todo prompt é o `CLAUDE.md`, e é justamente o que triplicou.

---

## 4. Playbooks de stage — custo da operação da diária (NÃO MEDIDO em tokens)

Sem instrumentação de token na pipeline editorial. Por tamanho de arquivo:

| Arquivo | Bytes |
|---|---:|
| `.claude/agents/orchestrator-stage-1-research.md` | 75.003 |
| `.claude/agents/orchestrator-stage-4.md` | 74.997 |
| `.claude/agents/orchestrator-stage-2.md` | 61.213 |
| `.claude/agents/orchestrator-stage-0-preflight.md` | 53.351 |
| `.claude/agents/review-test-email.md` | 50.399 |
| `.claude/agents/orchestrator-stage-5.md` | 35.059 |

Os 5 `orchestrator-stage-*.md` somam 299.623 bytes — `review-test-email.md`
fica fora dessa soma porque é playbook de subagente (Stage 5), não do
orchestrator top-level, e não roda em toda edição. Somados ao `CLAUDE.md`
(medição atual, pós-#4851, seção 2): **299.623 + 58.414 = 358.037 bytes ≈
90k tokens** de playbook antes de produzir uma linha de newsletter — a
tabela acima lista os 6 arquivos para referência, mas a conta soma só os 5
`orchestrator-stage-*`. O padrão é o mesmo do `CLAUDE.md`: instrução
operacional misturada com narrativa histórica de incidente. A ressalva do
#3438 sobre não cortar às cegas vale para o conteúdo operacional (seletor de
Chrome sem teste de regressão); não vale para a narrativa ao redor dele.

---

## 5. Instrumentação (#3453 Rec 1) — adotada parcialmente

A recomendação de instrumentar custo por rodada foi implementada de forma
inconsistente. Nas 17 sessões de agosto (`data/overnight/`, `data/develop/`):

- Tabela de `subagent_tokens` presente em algumas (`develop/260804`,
  `260806b`, `260808`) e ausente na maioria.
- **`coordinator_tokens` nunca foi medido em nenhuma sessão** — todos os
  relatórios que tocam no assunto dizem "não instrumentado" ou "harness não
  expõe".

Foi só porque três sessões reportaram a tabela que a Seção 1 deste doc foi
possível. Tornar a tabela obrigatória no relatório final (em vez de
best-effort do coordenador) é pré-requisito para medir o efeito de qualquer
corte feito a partir daqui.

---

## 6. Prioridade

1. **Effort do review por tamanho de diff** — ~3–4,5M tokens/dia, o único
   item de escala de milhões. Trade-off real custo × qualidade: decisão do
   editor, a constante já foi nos dois sentidos (#2754 → #3326 → #4234).
2. ~~Enxugar `CLAUDE.md`~~ — **já feito** (#4814/#4851, mergeado
   2026-08-10T05:29Z, ver Seção 2). Continua valendo como item de vigilância
   recorrente — cresceu ~1,5KB/dia antes do corte e a folga atual é só
   ~3,4KB — mas não é mais item de execução pendente.
3. **Tabela de custo obrigatória no relatório de sessão** — barato, e sem
   isso as próximas decisões voltam a ser estimativa.
4. **Separar narrativa histórica dos playbooks de stage** — maior volume de
   bytes depois do #1, mas sem medição de token que justifique a ordem
   (#4816, aberta).
