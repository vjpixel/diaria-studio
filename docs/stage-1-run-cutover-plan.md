# Plano de cutover — `scripts/stage-1-run.ts` (#5415, follow-up)

Este documento é a spec de como o playbook FUTURO (`.claude/agents/orchestrator-stage-1-research.md`)
deve orquestrar `scripts/stage-1-run.ts`. **Não é implementado nesta issue** —
esta unidade (#5415 incremento 3/3) só construiu o runner + testes,
seguindo o mesmo padrão de `docs/` para Stage 0/3 (`stage-0-run.ts`/
`stage-3-run.ts` também têm o cutover do playbook como decisão separada —
ver #5857/#5873/#5010). Ligar isto ao fluxo real da edição diária é uma
issue de follow-up (**#5010**), revisada pelo editor antes de rodar contra
uma edição real — o `orchestrator-stage-1-research.md` **não foi tocado**
por esta unidade.

## Por que 5 fases, não 2-3

Stage 1 tem **7 pontos de dispatch `Agent()`** no playbook (contra 1 do
Stage 0 — os 3 pings MCP, agrupados numa fronteira só — e 1 do Stage 3 — o
crop-reviewer). Um script `spawnSync` não pode chamar `Agent`, então cada
ponto onde o playbook precisa de um resultado de Agent pra continuar é uma
fronteira onde o script precisa PARAR e devolver controle pro orchestrator
top-level. Ver o comentário de topo de `scripts/stage-1-run.ts` para o
mapeamento completo dos 7 pontos e como cada um foi tratado (coberto via
fase + `pendingAgentDispatch`, ou delegado com racional).

As 5 fases, em ordem:

1. `pre-research`
2. `post-research-pre-score`
3. `post-score` (só no caminho chunked — pool pequeno pula direto pro 4)
4. `post-select-render`
5. `post-gate`

## Sequência de invocação (pseudo-código do orchestrator futuro)

```
# --- Fase 1 ---
r1 = run(stage-1-run.ts --phase pre-research --edition {AAMMDD})
if r1.pendingAgentDispatch não-vazio (Path B, raro — Path A é default #1560):
    ler r1.pendingAgentDispatch[0].manifestPath (stage-1-path-b-manifest.json)
    despachar 1x source-researcher POR item de manifest.sourcesKept (Agent, paralelo)
    despachar 1x discovery-searcher POR query de manifest.discoveryQueriesDeterministic (Agent, paralelo)
    COMPOR ~5 queries PT + ~5 EN temáticas genéricas (julgamento do orchestrator — sem pool
      determinístico, ver DELEGATED_STEPS) e despachar 1x discovery-searcher por query (Agent, paralelo)
    agregar TODOS os resultados num único RunRecord[] JSON, escrever em disco
    r2 = run(stage-1-run.ts --phase post-research-pre-score --edition {AAMMDD} \
              --agent-research-results <path-do-agregado>)
else:
    r2 = run(stage-1-run.ts --phase post-research-pre-score --edition {AAMMDD})

# --- Fase 2 -> Fase 3 ou pula pro fallback ---
if r2.code == 2: apresentar r2.haltRequired, aguardar decisão humana, não prosseguir
if r2.needsScorerFallback:
    despachar 1x scorer (Agent) — input r2.pendingAgentDispatch[0].manifestPath
      (tmp-scoring-pool.json), out_path tmp-scored.json
    r4 = run(stage-1-run.ts --phase post-select-render --edition {AAMMDD} \
              --fallback-scored-json <edition-dir>/_internal/tmp-scored.json)
else:
    chunkCount = r2.chunkCount
    despachar chunkCount x scorer-chunk (Agent, TODOS EM PARALELO — mesma mensagem de tool calls)
      — input scoring-chunks/scoring-chunk-{i}.json, out_path scoring-chunks/scored-chunk-{i}.json
    r3 = run(stage-1-run.ts --phase post-score --edition {AAMMDD} --chunk-count {chunkCount})
    if r3.code == 1 and r3.mergeCatastrophic:
        # #1669 — NÃO seguir com resultado degradado
        retry: re-despachar scorer-chunk só pros índices em r3.failedChunks, re-chamar --phase post-score
        OU cair no fallback: despachar 1x scorer sobre tmp-scoring-pool.json, ir pro post-select-render
          --fallback-scored-json
    r3 = run(...) # após retry bem-sucedido
    despachar 1x scorer-select (Agent) — input r3.pendingAgentDispatch[0].manifestPath
      (tmp-finalists.json), out_path tmp-selection.json
    r4 = run(stage-1-run.ts --phase post-select-render --edition {AAMMDD} \
              --selection-json <edition-dir>/_internal/tmp-selection.json)

# --- Fase 4 ---
if r4.code == 2: apresentar r4.haltRequired, aguardar decisão humana (retry/abort), não prosseguir
if r4.code == 1: erro duro — investigar antes de retentar

# ANTES do gate, OPCIONAL (delegado, fail-soft — pode ser pulado sem quebrar nada):
#   §1m-ter (discovery-searcher por launch_candidate) e §1m-quinquies (discovery-searcher
#   por vídeo não-YouTube) — se o orchestrator quiser preservar esse nível de automação,
#   despachar aqui, ANTES de r4 rodar (ou aceitar a degradação: guard explícito no
#   playbook já cobre "nada verificado -> manter como notícia" / "flagged -> editor
#   resolve no gate manualmente").

# GATE HUMANO (§1x) — apresentar r4.minSectionWarnings, r4.lancamentosWarnings,
# r4.validateOutput.assertions (status=warn), etc. Formatação/prosa continua do orchestrator.
# Se auto_approve: pular a apresentação, ir direto pra Fase 5 com --auto.

# --- Fase 5 ---
if editor editou o MD:
    r5 = run(stage-1-run.ts --phase post-gate --edition {AAMMDD} --md {edition-dir}/01-categorized.md)
else (auto_approve):
    r5 = run(stage-1-run.ts --phase post-gate --edition {AAMMDD} --auto)

# OPCIONAL, delegado (fail-soft): §1y resolve-primary-source.ts — despachar
# discovery-searcher por artigo secundário aprovado elegível, DEPOIS de r5,
# se o orchestrator quiser essa automação extra. Nunca bloqueia o que já foi aprovado.
```

## Checklist de validação antes do cutover real

Quando a issue de follow-up (#5010) for aberta pra ligar isto de fato:

1. **Rodar `--phase pre-research` sozinho contra uma edição de TESTE** (nunca
   uma edição real do dia) e conferir que `researcher-results.json`,
   `rss-batch.json`, `websearch-batch.json`/`websearch-results.json` saem
   com o mesmo shape que a versão em prosa produzia — comparar campo a
   campo contra uma edição recente rodada pelo playbook atual.
2. **Rodar as 5 fases em sequência manualmente** (com dispatches reais de
   Agent nos pontos de pausa) contra a MESMA edição de teste e comparar
   `01-categorized.md`/`01-categorized.json`/`01-approved.json` finais
   byte-a-byte (ou quase) contra o output do playbook em prosa rodando a
   mesma edição — divergência esperada só nos pontos delegados (§1m-ter,
   §1m-quinquies, thematic PT/EN queries do Path B).
3. **Confirmar que os 6 pontos HALT** (`haltRequired`, code 2) disparam
   banners equivalentes aos do playbook em prosa nos mesmos cenários —
   testável com fixtures (já coberto por `test/stage-1-run.test.ts`), mas
   vale uma passada manual pra confirmar que o TEXTO do banner ainda faz
   sentido pro editor.
4. **Só então** editar `.claude/agents/orchestrator-stage-1-research.md`
   pra substituir a prosa detalhada por chamadas a este script + as
   instruções de dispatch de Agent nos pontos de pausa — mesmo padrão que
   `orchestrator-stage-0-preflight.md`/`orchestrator-stage-3.md` já fazem
   parcialmente (ver como eles introduzem `stage-0-run.ts`/`stage-3-run.ts`
   como o caminho principal, preservando a prosa como fallback/referência).
5. **Rodar `NODE_TEST_SNAPSHOTS=1 npx tsx --test test/orchestrator-prompt.test.ts`**
   (regra #634, `context/overnight-dispatch-rules.md` item 4) antes do
   push — qualquer edição em `.claude/agents/orchestrator-*.md` passa por
   esse teste.

## O que fica fora do escopo do cutover (permanece delegado indefinidamente)

- **§1f Path B — queries temáticas PT/EN genéricas.** Sem pool
  determinístico (diferente de how-to #2313 / negative-impact
  #3916/#3918). O orchestrator sempre compõe essas na hora, mesmo pós-cutover.
- **§1m-ter/§1m-quinquies.** Fail-soft por design no próprio playbook —
  não vale o custo de coordenar mais 2 fronteiras de pausa pra um
  enhancement opcional que já degrada bem sem elas.
- **§1g cost-capture (record-agent-costs.ts).** Precisa do bloco `<usage>`
  real dos dispatches Agent — só a sessão top-level tem esse dado.
- **§1y resolve-primary-source.ts.** Enhancement pós-gate opcional,
  fail-soft, não afeta o que o editor já aprovou.
- **§1x — apresentação do gate humano.** Formatação/prosa do resumo pro
  editor continua sendo responsabilidade do orchestrator (o script devolve
  os dados estruturados; o texto final quem escreve é o LLM).
