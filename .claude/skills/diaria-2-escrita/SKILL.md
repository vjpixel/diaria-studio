---
name: diaria-2-escrita
description: Roda a Etapa 2 (newsletter + social em paralelo, ambos a partir de `01-approved.json`). Uso — `/diaria-2-escrita AAMMDD [newsletter|social]`.
---

# /diaria-2-escrita

Executa a Etapa 2 da pipeline diar.ia.br: dispara `writer` (newsletter) + `social-writer` (#3991, reverte #3486 — texto único LinkedIn/Facebook/Instagram) + `social-curto` (#3992) **em paralelo**, todos lendo de `_internal/01-approved-capped.json` — sem dependência sequencial entre newsletter e social. Gate unificado ao final.

Self-contained — você (top-level Claude Code) executa todo o playbook aqui, sem delegar a um orchestrator subagente. (Workaround #207: runtime bloqueia `Agent` dentro de subagentes.)

## Argumentos

- `$1` = data da edição (`AAMMDD`, ex: `260423`). Se não passar, rodar `npx tsx scripts/lib/find-current-edition.ts --stage 2` e parsear `candidates[]` do JSON de saída (#583):
  - **Se `candidates.length === 1`**: assumir essa edição. Logar info: `Assumindo edição em curso: {AAMMDD}`. Editor pode interromper se errado.
  - **Se `candidates.length === 0`**: erro. `Nenhuma edição com Stage 1 aprovado e Stage 2 incompleto. Rode /diaria-1-pesquisa primeiro ou passe AAMMDD explicitamente.`
  - **Se `candidates.length >= 2`**: default (#5321) — assumir a mais recente (`candidates[candidates.length - 1]`, lista vem ordenada ascendente) e imprimir banner: `Múltiplas edições em curso: {lista}. Assumindo a mais recente: {AAMMDD}. Passe AAMMDD explicitamente para outra.` Editor pode interromper se errado.
- `$2` (opcional) = `newsletter` | `social` — re-roda só um dos dois. Sem este argumento, roda ambos em paralelo.
- `--no-gates` (opcional, #5738) = auto-aprova o gate deste stage. Existe para o runner AGENDADO (`scripts/overnight/run-scheduled-edicao.ts`), que desde o #5738 invoca uma skill `/diaria-N-*` por sessão em modo `--print`: sem esta flag o gate seria apresentado e ninguém responderia, queimando os turnos da sessão sem escrever sentinela. Equivale ao `auto_approve = true` que `/diaria-edicao` já setava internamente para os Stages 1-3 (pre-gate mode, #1523). **Nunca alcança publicação** — Stages 5/6 não estão em `STAGE_PLAN` e o runner nunca os invoca. **`--no-gate` (singular) é a grafia legada do #874 e continua aceita como sinônimo** — toda checagem no corpo desta skill honra as duas.

## Placeholders

Os blocos Bash/Agent abaixo usam placeholders. **O Claude executando este skill substitui pelos valores reais antes de invocar cada tool.**

- `$1` → AAMMDD recebido como argumento (ex: `260423`). Aparece em prompts de Agent e em `--edition $1` (scripts que já resolvem o layout internamente).
- `{YYMM}` → primeiros 4 chars de `$1` (ex: `2604`). Usado na resolução do layout nested de edições.
- `{EDIR}` → diretório REAL da edição no disco (#2463/#3024). **Nunca** monta como `data/editions/$1` — a edição pode estar no layout flat legado OU no nested novo (`data/editions/{YYMM}/$1`), dependendo de quando foi criada. Resolver **uma vez**, no Passo 0b abaixo, e reusar em todos os paths deste skill:
  ```bash
  EDIR=$(npx tsx scripts/lib/find-current-edition.ts --resolve $1)
  ```

## Passo 0b — Resolver diretório real da edição (#3024)

Antes de qualquer leitura/escrita em arquivo da edição, resolver `{EDIR}` (ver Placeholders acima). Todo path abaixo escrito como `{EDIR}/...` deve usar esse valor resolvido, não uma construção manual `data/editions/$1/...`.

## Pré-requisitos

- `{EDIR}/_internal/01-approved.json` deve existir com `highlights[]` (scorer já rodou na Etapa 1). Se não, avise: rode `/diaria-1-pesquisa` primeiro e aprove.

## Passo 0 — Task tracking setup (#904)

**Defensive cleanup primeiro:** varrer `TaskList()` e marcar como `completed` qualquer task `in_progress` de Stages anteriores (`Stage 0*`, `Stage 1*`). Cobre o caso de Stage 1 ter aprovado o gate sem fechar `Stage 1x` (bug histórico — issue #904).

**Em seguida**, criar tasks pra esta etapa via `TaskCreate` (uma por sub-stage):
- `Stage 2a — validar input + caps editoriais`
- `Stage 2b — dispatch paralelo (writer + social)`
- `Stage 2c — merge social`
- `Stage 2d — newsletter Clarice + humanize + lints`
- `Stage 2e — social Clarice + humanize`
- `Stage 2f — validações finais`
- `Stage 2g — gate humano`
- `Stage 2h — title-picker fallback (pós-gate)`

Cada task fica `pending` até o passo correspondente começar (`in_progress`) e `completed` quando o passo retornar. Tasks de gate (`Stage 2g`) fecham **imediatamente após o editor aprovar** — não esperar o title-picker. Detalhe completo em `.claude/agents/orchestrator.md` § "Task tracking — UI hygiene".

**No-op se TaskCreate/TaskUpdate não estiver disponível** (CLI puro fora do harness Claude Code).
- Se `$2 = social`: apenas o pré-requisito acima é necessário.
- Se `$2 = newsletter`: apenas o pré-requisito acima é necessário.


## Resume

O runner guarda o progresso em `{EDIR}/_internal/02-stage2-run-state.json`; retomar é re-rodar a fase seguinte à última que passou, nunca refazer o stage do zero por padrão:

| Estado gravado | Retomar com |
|---|---|
| sem estado | `--phase pre-dispatch` |
| `writersDispatchAt` sem a chave `poolDispatchAt` | `--phase post-writers` (re-despacha o que faltar) |
| `poolDispatchAt` gravado (data ou `null`, sem item) sem `humanizeDispatchAt` | `--phase post-pool` |
| `humanizeDispatchAt` sem `clariceDone` | `--phase post-humanize` |
| `clariceDone` com `postChecksDone: false` | `--phase post-checks` |
| `postChecksDone: true` | gate (Passo 6) e depois `--phase post-gate` |

**Mid-Clarice resume (#874).** Re-rodar `--phase post-humanize` não aplica a Clarice duas vezes: a entrada da Clarice da newsletter é sempre a saída do humanizador (`resolve-clarice-input.ts`: `02-humanized.md` → `02-normalized.md` → `02-draft.md`), copiada para o snapshot `_internal/02-pre-clarice.md` antes da chamada, e o `02-reviewed.md` é sobrescrito com o texto corrigido; o `02-reviewed.md` parcial de uma rodada interrompida nunca é a entrada. O mesmo vale para o social (entrada `03-social.md` humanizado, snapshot `_internal/03-social-post-humanizador.md`). Depois de um halt da Clarice do social, `--phase post-humanize --social-clarice-only` refaz só ela.

**Sem estado e com `02-reviewed.md` já existente** (edição de antes do runner): sem `--no-gate`/`--no-gates`, perguntar `"02-reviewed.md já existe — regenerar (sim/não)?"`; "não" vai direto ao gate. Com `--no-gate`/`--no-gates`: assumir que está OK e pular a regeneração.

## Fluxo padrão — runner `scripts/stage-2-run.ts` (#14031)

Desde o #14031 a Etapa 2 roda pelo runner, em 6 fases. Cada fase roda todos os `npx tsx` determinísticos do trecho correspondente da receita e devolve um JSON; você só despacha os agentes de `pendingAgentDispatch` e chama a fase seguinte (`nextPhase`). A prosa de cada passo vive em `.claude/agents/orchestrator-stage-2-fallback.md` (só no Fallback, abaixo). Passe `--scope newsletter|social` no `pre-dispatch` quando `$2` vier (as fases seguintes herdam do estado `_internal/02-stage2-run-state.json`) e `--no-gates` quando a skill receber `--no-gates`/`--no-gate`.

```bash
npx tsx scripts/stage-2-run.ts --phase pre-dispatch --edition $1 [--scope newsletter|social]
npx tsx scripts/stage-2-run.ts --phase post-writers --edition $1
npx tsx scripts/stage-2-run.ts --phase post-pool --edition $1
npx tsx scripts/stage-2-run.ts --phase post-humanize --edition $1   # Bash com timeout: 600000
npx tsx scripts/stage-2-run.ts --phase post-checks --edition $1     # sempre depois do post-humanize; re-rodável depois de um conserto
npx tsx scripts/stage-2-run.ts --phase post-gate --edition $1 [--after-title-picker]
```

| Fase | Roda | Devolve em `pendingAgentDispatch` |
|---|---|---|
| `pre-dispatch` | sentinel do Stage 1, §2a (caps + translate-summaries), passo 0 (fontes, `refresh-destaque-sources.ts --record-writer-inputs`), 4º post USE MELHOR, pesquisa de títulos do D1 | `writer-destaque` × N (ou `writer` único) + `social-writer` + `social-curto`, numa mensagem só (`dispatchTogether: true`) |
| `post-writers` | verify-agent-outputs (#9962), stitch, validate-stage-2-outputs, §2c (merge + header único) e `pool-descriptions --input` | `writer-pool` (só com item) |
| `post-pool` | `pool-descriptions --apply`, lints do §2b, normalize, singularize, snapshot do social | os dois humanizadores (newsletter e social), na mesma mensagem |
| `post-humanize` | confere os humanizadores, Clarice REST da newsletter e depois do social (em série, #4952) e a prova do humanizador social; termina aí (`nextPhase: post-checks`), para a chamada caber nos 600 s da Bash | nada |
| `post-checks` | pós-Clarice do §2b (travessão, É IA?, URL, cupons, intro, lançamentos, cobertura, erro intencional), check-stage2-invariants, lints do social, check-invariants | nada |
| `post-gate` | pós-gate do §2d: title-picker, TÍTULO/SUBTÍTULO, selo do humanizador social, sentinel e, depois dele, a limpeza dos snapshots | `title-picker` quando algum destaque ainda tem 3 títulos; depois re-rodar com `--after-title-picker` |

Despache os agentes com os `params` do JSON (paths já resolvidos) e o `detail` de cada item; os dois humanizadores saem como `Agent` com `subagent_type: "adhoc-opus-low"` e o `params.prompt` dado. Códigos de saída: `0` segue para `nextPhase`; `1` erro duro (ler `notes`); `2` halt, com o banner já renderizado em `haltRequired`; `3` conserto antes de seguir: aplique o que `fixes[]` pede e re-rode `rerunPhase` com as flags de `rerunArgs` (lint bloqueante do `post-pool`: re-despachar só o writer do destaque e re-rodar `--phase post-pool --restitch`, que refaz o stitch e reaplica o pool sem novo `writer-pool`). Um `--scope` passado numa fase vence o escopo gravado no estado; o `--no-gates` do `pre-dispatch` fica gravado e vale nas fases seguintes. `# Curto` ausente: na 1ª vez o `post-writers` pede o re-dispatch do `social-curto` (exit 3); na 2ª segue com o aviso em `gateNotes`. **Clarice do social:** teto normal de 480 s inteiro sempre (o de 90 s é só da newsletter); se a Clarice da newsletter deixar menos que isso na chamada, o `post-humanize` sai com exit `3` (`clarice-social-own-call`, `rerunArgs: ["--social-clarice-only"]`) e a do social roda numa chamada própria, sem nada a corrigir (#14093); qualquer falha, inclusive exit 6, é halt (exit 2), porque o `resume` do Stage 4 cobre só a newsletter; depois do `retry`, re-rode `--phase post-humanize --social-clarice-only [--deadline-ms N]` (só a Clarice do social, com override opcional do teto). O gate do Passo 6 entra entre `post-checks` e `post-gate`, mostrando os `gateNotes` do `post-checks` (que repete os avisos da Clarice e do Curto gravados no estado); o `post-gate` recusa (exit 1) sem um `post-checks` que passou. `record-agent-costs.ts`, `update-stage-status`/`capture-stage-usage` e a proposta do erro intencional no modo interativo continuam com você (`delegatedSteps`).

**Clarice (#14029):** o teto do `clarice-correct.ts` da newsletter vem do ping real do Stage 0 (`preflight-state.json`, campo `clariceRealProbe`; arquivo ilegível vira 480 s com aviso no gate). Ping falho: 90 s e, estourando, `clarice-pending.ts skip` (a correção fica para o `resume` do Stage 4, antes do gate); ping ok ou não sondado: 480 s. A Clarice é só REST (`clarice-correct.ts --corrected-out`, #14113) e o runner já aplica o teto; no Fallback, `npx tsx scripts/lib/clarice-stage2-deadline.ts --edition-dir {EDIR}` dá o `deadlineMs` a passar em `--deadline-ms`.

O `category_label` de cada `writer-destaque`, a ação de cada id de lint que volta em `fixes[]`, a proposta do erro intencional, as exceções do `check-invariants --stage 2` e o texto do gate estão em `.claude/agents/orchestrator-stage-2.md` ("Passos fora do runner"). Ler esse arquivo só nesses pontos.

## Fallback — runner ausente ou falha fora dos codes

Se `scripts/stage-2-run.ts` não existir, ou falhar de um jeito não coberto pelos `code`s acima (erro de spawn, exceção fora do `try/catch` do script), ler `.claude/agents/orchestrator-stage-2-fallback.md` e seguir §2a-§2d de lá turno a turno, junto com os passos fora do runner de `orchestrator-stage-2.md`. Essa é a única receita manual da Etapa 2 (#14113): esta skill não repete os passos. Com `$2 = newsletter` ou `social`, pular os passos do outro lado (o `--scope` do runner faz o mesmo). `{EDITION_DIR}` dos playbooks é o `{EDIR}` desta skill.

## Passo 6 — Gate humano unificado

Entra entre `--phase post-checks` e `--phase post-gate`. **Importante (#589, #159):** title-picker é **fallback pós-gate**, não pre-gate. Editor revisa newsletter com **3 opções de título por destaque** e poda manualmente o que quer manter. Se aprovar sem podar, o `post-gate` devolve o `title-picker` (Sonnet, #2772) em `pendingAgentDispatch` para escolher.

**Se `--no-gate`/`--no-gates`:** pular este passo. Ir direto pro `--phase post-gate` (title-picker se necessário, TÍTULO/SUBTÍTULO e o sentinel do Stage 2, #5792) e finalizar com `[AUTO] Etapa 2 auto-aprovada`.

**Caso contrário:** apresentar ao usuário (omitir seções não geradas se `$2` limitou o escopo), com os `gateNotes` do `post-checks` e o texto do gate de `orchestrator-stage-2.md` §2d:

```
Etapa 2 — Escrita pronta.

📁 Newsletter: {EDIR}/02-reviewed.md
   ⚠️  Cada destaque tem 3 opções de título — apague 2 antes de aprovar,
       ou aprove direto pra deixar o title-picker (Sonnet) escolher.

📁 Social: {EDIR}/03-social.md

Clarice — newsletter: {clarice.newsletter}, social: {clarice.social} (diffs em _internal/02-clarice-diff.md e _internal/03-social-clarice-diff.md)

Posts gerados:
- Social (texto único LinkedIn/Facebook/Instagram, #3991) d1 / d2 / d3 + um (4º post USE MELHOR, #9568 — também vai no LinkedIn pessoal)
- Curto (Twitter/X + Threads) d1 / d2 / d3

(pode editar diretamente no arquivo, local ou via Studio, antes de aprovar)

Aprovar (sim) / pedir retry / editar manualmente?
```

`{clarice.*}` vem do JSON do `post-humanize` (`applied`, `no-suggestions`, `unavailable-skipped`, `headers-lost-kept-humanized`). Aguardar resposta. Se "sim", rodar `--phase post-gate`: ele roda o title-picker fallback, a validação de estrutura, TÍTULO/SUBTÍTULO (#916), o selo do humanizador social com o aceite do que o editor editou no gate, o sentinel do Stage 2 (`pipeline-sentinel.ts write --step 2 --outputs "02-reviewed.md,03-social.md"`, #5792) e só depois a limpeza dos snapshots (#9581). Se "retry", re-rodar desde o `--phase pre-dispatch`. Se "editar", instruir o usuário a editar o arquivo e retornar `sim`. Em seguida, `update-stage-status`/`capture-stage-usage` (`delegatedSteps`).

## Outputs

- `{EDIR}/02-reviewed.md` — newsletter final
- `{EDIR}/03-social.md` — texto único LinkedIn/Facebook/Instagram (#3991) + Curto (opcional, #3992) (seções `# Social` com `## d1`/`## d2`/`## d3`/`## um`, e `# Curto` com `## d1`/`## d2`/`## d3`/`## um` — `## um` só quando o 4º post está ligado e há item, #9568)
- `{EDIR}/_internal/02-clarice-diff.md` e `{EDIR}/_internal/03-social-clarice-diff.md` — diffs da Clarice na newsletter e no social
- `{EDIR}/_internal/02-clarice-suggestions.json` e `{EDIR}/_internal/03-clarice-suggestions.json` — sugestões cruas da Clarice (REST)

**Outputs intermediários (mid-stage, removidos no fim do `post-gate`, depois do sentinel):**
- `{EDIR}/_internal/02-pre-clarice.md` — snapshot do input do Clarice (#874 — base do resume mid-Clarice; #873 — input pro check de estabilidade de URLs).
- `{EDIR}/_internal/02-normalized.md` e `{EDIR}/_internal/02-humanized.md` — par pré/pós-humanizador lido por `newsletter-humanizador-diff-ran` (#9581).

## Notas

- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
- Os agentes social leem diretamente de `_internal/01-approved-capped.json` — não dependem de `02-reviewed.md`.
- A Clarice da Etapa 2 é só REST (`clarice-correct.ts --corrected-out`, #14113): nenhum passo desta skill nem dos playbooks chama `mcp__clarice__correct_text`.
