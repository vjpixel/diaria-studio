/**
 * scripts/lib/shadow-score.ts (#7977, Camada 2 shadow-mode da #7972)
 *
 * Cálculo do `shadow_score_alt` — score alternativo calculado com pesos
 * CANDIDATOS em vez dos pesos reais hardcoded no rubrico do scorer LLM
 * (`.claude/agents/scorer.md`/`scorer-chunk.md`). TS puro, determinístico,
 * ZERO chamada de LLM — nunca afeta `score`/`score_base` reais nem a
 * seleção de nenhuma edição.
 *
 * Fórmula: `shadow_score_alt = score_base + Σ peso_candidato[f] × 1{feature f presente}`
 *
 * `score_base` (a parte de julgamento holístico do LLM — "relevância pra
 * audiência" + "atualidade") é REUSADO do score real, nunca recalculado —
 * só a parte determinística (os bônus por feature) é recalculada com pesos
 * diferentes. Isso é deliberado: o shadow-mode testa "e se os PESOS dos
 * bônus fossem outros", não "e se o julgamento holístico do LLM fosse
 * outro" (essa segunda pergunta exigiria rodar o LLM de novo — custo real,
 * fora do escopo de um mecanismo que promete "zero LLM extra").
 *
 * **`shadow_score_alt` NÃO reproduz `score` real, mesmo com pesos idênticos
 * aos do rubrico — achado medido ao vivo, não hipótese.** `weights` aqui só
 * cobre as features booleanas de `CANDIDATE_FEATURES`
 * (`calibration-power-report.ts`): `primary_source`/`hands_on`/`academy`/
 * `howto_br`/`howto_br_source`. O rubrico real do scorer também aplica
 * `impact_routine`(+10)/`impact_routine_br`(+5, julgamento do LLM sobre se
 * o bônus se aplica, não uma feature booleana pré-computada),
 * `coverage`(+5/fonte extra, sem teto) e o bônus tiered de
 * `audience_affinity` — nenhum desses é modelado aqui, porque não são
 * features booleanas simples com presença/ausência determinística (são
 * julgamento do LLM, ou numéricos/tiered). Medido contra o corpus real
 * (105 edições, pesos candidato idênticos ao rubrico real): 724/1170
 * linhas comparáveis batem exatamente; as outras 446 diferem pela soma
 * dos bônus não-modelados que se aplicaram àquele artigo especificamente
 * (diferenças observadas: -5 a -70, sempre negativas — shadow SUBESTIMA
 * porque não conta bônus que o real conta, nunca o contrário). Isso é
 * esperado e não invalida o mecanismo: o que o shadow-mode mede é
 * concordância de RANKING dentro do subconjunto calibrável, não
 * reprodução do valor absoluto do score real — ver
 * `scripts/shadow-validation-report.ts`.
 */

import { createHash } from "node:crypto";
import type { ScoringFeatureRow } from "./scoring-features.ts";

/**
 * Pesos candidatos — chave é o nome da feature booleana (mesmo domínio de
 * `CANDIDATE_FEATURES` em `calibration-power-report.ts`), valor é o ponto
 * a somar quando a feature é `true`. Sem entrada pra uma feature = peso 0
 * (mesmo efeito que omitir do rubrico real).
 */
export type CandidateWeights = Readonly<Record<string, number>>;

export interface CandidateWeightsFile {
  /** Identificador legível do candidato (não é o hash — ver `weightsHash`). */
  label: string;
  /** Data em que este arquivo de pesos foi commitado — proveniência, nunca usada pra cálculo. */
  created_at: string;
  /** Justificativa de onde os pesos vieram (baseline real, ou saída de calibrate-scoring-weights.ts quando existir). */
  rationale: string;
  weights: CandidateWeights;
}

/**
 * Hash de conteúdo determinístico do conjunto de pesos — SHA-256 hex do
 * JSON canônico (chaves ordenadas, sem espaço). Usado como nome de arquivo
 * (`data/shadow/candidate-weights/{hash}.json`) e referenciado em todo
 * `scoring-shadow.json` que usar este candidato — rastreabilidade total de
 * qual conjunto de pesos produziu qual shadow score, mesmo se o `label`
 * mudar de nome depois.
 */
export function weightsHash(weights: CandidateWeights): string {
  const canonical = JSON.stringify(weights, Object.keys(weights).sort());
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function featureValue(row: ScoringFeatureRow, feature: string): boolean {
  return (row as unknown as Record<string, unknown>)[feature] === true;
}

/**
 * Calcula `shadow_score_alt` pra 1 linha do feature store. `null` se
 * `score_base` não estiver disponível (feature store de edição antiga
 * sem esse campo, ou extração que falhou) — nunca fabrica um valor.
 */
export function computeShadowScore(row: ScoringFeatureRow, weights: CandidateWeights): number | null {
  if (typeof row.score_base !== "number") return null;
  let bonus = 0;
  for (const [feature, weight] of Object.entries(weights)) {
    if (featureValue(row, feature)) bonus += weight;
  }
  return row.score_base + bonus;
}
