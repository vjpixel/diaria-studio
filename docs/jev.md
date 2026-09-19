# Jev — harness de medição (#8413, Fase 0 do epic #8412)

Jev é o apelido do classificador externo **TypeSafe System One** (modelo
`jev-latest`) — o mesmo serviço que o #8211/#8219 já usam como tie-breaker
semântico do fallback do categorizador (`scripts/lib/semantic-tiebreaker.ts`).
Este documento é o contrato/limites gerais; o módulo de produção do #8211
continua sendo a implementação de referência para o tipo `choice`.

Este harness (`scripts/lib/jev.ts` + `scripts/blind-label-sample.ts` +
`scripts/jev-eval.ts` + `scripts/lib/jev-questions.ts`) existe para que
**toda medição futura do epic #8412** (#8414-#8420) meça Jev contra um
gabarito cego ANTES de decidir adotar — nunca implementa direto na produção
sem essa etapa.

## Contrato da API

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <TYPESAFE_API_KEY>
Content-Type: application/json

{
  "model": "jev-latest",
  "state": { ...campos livres — ex: title, url, summary },
  "questions": {
    "<id>": { "type": "choice" | "score" | "noul", ... }
  }
}
```

Resposta:

```
{
  "model": "jev-1.13.0",
  "answers": {
    "<id>": { "type": "...", ... }
  },
  "usage": { "input_tokens": N, "output_tokens": M }
}
```

- **1 request avalia N perguntas em paralelo, sobre 1 `state`.** O custo de
  latência de perguntas extras é ~zero — é por isso que uma medição que
  precisa de várias perguntas sobre o MESMO item (ex: `bucket` + `severidade`)
  deve batchá-las numa única chamada `askJev`, não fazer N requests.
- **Não existe endpoint de batch de ITENS.** Pra avaliar vários itens
  (artigos, edições), são N requests concorrentes — `askJevBatch` faz isso
  com um teto de concorrência (`JEV_CONCURRENCY = 8`, mesmo valor usado pelo
  script de medição original do #5995/#8211).
- **Só o tipo `choice`, com 1 pergunta por request, foi confirmado contra a
  API real** (#8219, 17/09/2026). `score` e `noul` seguem o mesmo envelope
  por analogia — a 1ª medição que os usar de verdade (#8414 usa `noul`,
  #8415 usa `score`) deve fazer a mesma verificação pontual de contrato que
  o #8219 fez pra `choice`, e atualizar este documento se o shape divergir.

## Os 3 tipos de pergunta

| tipo | pergunta | resposta | uso |
|---|---|---|---|
| `choice` | 1 de N opções, com `criteria: {opção: descrição}` | `{ choice, confidence, probabilities? }` | classificação categórica (ex: bucket do categorizador) |
| `score` | nível numa escala descrita (`min`/`max`) | `{ score, confidence }` | eixo atômico de um score composto (ex: gravidade) |
| `noul` | probabilidade 0-1 de uma afirmação ser verdadeira | `{ probability, confidence }` | julgamento binário com incerteza (ex: "isto causa dano real?") |

`confidence` pode vir ausente na resposta real — `jev.ts` trata isso como
`1` (mesma leniência que `semantic-tiebreaker.ts` já tinha pro `choice`).

## Limites

- **Texto só.** Confirmado ao vivo em 19/09/2026: a API não aceita
  imagem/áudio/vídeo. Qualquer medição sobre conteúdo visual (crop de
  imagem, thumbnail) está fora do escopo do Jev.
- **Treino primariamente em inglês.** Texto em PT-BR tem acurácia menor
  (documentação oficial do vendor). Toda medição deve rotular o gabarito
  cego com o texto REAL que a pergunta vai receber em produção — nunca
  traduzir o corpus pra inglês só pra medir melhor.
- **Vendor novo, sem página de preço pública** (`typesafe.ai/pricing` dá
  404 — mesma ressalva do #8211). Toda feature que adotar Jev precisa de
  fail-soft: API fora do ar/key ausente/timeout → comportamento atual, sem
  travar a pipeline.
- **Custo:** ~US$ 0,042/1M tokens de entrada, saída grátis. Não é critério
  de decisão (uma edição inteira roda por centavos).

## Cache em disco

`askJev`/`askJevBatch` aceitam `cacheDir` — quando setado, a resposta é
persistida em disco chaveada por `(cacheKey do item, hash das perguntas)`
(`hashJevQuestions`, ordem-independente). Reexecutar `jev-eval.ts` sobre o
MESMO gabarito (ex: ajustando o limiar de confiança depois de olhar a curva)
não paga custo de rede de novo. `cacheKey` default é
`state.url ?? state.id ?? JSON.stringify(state)`.

## Como declarar uma medição nova

1. **Escreva a pergunta ANTES de rotular** em `scripts/lib/jev-questions.ts`
   — um novo `JevQuestionSpec` com `id` (mesmo id da `FeatureDef`), `issue`,
   `expectedState` (campos de `state` que a pergunta consome) e `question`
   (o objeto `JevQuestion` pronto pra `askJev`). Esse texto é o que vai pra
   produção depois se a medição "adotar" — não afinar depois de ver o corpus.
2. **Registre a `FeatureDef`** em `scripts/lib/blind-label-features.ts` —
   `collectPool(rootDir)` devolve o pool "em silêncio" (candidatos nunca
   contestados pelo editor no gate) com `stratum`/`hiddenGuess` do mecanismo
   atual. Ver `BUCKET_TIEBREAKER_8211_FEATURE` como referência.
3. **Gere a amostra e rotule às cegas:**
   ```
   npx tsx scripts/blind-label-sample.ts --feature <id> --generate 60
   npx tsx scripts/blind-label-sample.ts --feature <id> --next 4
   npx tsx scripts/blind-label-sample.ts --feature <id> --record <id-do-item> <rótulo>
   npx tsx scripts/blind-label-sample.ts --feature <id> --report
   ```
   Estado em `data/jev-eval/{feature}/sample.json` (amostra) e
   `data/jev-eval/{feature}/labels.jsonl` (rótulos, append-only) —
   gitignored junto com `data/`, nunca versionado.
4. **Compare Jev com o mecanismo atual:**
   ```
   npx tsx scripts/jev-eval.ts --feature <id>
   ```
   Saída em markdown (acurácia dos dois, matriz de confusão, McNemar,
   curva confiança×acerto) — pronta pra colar na issue da medição.
5. **Veredito.** Sem ganho medido → a fase fecha "não adotar", registrado na
   issue. Com ganho → issue de implementação separada, atrás de flag
   `platform.config.json` → `jev.features.{nome}` (default OFF em
   `/diaria-edicao`), shadow mode primeiro (grava em `_internal/01-jev.json`
   sem tocar produção), fail-soft obrigatório. Ver #8412 "Método comum".

## Reprodução do #8211 (prova de que o harness não introduz viés)

A feature `bucket-tiebreaker-8211` reproduz a medição original do #8211
(n=22, 17/09/2026: 20/22 contra o gabarito cego) usando exatamente a mesma
pergunta (`BUCKET_TIEBREAKER_8211` em `jev-questions.ts`, texto idêntico a
`TIEBREAKER_INSTRUCTIONS`/`TIEBREAKER_CRITERIA` de
`scripts/lib/semantic-tiebreaker.ts`) sobre o MESMO gabarito
(`data/bucket-blind-labels.json`, rotulado pela ferramenta original —
migrado pro formato novo em `data/jev-eval/bucket-tiebreaker-8211/`).

**Achado ao vivo (19/09/2026): a API não é determinística — 3 chamadas
seguidas, mesmo gabarito, mesmo texto de pergunta, devolveram 19/22, 17/22 e
18/22, nunca os 20/22 exatos do #8211.** O mecanismo atual (determinístico,
lido direto do disco) reproduziu **byte-a-byte 12/22 (54,5%)** nas 3
rodadas — é essa parte, o lado determinístico do harness, que a
reprodução prova estar livre de viés introduzido pela generalização. O lado
Jev variou entre 77,3% e 86,4% nas 3 rodadas, **sempre** significativamente
acima do mecanismo (McNemar p<0,05 em todas as rodadas com dado calculado) —
a DIREÇÃO e a MAGNITUDE do achado do #8211 se sustentam, mas o número exato
"20/22" não é reproduzível numa API que amostra sem `temperature=0`/seed
fixo (o contrato confirmado no #8219 não documenta nenhum parâmetro de
determinismo, e a issue não pede que `jev.ts` invente um — é limite do
vendor, não do harness). **Consequência prática pra medições futuras
(#8414+):** rodar `jev-eval.ts` UMA vez e ler o número não é suficiente
pra decidir "adotar" perto do limiar — rodar 2-3x e olhar a FAIXA, não o
ponto, antes de registrar um veredito na issue da medição.
