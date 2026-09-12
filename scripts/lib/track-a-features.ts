/**
 * scripts/lib/track-a-features.ts (#7980, Fase 6 da #7972 — Camada 2 estendida ao Track A)
 *
 * Allowlist canônica de features calibráveis do TRACK A (seleção de
 * destaque) — deliberadamente MAIS ESTREITA que `CANDIDATE_FEATURES`
 * (Track B, `scripts/calibration-power-report.ts`), porque o escopo da
 * #7980 é mais estreito: só os bônus determinísticos que decidem quem
 * chega perto da lista de finalistas (`coverage-bonus.ts` via
 * `cluster_sources_count`, e os bônus booleanos `hands_on`/`academy`/
 * `howto_br`/`howto_br_source`/`primary_source` já existentes no rubrico
 * do scorer) — nunca o julgamento holístico de `scorer-select.md`, nunca
 * os backstops determinísticos (`ensureNegativeImpactHighlight`, exclusão
 * categórica de bucket `use_melhor`, contagem travada em 2-3), que
 * permanecem hard-coded fora de escopo de calibração PARA SEMPRE (#7972
 * §"O que NUNCA muda" do Track A).
 *
 * Duas exclusões explícitas em relação ao texto literal da issue #7980
 * ("coverage-bonus, audience-affinity, hands_on/academy/howto_br/
 * primary_source"), ambas resolvidas a favor da versão mais cuidadosa do
 * design em `#7972` (corpo da epic, não o resumo da sub-issue):
 *
 * 1. **`audience_affinity` fica de fora** — mitigação C-2 do design:
 *    "Destaques nunca vêm de Use Melhor (#3436) — exclusão categórica de
 *    bucket é intocável por calibração; `audience_affinity` (só aplicável
 *    a `use_melhor`) marcada estruturalmente inelegível para Track A."
 *    `audience_affinity.affinity` só é calculado pra candidatos do bucket
 *    `use_melhor` (`scripts/lib/audience-affinity.ts`/`scripts/lib/use-
 *    melhor-curation.ts`) — e destaques NUNCA vêm desse bucket. Calibrar
 *    um bônus que só se aplica a um bucket categoricamente excluído de
 *    virar destaque não teria efeito prático (o bônus nunca é observado
 *    entre os candidatos que efetivamente chegam perto de virar destaque)
 *    e arrisca o Goodhart oposto: aprender a "ligar" `audience_affinity`
 *    reclassificaria implicitamente o que conta como Track A, sem
 *    passar pelo gate mecânico de bucket em `extract-destaques.ts`.
 * 2. **`has_official_link` fica de fora** — não citado no texto da issue
 *    #7980 nem no escopo do Track A na epic (#7972 §"O que é calibrado" do
 *    Track A); é o bônus/condição do Track B ligado a #160 (LANÇAMENTOS só
 *    com link oficial — categorização de bucket, não seleção de
 *    destaque). Mantido fora daqui; segue calibrável só via Track B
 *    (`scripts/calibrate-scoring-weights.ts`).
 *
 * `coverage_bonus_present` é uma feature SINTÉTICA (não existe como campo
 * de `ScoringFeatureRow`) — deriva de `cluster_sources_count > 0`, que É
 * um campo real (`scripts/lib/scoring-features.ts`). `coverage-bonus.ts`
 * aplica `+5` por fonte extra num cluster same-story
 * (`COVERAGE_BONUS_PER_SOURCE`), então "o bônus de cobertura se aplicou"
 * é exatamente "há pelo menos 1 fonte extra no cluster" — `trackAFeatureValue`
 * abaixo é o único lugar que sabe resolver essa feature sintética; nenhum
 * outro código deve tentar ler `row.coverage_bonus_present` diretamente
 * (o campo não existe em `ScoringFeatureRow`).
 */

import type { ScoringFeatureRow } from "./scoring-features.ts";

export const TRACK_A_CANDIDATE_FEATURES = [
  "primary_source",
  "hands_on",
  "academy",
  "howto_br",
  "howto_br_source",
  "coverage_bonus_present",
] as const;

export type TrackACandidateFeature = (typeof TRACK_A_CANDIDATE_FEATURES)[number];

/** `true` se `feature` é um nome reconhecido de `TRACK_A_CANDIDATE_FEATURES` — guard de runtime pra input externo (ex: nome vindo de um JSON/CLI), já que `TrackACandidateFeature` só protege em compilação. */
export function isTrackACandidateFeature(feature: string): feature is TrackACandidateFeature {
  return (TRACK_A_CANDIDATE_FEATURES as readonly string[]).includes(feature);
}

/**
 * Resolve o valor booleano de uma feature candidata do Track A pra 1 linha
 * do feature store. `coverage_bonus_present` é a única feature sintética
 * (derivada de `cluster_sources_count`); as demais são campos booleanos
 * reais de `ScoringFeatureRow`, lidos diretamente (sem cast pra
 * `Record<string, unknown>`) — `TrackACandidateFeature` garante em
 * compilação que todo nome aqui, exceto o sintético, é uma chave real.
 */
export function trackAFeatureValue(row: ScoringFeatureRow, feature: TrackACandidateFeature): boolean {
  if (feature === "coverage_bonus_present") return row.cluster_sources_count > 0;
  return row[feature] === true;
}
