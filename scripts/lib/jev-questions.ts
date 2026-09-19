/**
 * jev-questions.ts (#8413 — Fase 0 do epic #8412)
 *
 * Registro central de perguntas Jev. Cada medição futura (#8414-#8420) declara
 * aqui o texto EXATO que vai usar antes de rotular o gabarito cego — é o
 * mesmo texto que a implementação real vai usar depois se a medição
 * "adotar". Isso é o que evita "prompt afinado depois de ver o corpus"
 * (#8211 controlou isso ad-hoc, repetindo a medição com o texto de critério
 * original; aqui o texto original fica versionado ANTES da rotulagem, então
 * não há necessidade de repetir o controle a cada medição).
 *
 * Cada entrada declara também o `expectedState` — os campos de `state` que a
 * pergunta espera receber (ex: `title`, `url`, `summary`) — como documentação
 * executável de dependência entre a pergunta e o formato do item que vai
 * alimentá-la. `jev-eval.ts`/features futuras usam isso pra montar `state`
 * sem precisar caçar no código da medição original.
 *
 * Esta issue (#8413) só precisa que o módulo/schema EXISTA e funcione fim-a-
 * fim — populá-lo com as perguntas reais das medições 1-7 é trabalho das
 * issues dependentes (#8414+). A única entrada real aqui é a de reprodução
 * do gabarito do #8211 (`bucket-tiebreaker-8211`), que prova o harness
 * funciona reproduzindo uma medição já feita — mesma pergunta, mesmo texto,
 * já usada em produção (`scripts/lib/semantic-tiebreaker.ts`).
 */

import type { JevQuestion } from "./jev.ts";

/**
 * Estado que a pergunta espera em `state` — nomes de campo, sem tipo runtime
 * (é documentação, não validação: `askJev` aceita `Record<string, unknown>`
 * livre e a issue não pede um schema de validação de state).
 */
export type ExpectedStateField = string;

export interface JevQuestionSpec {
  /** Slug único da medição/feature — vira o `id` da pergunta em `askJev`. */
  id: string;
  /** Issue de origem (#NNNN), pra rastrear proveniência. */
  issue: string;
  /** Campos de `state` que esta pergunta consome. */
  expectedState: ExpectedStateField[];
  /** Estado/veredito esperado quando a medição adotar (documentação — não usado pelo harness). */
  expectedOutcome: string;
  /** A pergunta em si, pronta pra passar a `askJev`/`askJevBatch`. */
  question: JevQuestion;
}

/**
 * Reprodução do gabarito do #8211 (n=22, 17/09/2026) — a MESMA pergunta
 * `bucket` de `scripts/lib/semantic-tiebreaker.ts` (`TIEBREAKER_INSTRUCTIONS`/
 * `TIEBREAKER_CRITERIA`), reescrita aqui como `JevQuestion` pra provar que
 * `jev.ts`/`jev-eval.ts` reproduzem o resultado original (20/22) sem viés
 * introduzido pelo harness novo. Texto IDÊNTICO ao módulo de produção —
 * qualquer divergência de texto invalidaria a reprodução como prova.
 */
export const BUCKET_TIEBREAKER_8211: JevQuestionSpec = {
  // id casa com `BUCKET_TIEBREAKER_8211_FEATURE.id` (`scripts/lib/blind-label-features.ts`)
  // — `jev-eval.ts` resolve a pergunta pelo id da FEATURE, não pelo id da
  // pergunta em si (que é "bucket", o nome da chave na wire da API).
  id: "bucket-tiebreaker-8211",
  issue: "#8211",
  expectedState: ["title", "url", "summary"],
  expectedOutcome: "20/22 contra o gabarito cego (data/bucket-blind-labels.json)",
  question: {
    id: "bucket",
    type: "choice",
    instructions:
      "Este link anuncia o LANÇAMENTO de um produto, feature ou modelo de IA que " +
      "o leitor pode usar diretamente, ou é notícia/cobertura de imprensa/" +
      "relatório/marco institucional/parceria de negócio/opinião sobre a " +
      "empresa ou produto?",
    criteria: {
      lancamento:
        "Anúncio OFICIAL, feito pela própria empresa que o criou, de um produto, " +
        "ferramenta, modelo ou feature NOVA que o leitor pode começar a usar.",
      radar:
        "Notícia, análise, entrevista, ensaio, relatório, pesquisa, marco " +
        "corporativo ou anúncio institucional — sem lançar um produto usável.",
    },
  },
};

