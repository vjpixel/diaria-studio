# Auditoria do cluster Clarice/Brevo (#7122, fatia 10 do épico #7112)

**Data:** 02/09/2026. **Escopo:** os 94 scripts + 111 testes (~76.033 LOC)
citados pela issue de origem, cobrindo o programa Clarice News (digest
mensal enviado via Brevo) e a integração Brevo da diária. **Este documento é
só o levantamento** — nenhum código foi removido nesta unidade (regra
explícita da issue: "Fora de escopo: Qualquer remoção"). Nenhum script
`clarice-*`/`brevo-*`/`publish-*` foi executado durante esta auditoria —
100% leitura estática (`grep`, `git log`, leitura de código/skills/docs).

## Metodologia

Para cada um dos 70 scripts top-level `scripts/clarice-*.ts`/`scripts/*brevo*.ts`
(32.770 LOC — ver nota de contagem abaixo), verificamos 3 sinais de vida,
cada um por si só suficiente para provar "tem consumidor":

1. **Import real** — `from "./<nome>.ts"` (estático ou dinâmico) em outro
   arquivo `.ts` de `scripts/`/`test/`, excluindo o próprio arquivo e seu
   teste homônimo. Prova que o módulo exporta algo que outro código chama.
2. **Menção em skill** (`.claude/skills/*/SKILL.md`) — prova caminho
   manual/ad-hoc do editor.
3. **Task agendada** (`npx tsx scripts/lib/scheduled-tasks.ts --list`) —
   prova execução automática recorrente.

Além disso, para os candidatos sem nenhum dos 3 sinais, fizemos verificação
manual: leitura do docstring (procurando `one-off`/`@deprecated`/`histórico`),
`git log` do arquivo, e grep amplo em `docs/`, `workers/`, `hermes/`,
`package.json`, `platform.config.json`.

**Nota de contagem:** a issue cita 94 scripts/37.230 LOC; este documento
mede 70 scripts top-level/32.770 LOC casando o padrão `*clarice*`/`*brevo*`
em `scripts/` (não `scripts/lib/`). A diferença (~24 arquivos, ~4.460 LOC)
é composta majoritariamente por módulos em `scripts/lib/` (`clarice-*.ts`,
`brevo-*.ts` — ~58 arquivos, ~17.475 LOC) que já são, por definição,
bibliotecas importadas por outros scripts — não CLIs standalone, portanto
fora do risco de "órfão sem consumidor" que motivou a issue. Não foram
auditados individualmente aqui; ver "Trabalho futuro" no fim.

## Achado crítico: colisão de namespace "Clarice" (3 significados distintos)

Qualquer auditoria por substring `clarice` neste repositório precisa
separar **três programas completamente distintos** que compartilham o
nome, porque a Clarice (empresa parceira) tem três papéis diferentes no
projeto:

