/**
 * scripts/lib/track-a-features.ts (#7980, Fase 6 da #7972 — Camada 2 estendida ao Track A)
 *
 * Allowlist canônica de features calibráveis do TRACK A (seleção de
 * destaque) — deliberadamente MAIS ESTREITA que `CANDIDATE_FEATURES`
 * (Track B, `scripts/calibration-power-report.ts`), porque o escopo da
 * #7980 é mais estreito: só os bônus determinísticos que decidem quem
 * chega perto da lista de finalistas (`coverage-bonus.ts` via
 * `cluster_sources_count`, e os bônus booleanos `hands_on`/`primary_source`
 * já existentes no rubrico do scorer) — nunca o julgamento holístico de
 * `scorer-select.md`, nunca os backstops determinísticos
 * (`ensureNegativeImpactHighlight`, exclusão categórica de bucket
 * `use_melhor`, contagem travada em 2-3), que permanecem hard-coded fora
 * de escopo de calibração PARA SEMPRE (#7972 §"O que NUNCA muda" do
 * Track A).
 *
 * Quatro exclusões explícitas em relação ao texto literal da issue #7980
 * ("coverage-bonus, audience-affinity, hands_on/academy/howto_br/
 * primary_source"), resolvidas a favor da versão mais cuidadosa do
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
 * 3. **`academy`, `howto_br` e `howto_br_source` ficam de fora — removidas
 *    em #8254 pelo MESMO motivo estrutural do item 1, achado ao vivo em
 *    17/09/2026 (607 eventos avaliáveis, `n_true=0` pras 3, 0 edições
 *    avaliáveis).** As três, assim como `audience_affinity`, só são
 *    calculadas dentro de `annotateAudienceAffinity`
 *    (`scripts/lib/audience-affinity.ts`), que só roda via
 *    `annotateUseMelhorBucket` — restrito ao bucket `use_melhor`. Como
 *    destaques NUNCA vêm desse bucket (mesma exclusão categórica do item
 *    1), `bonuses_applied` de uma linha `highlights`/`runners_up` nunca
 *    pode conter `"academy:+N"`/`"howto_br:+N"`/`"howto_br_source:+N"` —
 *    não é falta de dado acumulando, é impossibilidade estrutural: o
 *    critério de saída do Track A (piso de evento + 2 janelas de
 *    validação) é inatingível pra sempre pra essas 3, exatamente como já
 *    era documentado pra `audience_affinity` acima. As três continuam
 *    reais e calibráveis no **Track B** (`CANDIDATE_FEATURES` de
 *    `scripts/calibration-power-report.ts`), onde a população cobre TODO
 *    o pool de `01-approved.json`, incluindo `use_melhor` — só não fazem
 *    sentido aqui. `hands_on` e `primary_source` sobrevivem porque são
 *    computadas por anotadores explicitamente bucket-agnósticos
 *    (`annotateHandsOnAllBuckets` #4843, `annotatePrimarySourceAllBuckets`
 *    #5665) — única diferença estrutural real entre os 5 bônus booleanos
 *    do rubrico.
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

/**
 * Prefixo que distingue o nome de feature de um relatório de calibração do
 * TRACK A do mesmo nome vindo do Track B (#7980, achado de review — P1,
 * alta confiança). `generate-calibration-evidence-report.ts` grava o
 * título como `"Calibração {feature} — PR #{n}"` pros DOIS tracks, sem
 * nenhum campo de track no registro (`data/reports/index.jsonl`) — e
 * `TRACK_A_CANDIDATE_FEATURES` compartilha os nomes `primary_source`/
 * `hands_on` com `CANDIDATE_FEATURES` de Track B. Sem um prefixo, uma PR de Track B
 * mergeada pra `primary_source` bloquearia `primary_source` do Track A
 * PARA SEMPRE em `trigger-track-a-calibration.ts` (e vice-versa) — os dois
 * tracks têm barra de evidência, diretório de pesos e escopo de feature
 * genuinamente distintos, então "já coberto" nunca deveria vazar entre
 * eles. Quem monta o `CalibrationEvidenceInput.feature` de um candidato
 * REAL de Track A (ainda não wireado neste repo — ver docstring de
 * `trigger-track-a-calibration.ts`) DEVE usar `trackAReportFeatureLabel`,
 * nunca o nome puro da feature.
 */
export const TRACK_A_REPORT_FEATURE_PREFIX = "track-a:";

/** `"track-a:{feature}"` — nome a passar em `CalibrationEvidenceInput.feature` (nunca o nome puro) sempre que uma sessão futura gerar o relatório de evidência de uma calibração REAL de Track A. Ver docstring de `TRACK_A_REPORT_FEATURE_PREFIX`. */
export function trackAReportFeatureLabel(feature: TrackACandidateFeature): string {
  return `${TRACK_A_REPORT_FEATURE_PREFIX}${feature}`;
}
