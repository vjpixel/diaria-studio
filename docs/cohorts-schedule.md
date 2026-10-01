# Agendamento do crawl de coortes de engajamento (#2426, só v2 desde #9330)

A tabela de **Coortes de engajamento** do clarice-dashboard é um snapshot
pré-computado: o dashboard só lê o KV (`cohorts:engagement`); quem popula é
`scripts/clarice-engagement-cohorts-v2.ts --push` (export por campanha na
Brevo → KV, leva minutos). Sem rodar o script de novo, a tabela fica congelada
(a seção mostra "Pré-computado às … BRT" pra deixar a idade do dado explícita).

**Só o v2 existe (#9330, decisão do editor 01/10/2026).** O crawl per-contato
v1 (`clarice-engagement-cohorts.ts`, ~21,5h de GETs por contato), seu wrapper
Windows `run-cohorts-crawl.cmd` e a task Windows `DiariaCohortsCrawl` foram
removidos do repo. O checkpoint do v1 em
`data/clarice-subscribers/cohorts/checkpoint.json` (e `status.json`/`run.log`/
`task.log` do v1) ficou órfão e pode ser apagado à mão — `data/` é gitignored.
O cache por campanha do v2 mora no mesmo diretório e NÃO deve ser apagado.

## Operação

- **Task agendada:** `Diaria-Clarice-Cohorts-Crawl` (`scripts/lib/scheduled-tasks.ts`),
  diária às 21:00 BRT, roda
  `scripts/clarice-engagement-cohorts-v2.ts --push --out data/clarice-subscribers/cohorts/v2-latest.json`.
- **Disparar manualmente:** `npx tsx scripts/clarice-engagement-cohorts-v2.ts --push`
  (sem `--push` é dry-run: imprime/grava só o artefato local).
- **Log:** `data/clarice-subscribers/.cohorts-v2-crawl.log`.

## Cutover para v2 (#4451, 260811) — task registrada, KV do dashboard ATUALIZA via --push (#5015)

Decisão do editor (260811): trocar a task agendada para o v2 agora, **sem**
o período de sobreposição v1×v2 previsto no item 6 do plano original da
issue (pulado deliberadamente). Achado ao verificar o estado real desta
máquina: `DiariaCohortsCrawl` (a task Windows acima, v1) **nunca existiu**
no registro declarativo (`scripts/lib/scheduled-tasks.ts`) nem como timer
systemd — então não é uma troca de ponteiro de uma task existente, é
**registro do zero** já apontando pro v2. `Diaria-Clarice-Cohorts-Crawl`
(nome escolhido seguindo o padrão hifenizado dominante do registro, `Diaria-X-Y`)
roda `scripts/clarice-engagement-cohorts-v2.ts --push --out data/clarice-subscribers/cohorts/v2-latest.json`
diariamente às 21:00 BRT (mesmo horário histórico do v1 acima, sem colisão
com nenhuma outra daily do registro). O `--push` foi adicionado em #5015
(260811) — antes disso o step só passava `--out` (ver "ATENÇÃO" abaixo, texto
histórico mantido pra registrar o gap que existiu entre 260811 (registro da
task) e o fechamento do #5015 na mesma data).

**Armar de verdade (ação do coordenador/editor, sessão local, fora desta
unidade — #4451):**

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Clarice-Cohorts-Crawl
systemctl --user daemon-reload
systemctl --user enable --now diaria-clarice-cohorts-crawl.timer
```

**ATENÇÃO (histórico — fechado em #5015, mesmo dia 260811):** por um período
curto dentro do próprio 260811, entre o registro desta task e o fechamento
do #5015, o gap abaixo existiu de fato. `clarice-engagement-cohorts-v2.ts`
era **sempre dry-run por design** (sem flag `--push`/`--kv`): a task só
refrescava o artefato local `--out`, **nunca gravava a chave
`cohorts:engagement`** do KV que `clarice-dashboard` lê — só o v1
(`clarice-engagement-cohorts.ts`, sem `--dry-run`) escrevia nessa chave, e o
v1 não tinha task agendada nesta máquina. **Estado atual, pós-#5015:** v2
ganhou a flag `--push` (`pushCohortsToKV`, mesma proteção anti-clobber do
v1 — nunca sobrescreve `cohorts:engagement` com universe=0), e o step desta
task já passa `--push` (ver comando acima) — o snapshot "Coortes de
engajamento" do dashboard volta a atualizar a cada disparo (21:00 BRT), sem
depender de rodada manual do v1.

## Redesenho v2 — design VALIDADO (#4451, 260810); histórico da decisão de cutover (ver seção acima para o estado atual da task)

O crawl per-contato acima (v1) tem um limite estrutural: o universo cresceu
pra ~129k contatos, o que exige ~21,5h ESTIMADAS de crawl contínuo (129.251 ÷
~100 req/min — nunca mediu de verdade porque o crawl nunca completou com
sucesso). O fix de curto prazo (#4451/260803) destrava o caso comum sem
mudar essa realidade estrutural: `-ExecutionTimeLimit` da task deixou de
matar o processo em 1h (agora sem limite) e `MAX_RESUME_AGE_H` do checkpoint
subiu de 18h pra 30h, medido desde a ÚLTIMA atividade (`cp.lastResumedAt`,
atualizado a cada resume — parte 2 do fix) em vez da tentativa original, o
que permite o progresso sobreviver a vários disparos diários consecutivos
quando o crawl não completa numa execução só. `scripts/clarice-engagement-cohorts-v2.ts`
inverte o eixo (export por CAMPANHA via `POST /emailCampaigns/{id}/exportRecipients`
em vez de `GET /contacts/{id}` por contato), com cache permanente por campanha,
janela de re-fetch pra campanhas recentes e o gap de blacklist administrativo
fechado via leitura do store local (`clarice-users.db`, sem custo de API
adicional). `scripts/compare-cohorts.ts` compara o output das duas coortes
campo a campo dentro de uma tolerância.

**Dry-run por padrão; `--push` grava no KV (#5015)** — v2 nasceu sempre
dry-run; isso mudou em #5015 (260811, ver seção "Cutover para v2" acima),
que portou a proteção anti-clobber do v1 atrás da flag `--push`. A task
`Diaria-Clarice-Cohorts-Crawl` já roda com `--push` nos args.

### Comparação empírica v1×v2 (260808/260809) — 2 tentativas, aceitas pelo editor em 260810

A Fase 3 rodou AO VIVO contra a Brevo real (leitura, `exportRecipients` por
campanha) duas vezes, comparando contra o baseline v1 completo de 260807
(universo 142.646, `data/clarice-subscribers/cohorts/.v1-baseline-260807.log`):

- **Tentativa 1 (260808, ~23:52 UTC):** 12/82 campanhas falharam com 429
  (rate limit) — comparação fora da tolerância em 8/9 campos, majoritariamente
  atribuível às campanhas que falharam.
- **Tentativa 2 (260809, ~17:49 UTC):** 0 campanhas falharam (46 em cache +
  37 novas). Comparação AINDA fora da tolerância (2%) em 8/9 campos, mas o
  padrão do desvio é **100% consistente com crescimento orgânico** entre as
  datas de medição — universo, aberturas e exits sobem todos na direção
  esperada ("mais gente recebeu e mais gente abriu 2 dias depois"), nenhum
  campo inverte. Uma comparação limpa exigiria rodar v1 e v2 no MESMO
  instante (v1 leva ~2,5h medidas), custo alto demais para repetir na sessão.

**Decisão do editor (briefing overnight 260810):** aceitar esse padrão de
desvio como evidência suficiente de que o design v2 está correto, sem esperar
a tolerância de 2% ser atingida numa comparação assíncrona — a tolerância foi
calibrada pra pegar divergência de LÓGICA, não deriva temporal de dias entre
as duas leituras. **v2 passa a ser considerado VALIDADO.** v1 continua no
repo como **fallback documentado** (não removido, não desativado).

**O que isso NÃO decide (formalização deliberadamente parcial, na época):**

- **Troca da task pro v2** continuava não feita nesta formalização de
  260810 — decisão separada e futura do editor, explicitamente vetada
  naquela unidade de trabalho. **Atualização 260811: já feita** — ver a
  seção "Cutover para v2" acima (`Diaria-Clarice-Cohorts-Crawl`, registro do
  zero, já que `DiariaCohortsCrawl` v1 nunca chegou a ser registrada nesta
  máquina).
- **Item 2 do fleet review de #4479** ("campanha sem `sentDate` nunca entra no
  cache permanente, checar a distribuição real quando a Fase 3 rodar") **segue
  não verificado** — a Fase 3 que rodou não checou a distribuição de
  `sentDate` ausente entre as campanhas reais; a postura conservadora do
  código (trata ausência como "sempre dentro da janela de re-fetch") continua
  valendo sem confirmação empírica de quão cara ela é no regime permanente.
- **Item 1 do fleet review de #4479** ("`forceRefresh=true` sem fallback pro
  cache antigo em falha de export") continua **sem decisão** — comportamento
  atual (campanha que falha o export dentro da janela de re-fetch é excluída
  do agregado da rodada, mesmo com cache válido em disco) é o documentado e
  testado; trocar para fallback silencioso é uma escolha de comportamento que
  ainda não foi pedida por ninguém, não um bug — ver docstring de
  `getOrFetchCampaignCache`/`isWithinRefetchWindow` em
  `scripts/clarice-engagement-cohorts-v2.ts`.

Ver issue #4451 para o histórico completo (fases 1-3) e os números da
comparação lado a lado.
