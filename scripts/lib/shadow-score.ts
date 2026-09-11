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
 * (`calibration-power-report.ts`, 6 features após excluir
 * `NON_CALIBRATABLE_FEATURES`): `primary_source`/`hands_on`/`academy`/
 * `howto_br`/`howto_br_source`/`has_official_link` (esta última sem peso
 * no candidato baseline, então não afeta o cálculo hoje). O rubrico real
 * do scorer também aplica `impact_routine`(+10)/`impact_routine_br`(+5,
 * julgamento do LLM sobre se o bônus se aplica, não uma feature booleana
 * pré-computada), `coverage`(+5/fonte extra, sem teto) e o bônus TIERED de
 * `audience_affinity` (+10/+5/+0/**-5**, este último uma PENALIDADE) —
 * nenhum desses é modelado aqui, porque não são features booleanas
 * simples com presença/ausência determinística (são julgamento do LLM, ou
 * numéricos/tiered). Medido contra o corpus real (105 edições, pesos
 * candidato idênticos ao rubrico real): 724/1170 linhas comparáveis batem
 * exatamente; as outras 446 diferem pela soma dos bônus/penalidades
 * não-modelados que se aplicaram àquele artigo especificamente
 * (diferenças observadas: -70 a +5 — a maioria negativa, shadow tende a
 * SUBESTIMAR por não contar bônus que o real conta, mas 53/446 são
 * POSITIVAS: quando a penalidade não-modelada de `audience_affinity`
 * (-5, affinity < 0.1) supera os bônus não-modelados aplicáveis àquele
 * artigo, shadow > real. Nenhuma direção fixa é garantida). Isso é
 * esperado e não invalida o mecanismo: o que o shadow-mode mede é
 * concordância de RANKING dentro do subconjunto calibrável, não
 * reprodução do valor absoluto do score real — ver
 * `scripts/shadow-validation-report.ts`.
 */

import { createHash } from "node:crypto";
import type { ScoringFeatureRow } from "./scoring-features.ts";
import type { CandidateFeature } from "../calibration-power-report.ts";

/**
 * Pesos candidatos — chave é o nome de uma feature booleana calibrável
 * (`CandidateFeature`, de `CANDIDATE_FEATURES` em
 * `calibration-power-report.ts` — a ÚNICA fonte de verdade de nomes
 * válidos), valor é o ponto a somar quando a feature é `true`. Sem entrada
 * pra uma feature = peso 0 (mesmo efeito que omitir do rubrico real).
 * `Partial` porque um candidato raramente pesa TODAS as features — só as
 * que está testando. Tipado contra `CandidateFeature` (não `string` solto)
 * de propósito: um typo ou nome obsoleto vira erro de COMPILAÇÃO ao montar
 * um `CandidateWeightsFile` em TS, em vez de silenciosamente contribuir
 * peso 0 pra sempre sem nenhum sinal (achado de review do #7977) — arquivo
 * JSON hand-authored ainda pode ter uma chave inválida, por isso
 * `compute-shadow-scores.ts` também valida em runtime ao carregar.
 */
export type CandidateWeights = Readonly<Partial<Record<CandidateFeature, number>>>;

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