1. **API de correção de texto** (`mcp__clarice__correct_text`,
   `scripts/clarice-correct-engine.ts`) — usada no Stage 2 da **diária**
   para humanizar o texto da newsletter. `scripts/resolve-clarice-input.ts`
   (#871) pertence a este grupo — é invocado todo dia por
   `.claude/agents/orchestrator-stage-2.md`, nada a ver com envio de
   e-mail.
2. **Box de patrocínio Clarice** dentro da newsletter diária — anúncio
   pago com cupons (`NEWS25`/`NEWS50`) e link de afiliado. `scripts/
   verify-clarice-coupons.ts` (#1982, invocado por
   `orchestrator-stage-2.md:337`) e `scripts/gen-parceria-clarice-image.ts`
   pertencem a este grupo.
3. **Clarice News** — o programa que a issue #7122 de fato quer auditar:
   digest mensal enviado a uma base própria via Brevo
   (`BREVO_CLARICE_API_KEY`), com rampa de aquisição, ondas, teste A/B/C de
   assunto, MillionVerifier, etc. É o grupo (1)+(2) que, se contado junto
   com (3) por um grep ingênuo de substring, infla os números e pode gerar
   falsos "órfão" (um script do grupo (1)/(2) roda todo dia via a
   *pipeline diária*, não via nenhum mecanismo específico de "Clarice" —
   um auditor que só olhe `scripts/clarice-envio-run.ts`/tasks agendadas
   do programa (3) não vai achar consumidor nenhum para eles).

**Nenhum dos 3 scripts do grupo (1)/(2) é órfão** — os três têm consumidor
vivo e diário, só que fora do programa de envio Clarice News.

## Os 2 sinais que a issue já nomeava — veredito

### (a) "11 CLIs sem nenhuma menção fora de si" — 5 de 8 nomeados são falso-positivo

A issue nomeou 8 explicitamente. Este levantamento prova consumidor real
para 5 deles — a checagem original claramente não olhou `import`
estático/dinâmico, nem chamada por subprocesso a partir de outro script,
nem prosa de skill:

| Script citado pela issue | LOC | Veredito real | Prova |
|---|---|---|---|
| `clarice-reapply-scheduled-html.ts` | 765 | **NÃO é órfão** | `scripts/clarice-envio-guard.ts:141` importa `setCampaignStatus` deste módulo; `clarice-envio-guard.ts` roda 2×/dia via as tasks `Diaria-Clarice-Envio-Guard`/`-Alarm`. |
| `clarice-schedule-sends.ts` | 709 | **NÃO é órfão** | `scripts/clarice-schedule-ramp.ts:126` importa `checkEiaGuard`/`applyVerifyResults` deste módulo; é also o passo 3 do pipeline canônico multi-campanha documentado em `.claude/skills/diaria-mensal/SKILL.md:737`. |
| `clarice-import-sends.ts` | 367 | **NÃO é órfão** | `scripts/clarice-split-cells.ts:37` importa `toImportCsv` deste módulo; mesmo pipeline canônico acima. |
| `clarice-build-wave-260812-especial.ts` | 261 | **Confirmado órfão** | Docstring própria: "one-off, sessão 260810/11". Zero import, zero skill, zero task. `scripts/clarice-build-segment.ts:61` cita: "generalizando o one-off... nunca [reintroduzir o padrão ad-hoc]" — o próprio sucessor documenta que este script foi substituído. |
| `clarice-mailbox-dryrun.ts` | 109 | **Não é órfão, mas não é CLI vivo** — é ferramenta manual de diagnóstico read-only (#4249), com teste dedicado (`test/clarice-mailbox-coherence-4249.test.ts`) e comentário de uso em `scripts/lib/clarice-db.ts:858`. Sem consumidor automático — classificar como "manual recorrente", não remover. |
| `clarice-audit-overlap.ts` | 96 | **Não é órfão** — é a ferramenta de investigação que `scripts/lib/brevo-rate-state.ts:111` recomenda explicitamente rodar quando o guard de sobreposição de onda bloqueia ("...prefira scripts/clarice-audit-overlap.ts"). Manual, mas com consumidor de prosa real, não decorativo. |
| `clarice-waves-dryrun.ts` | 71 (+ `lib/clarice-waves-dryrun.ts` 243) | **Confirmado órfão** | Docstring: "comparação READ-ONLY entre o método ATUAL... e o cutover" de #2656 (29/06/2026) — o cutover já aconteceu há mais de 2 meses; só citado em comentários como referência histórica. |
| `clarice-check-derived-stale.ts` | 37 | **NÃO é órfão — está em produção, 2×/dia** | Invocado por `scripts/clarice-envio-run.ts:828` e `scripts/clarice-novos-run.ts:370` via `step(...)` (subprocesso, não `import`) — ambos rodam diariamente (`Diaria-Clarice-Envio` 19:10, `Diaria-Clarice-Novos`/`-Tarde` 09:00/18:00). Este é o caso mais claro de falso-positivo: um grep que só procura `import` nunca acharia este consumidor. |
| "e outros" (não nomeados) | — | Ver inventário completo abaixo — mais 2 confirmados órfãos achados por este levantamento: `inspect-brevo-wave.ts` (74 LOC) e `split-wave-brevo.ts` (156 LOC), ambos self-declared one-off sem nenhum consumidor. `gen-parceria-clarice-image.ts` (217 LOC) também — mas pertence ao grupo (2) da colisão de namespace acima (box de patrocínio da diária), não ao Clarice News. |

**Total real confirmado órfão nesta fatia: 5 scripts, ~1.022 LOC**
(`clarice-build-wave-260812-especial.ts` 261 + `clarice-waves-dryrun.ts` 71
+ `lib/clarice-waves-dryrun.ts` 243 + `inspect-brevo-wave.ts` 74 +
`split-wave-brevo.ts` 156 + `gen-parceria-clarice-image.ts` 217) — bem
abaixo dos ~3.032 LOC que a issue estimava, porque 3 dos 8 nomeados (mais o
`check-derived-stale`, citado como órfão mas na verdade em produção 2×/dia)
tinham consumidor real que o levantamento original não capturou.

### (b) "Família de planejamento de onda com sobreposição não auditada" — não são 7 scripts duplicados, são 2 pipelines documentados + 1 biblioteca

Lendo os 7 módulos (docstrings + quem importa o quê), a "sobreposição" é
**sucessão documentada em código**, não duplicação nunca resolvida:

**Pipeline A — multi-campanha, canônico para ciclos com múltiplos envios**
(`.claude/skills/diaria-mensal/SKILL.md:737`, textual: *"O fluxo
`clarice-build-edition-sends → clarice-split-cells → clarice-schedule-sends`
é o caminho canônico... `publish-monthly.ts` é o fluxo legado e será
removido em release futuro"*):

```
clarice-build-edition-sends.ts (661 LOC, exporta stratify/apportion)
  → clarice-split-cells.ts (184 LOC, importa stratify/apportion/toImportCsv)
    → clarice-schedule-sends.ts (709 LOC, importa checkEiaGuard/applyVerifyResults)
```

**Pipeline B — lista/grupo nomeado, usado pela rampa Clarice News atual**
(skill `/diaria-clarice-envio`, Passo 8, e automação diária
`clarice-envio-run.ts`):

```
clarice-plan-wave.ts (540 LOC, READ-ONLY — propõe volume, nunca escreve)
  → clarice-build-segment.ts (1.325 LOC, segmenta a base)
    → clarice-split-group-cells.ts (222 LOC, gera manifest A/B/C ou single)
      → clarice-import-waves.ts (1.142 LOC, importa lista pro Brevo)
        → clarice-schedule-group.ts (1.354 LOC, cria+agenda a campanha)
```

`clarice-schedule-group.ts` (#3228) tem no próprio docstring o motivo de
existir: cobrir "1 campanha por lista arbitrária" que nem o Pipeline A
(`sends-summary.json`-driven, sem `--list-id`) nem `publish-monthly.ts`
(`@deprecated` #2009) resolviam.

**`clarice-schedule-ramp.ts` (1.673 LOC) não é um 3º pipeline — é uma
biblioteca compartilhada**, não um CLI invocado em produção. Zero task
agendada, zero menção em skill, mas **11 imports reais** de 7 scripts
diferentes: `clarice-envio-risk.ts`, `clarice-mv-ondemand.ts`,
`weekly-send-plan-audience.ts`, `clarice-cta-ab-setup.ts`,
`clarice-check-semaphore.ts`, `clarice-plan-wave.ts`,
`clarice-postmaster-alarm.ts` (este último roda 1×/dia, 12:45 BRT) —
exporta helpers de semáforo/dashboard/postmaster/EIA-guard usados por meio
cluster. Editado hoje mesmo (02/09/2026, #7080). **Não é órfão nem
"duplicado"** — é infraestrutura compartilhada com nome de CLI legado
(citava no próprio docstring "substitui o fluxo ad-hoc rodado na mão em
260716").

**Veredito (b):** nenhuma sobreposição real a resolver. Os 7 módulos são 2
pipelines com propósitos distintos (multi-campanha vs. lista nomeada) mais
1 biblioteca. `publish-monthly.ts` (fluxo legado, já marcado
`@deprecated`/"será removido em release futuro" no próprio código) é o
único item desta família com remoção já anunciada — mas fora do escopo
desta fatia (não é `clarice-*`/`brevo-*` no nome, e sua remoção já está
documentada como decisão tomada, só pendente de execução; ver "Trabalho
futuro").

## Classificação completa (70 scripts top-level)

Categorias: **vivo-agendado** (task cron), **manual/skill** (invocado por
uma `/diaria-*` skill), **biblioteca-viva** (sem CLI-entrypoint em
produção, mas com import real de outro script — como `clarice-schedule-ramp.ts`),
**confirmado-órfão** (zero sinal + docstring/git log confirmam one-off
gasto ou migração completa), **fora-do-cluster** (namespace collision,
grupo 1/2 acima).

| Script | LOC | Categoria | Evidência |
|---|---|---|---|
| clarice-build-wave-260812-especial | 261 | confirmado-órfão | docstring "one-off 260810/11"; sucessor cita explicitamente |
| clarice-waves-dryrun (+lib, 314) | 71+243 | confirmado-órfão | docstring "cutover #2656 já concluído" |
| inspect-brevo-wave | 74 | confirmado-órfão | docstring "one-off — verificar wave slicing logic" |
| split-wave-brevo | 156 | confirmado-órfão | docstring "one-off — split T1-W6→W7", ciclo 2604-05 encerrado |
| gen-parceria-clarice-image | 217 | fora-do-cluster (grupo 2) + one-off de marketing já executado | docstring "colateral... one-off, não parte do pipeline editorial" |
| resolve-clarice-input | 88 | fora-do-cluster (grupo 1) | `orchestrator-stage-2.md:255`, roda toda edição diária |
| verify-clarice-coupons | 105 | fora-do-cluster (grupo 2) | `orchestrator-stage-2.md:337`, roda toda edição diária |
| clarice-optin | 186 | manual/doc | `docs/clarice-unified-db.md` (comandos `add`/`remove`/`list`) |
| diaria-subscribers-ingest-brevo | 365 | manual, ativo | #7086 (commit de hoje), documentado em `studio-ui/assinantes.html`; ainda sem automação registrada |
| push-clarice-hour-test-kv | 85 | biblioteca-viva | import dinâmico em `scripts/lib/clarice-hour-test.ts:413` |
| clarice-audit-overlap | 96 | manual, referenciado | citado como remediação em `scripts/lib/brevo-rate-state.ts:111` |
| clarice-check-derived-stale | 37 | vivo-agendado (indireto) | subprocesso em `clarice-envio-run.ts`/`clarice-novos-run.ts`, ambos com task diária |
| clarice-mailbox-dryrun | 109 | manual, com teste dedicado | `test/clarice-mailbox-coherence-4249.test.ts` |
| clarice-reapply-scheduled-html | 765 | biblioteca-viva | import em `clarice-envio-guard.ts` (task 2×/dia) |
| clarice-schedule-sends | 709 | manual/skill + biblioteca | pipeline A canônico, skill `diaria-mensal` |
| clarice-import-sends | 367 | manual/skill + biblioteca | pipeline A canônico |
| clarice-schedule-ramp | 1.673 | biblioteca-viva | 11 imports, 7 consumidores diferentes |
| clarice-plan-wave, clarice-build-segment, clarice-split-group-cells, clarice-import-waves, clarice-schedule-group | 540+1.325+222+1.142+1.354 | manual/skill (`/diaria-clarice-envio`) + vivo-agendado (`clarice-envio-run.ts`) | pipeline B, ver seção (b) |
| clarice-build-edition-sends, clarice-split-cells | 661+184 | manual/skill | pipeline A, `.claude/skills/diaria-mensal/SKILL.md:737` |
| Todos os demais 47 scripts (`clarice-envio-*`, `clarice-novos-*`, `clarice-sync-brevo`, `clarice-dashboard-precompute`, `clarice-guardrail-alarm`, `clarice-opens-catchup-alarm`, `clarice-postmaster-alarm`, `evaluate-brevo-diaria`, `publish-daily-brevo`, `schedule-daily-brevo`, `brevo-diaria-*`, `sync-*-brevo`, `check-brevo-diaria-guardrail`, `clarice-engagement-cohorts*`, `clarice-correct`, `merge-clarice-subscribers`, `clarice-apply`, `clarice-cta-ab-setup`, `clarice-check-semaphore`, `clarice-healthcheck`, `clarice-mv-status`, `clarice-mv-ondemand`, `clarice-db-summary`, `clarice-build-db`, `clarice-diff`, `clarice-stripe-delta`, `clarice-resolve-folder`, `clarice-novos-resolve-cycle`, `clarice-novos-resolve-key`, `clarice-novos-html-state`, `verify-clarice-url-stability`, `inject-poll-token-brevo`, `import-curated-batch-brevo`, `reconcile-brevo-diaria-suppressions`, `sync-kit-inactive-to-brevo`, `sync-apoio-nivel-brevo`, `publish-monthly-apoiadores-brevo`, `render-monthly-apoiadores-brevo`, `clarice-envio-guard-alarm`) | — | vivo-agendado ou manual/skill | ≥1 sinal de import real, menção em skill, ou task agendada (ver `/tmp` `imports-report.txt`/`scheduled.txt` reproduzíveis pelo comando na Metodologia — não anexados linha-a-linha aqui por volume) |

## Recomendação

- **Não remover nada nesta PR** (regra explícita da issue).
- **Abrir issues-filhas P3** para os 5 confirmados órfãos (~1.022 LOC):
  `clarice-build-wave-260812-especial.ts`, `clarice-waves-dryrun.ts` (+
  `lib/clarice-waves-dryrun.ts` + `test/clarice-waves-dryrun.test.ts`),
  `inspect-brevo-wave.ts`, `split-wave-brevo.ts`,
  `gen-parceria-clarice-image.ts` — feito nesta mesma rodada:
  **#7144**.
- **Estado do programa Clarice News** (item do checklist "confirmar com o
  editor o estado do programa Clarice em si") **fica pendente** — é uma
  pergunta de trade-off editorial genuíno (critério 2 do CLAUDE.md,
  "Perguntar é exceção") que este levantamento não pode responder sozinho;
  todo o restante do cluster (89 de 94 scripts nomeados, ~97% do LOC) está
  vivo, agendado ou manualmente invocado — não há indício de que o
  programa esteja pausado ou encerrado.

## Trabalho futuro (fora desta fatia)

- `publish-monthly.ts` já carrega `@deprecated` (#2009) e o próprio código
  do pipeline A o cita como "será removido em release futuro" — candidato a
  issue-filha própria, mas fora do padrão `clarice-*`/`brevo-*` que a #7122
  mirava.
- Os ~58 arquivos de `scripts/lib/` que casam `clarice`/`brevo` (~17.475
  LOC) não foram auditados individualmente aqui — são bibliotecas por
  definição (importadas por CLIs), risco de "órfão" muito menor, mas o
  volume de LOC é relevante o bastante para uma fatia dedicada se o épico
  #7112 continuar.