/**
 * Medição 1 do epic #8412 (#8414) — `negative_impact` por artigo via Jev
 * (tipo `noul`) vs. tag do `scorer-chunk` + backstop determinístico
 * (`negative-impact-promotion.ts`). Texto EXATO da issue #8414 — nenhum
 * ajuste pós-corpus.
 */
export const NEGATIVE_IMPACT_8414: JevQuestionSpec = {
  id: "negative-impact-8414",
  issue: "#8414",
  expectedState: ["title", "url", "summary"],
  expectedOutcome:
    "ganho medido sobre a tag do scorer-chunk no gabarito cego (McNemar) — critério de pronto de #8414",
  question: {
    id: "negative_impact",
    type: "noul",
    instructions:
      "Este artigo documenta um dano REAL já causado por IA (prejuízo, vítima, perda, " +
      "decisão adversa, falha com consequência) — não uma menção de risco hipotético, " +
      "não um benchmark ruim, não uma crítica de opinião.",
  },
};

/**
 * Medição 4 do epic #8412 (#8417) — zona cinzenta do `dedup.ts` (Pass 1c):
 * "A e B são a mesma história?" via Jev (`noul`). Texto EXATO da issue #8417
 * — nenhum ajuste pós-corpus. `state` recebe `{a: {title,summary,source},
 * b: {title,summary,source}}` (par, não item único — diferente das duas
 * perguntas anteriores).
 */
export const DEDUP_GRAYZONE_8417: JevQuestionSpec = {
  id: "dedup-grayzone-8417",
  issue: "#8417",
  expectedState: ["a", "b"],
  expectedOutcome: "ganho medido sobre a heurística Jaccard/thresholdForPair na zona cinzenta (McNemar) — critério de pronto de #8417",
  question: {
    id: "same_story",
    type: "noul",
    instructions:
      "Dados dois artigos A e B sobre inteligência artificial, A e B relatam o mesmo " +
      "fato/anúncio (mesma história), e não dois fatos distintos sobre o mesmo assunto? " +
      "Considere apenas título, resumo e fonte de cada artigo, fornecidos em `a` e `b` " +
      "do estado.",
  },
};

/**
 * Medição 4 do epic #8412 (#8417) — zona cinzenta do
 * `check-highlight-themes.ts`: "A é o mesmo TEMA de B ao ponto de um leitor
 * sentir repetição?" — critério mais frouxo que `dedup-grayzone-8417`
 * (mesmo fato) de propósito, pois é o que a issue pede para essa 2ª
 * pergunta. Texto EXATO da issue #8417.
 */
export const HIGHLIGHT_THEMES_GRAYZONE_8417: JevQuestionSpec = {
  id: "highlight-themes-grayzone-8417",
  issue: "#8417",
  expectedState: ["a", "b"],
  expectedOutcome: "ganho medido sobre a heurística Jaccard/thresholdForPair na zona cinzenta (McNemar) — critério de pronto de #8417",
  question: {
    id: "same_theme",
    type: "noul",
    instructions:
      "Dados dois artigos A e B sobre inteligência artificial, A é o mesmo TEMA de B ao " +
      "ponto de um leitor sentir repetição numa newsletter diária, mesmo que não sejam o " +
      "mesmo fato/anúncio específico? Este critério é MAIS FROUXO que \"mesma história\" — " +
      "artigos sobre o mesmo assunto geral já contam, mesmo com fatos distintos. " +
      "Considere apenas título, resumo e fonte de cada artigo, fornecidos em `a` e `b` " +
      "do estado.",
  },
};

/**
 * Registro por id — cada medição futura adiciona sua entrada aqui (#8414+).
 * `jev-eval.ts --feature X` resolve a pergunta por este mapa.
 */
export const JEV_QUESTION_REGISTRY: Record<string, JevQuestionSpec> = {
  [BUCKET_TIEBREAKER_8211.id]: BUCKET_TIEBREAKER_8211,
  [NEGATIVE_IMPACT_8414.id]: NEGATIVE_IMPACT_8414,
  [DEDUP_GRAYZONE_8417.id]: DEDUP_GRAYZONE_8417,
  [HIGHLIGHT_THEMES_GRAYZONE_8417.id]: HIGHLIGHT_THEMES_GRAYZONE_8417,
};

export function getJevQuestionSpec(id: string): JevQuestionSpec | undefined {
  return JEV_QUESTION_REGISTRY[id];
}
