# Spike #1113 — Embeddings pra Filtro 2 de research-reviewer

**Status**: spike doc (methodology proposal). Experimento ainda não rodado.

**Recomendação preliminar**: **hold** até que (a) #344 (embeddings em outras camadas) avance e estabeleça infra ou (b) custo do Filtro 2 LLM se torne dor pontual. Por hora, manter LLM Haiku pinned como está.

## Contexto

`research-reviewer` Filtro 2 (após #1112 que extraiu o Filtro 1 pra script) detecta se um artigo da edição atual tem tema já coberto pela Diar.ia nos últimos 7 dias. Implementação atual: Haiku 4.5 pinned compara semanticamente título + summary do artigo com headers de seção de `context/past-editions.md`.

**Custo atual** (estimado): ~5-15k input tokens + ~2-3k output tokens por edição. Em Haiku 4.5: ~$0.005-0.015 por edição. **Ínfimo** se rodado 1×/dia (~$1-5/ano). Variância entre runs é a dor real, não custo.

## Proposta de alternativa

Substituir LLM call por:
1. Gerar embeddings dos N items de `past-editions.md` (cache em `data/embeddings/past-editions-{hash}.json`)
2. Para cada artigo novo do batch, gerar embedding do `title + summary`
3. Cosine similarity contra todos os items recentes (últimos 7 dias)
4. Threshold experimental: `max_similarity > T` → flag como `topic_covered`

**Vantagens hipotéticas**:
- Determinístico (mesmo input → mesmo output, sempre)
- Mais barato em volume (~$0.0001/edição com OpenAI small)
- Cacheable e parallelizável

**Riscos**:
- Falsos positivos diferentes do LLM. Embeddings veem similaridade superficial; LLM faz raciocínio temático. "Críticas ao GPT-5" e "Lançamento do GPT-5" têm alta cosine similarity mas são editorialmente distintos.
- Threshold calibração depende de sample editorial diverso.
- Multilíngue PT-BR: nem todos os modelos performam igual.

## Modelos candidatos

| Modelo | Custo | PT-BR | Dimensões | Latência | Notas |
|---|---|---|---|---|---|
| OpenAI `text-embedding-3-small` | $0.02/1M | OK (via training mix) | 1536 | ~50ms | Padrão de fato; API estável |
| OpenAI `text-embedding-3-large` | $0.13/1M | Melhor que small | 3072 | ~80ms | 6× custo, ganho marginal em PT-BR? |
| Cohere `embed-multilingual-v3.0` | $0.10/1M | **Nativo multilíngue** | 1024 | ~70ms | Melhor candidato em pt-BR teoricamente |
| Local `paraphrase-multilingual-MiniLM-L12-v2` (sentence-transformers) | $0 | Multilíngue treinado | 384 | ~5ms local | Requer Python sidecar; setup complexo |
| Local `Alibaba-NLP/gte-multilingual-base` | $0 | Multilíngue treinado | 768 | ~10ms local | Estado da arte open-source 2024-25 |

**Recomendação se for executar**: começar com OpenAI small (infra mínima, qualidade conhecida) + 1 modelo local como controle.

## Methodology proposta

### Setup

1. **Dataset**: pegar últimas 50 edições publicadas (~50 × 8 artigos = ~400 artigos). Para cada edição N, simular o Filtro 2 contra `past-editions.md` truncado em N-1.
2. **Ground truth**: usar a decisão LLM atual como "verdade" comparativa (não absoluta — LLM erra também, mas é o baseline). Ou anotar manualmente 50 cases ambíguos.
3. **Métricas**: precision, recall, F1. Calibrar threshold em training set (30 edições), validar em test set (20 edições).

### Execução

1. Script `scripts/spike/build-embeddings.ts` — gera embeddings pra todos os items de `past-editions.md` + artigos do dataset.
2. Script `scripts/spike/compare-filtro2.ts` — pra cada artigo, calcula cosine similarity vs items recentes, output `{ url, max_sim, llm_verdict, predicted_verdict }`.
3. Notebook ou script de análise — varia threshold de 0.70 a 0.95, plota precision/recall, escolhe operational point.

### Decision criteria

- **Adotar embeddings** se: precision >= 0.85 (poucos falsos positivos = poucos artigos legítimos removidos por engano) E recall >= 0.85 (não deixa muitos repetidos passarem). Latência irrelevante (Filtro 2 é offline).
- **Manter LLM** se: precision/recall ficar abaixo de qualquer agreement humano typical. Ou se calibração varia muito mês a mês (sinal de instabilidade).
- **Híbrido** se métricas borderline: embeddings como pré-filtro (high recall, low precision) seguido de LLM apenas pra borderline cases (similarity 0.70-0.85). Custo reduzido mantendo precisão.

## Esforço estimado pra rodar o spike

- Setup datasets + scripts: 4-6h
- Run experiments + análise: 2-3h
- Doc de resultados + decisão: 1-2h
- **Total**: 1-2 dias engajamento real

## Decisão pra esta sessão

**Hold**. Razões:

1. **Custo atual é baixo**. ~$1-5/ano em Haiku tokens não justifica o esforço.
2. **Variância entre runs é o problema real**, mas não causou incidente até hoje. Não tem dor pontual pra justificar urgência.
3. **#344 (embeddings em outras camadas) ainda não avançou**. Se #344 instalar infra de embeddings (modelo escolhido, cache layer), o spike fica trivial — só falta plumbing.
4. **Sample size de 50 edições não existe ainda** (Diar.ia tem 50+ edições rodadas, mas anotação manual leva tempo).

Re-avaliar quando:
- Custo Haiku do Filtro 2 ultrapassar $20/mês (sinal de escala)
- Bug real causado por variância do LLM (e.g., artigo legítimo removido)
- #344 estabelecer infra de embeddings reutilizável

## Referências

- Issue origem: #1113
- Triagem origem: `docs/agent-migration-triage.md` follow-up #4
- Issue relacionada: #344 (embeddings)
- Custo atual: ~$0.005-0.015/edição em Haiku 4.5 pinned (`claude-haiku-4-5-20251001`)
