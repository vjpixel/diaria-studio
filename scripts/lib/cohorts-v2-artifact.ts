/**
 * cohorts-v2-artifact.ts (#4451 achado 6 do fleet review em #4479)
 *
 * PROBLEMA: `clarice-engagement-cohorts-v2.ts --out arquivo.json` só
 * serializava `result.cohorts` (o `EngagementCohorts` puro) — descartando
 * `adminOptOutsAvailable`/`adminOptOutsApplied`/`campaignsFailed`, que só
 * existiam em stderr efêmero (`console.error`, nunca persistido). Uma rodada
 * de v2 que gerasse `/tmp/v2.json` com o store administrativo indisponível
 * (ex: contenção com a sync das 08:30 BRT) ficava indistinguível, campo a
 * campo, de uma rodada completa — `compare-cohorts.ts` não tinha como saber
 * e podia "bater" ou "divergir" contra o v1 pela razão errada.
 *
 * FIX: `--out` agora grava um `CohortsV2Artifact` (cohorts + diagnostics) em
 * vez do `EngagementCohorts` cru, e `compare-cohorts.ts` recusa comparar (a
 * não ser que `--allow-degraded` seja passado explicitamente) quando o lado
 * v2 tem `adminOptOutsAvailable=false`.
 *
 * Extraído pra módulo PURO e SEM side-effect de import (deliberado):
 * `clarice-engagement-cohorts-v2.ts` roda `loadProjectEnv()` no module load e
 * importa `papaparse`/`brevo-client.ts` — `compare-cohorts.ts` não deve herdar
 * nenhum desses só pra ler um tipo/função pura. Mesmo padrão de
 * dependency-free já usado por `dashboard-kv-types.ts` (ver seu docstring).
 */

import type { EngagementCohorts } from "./dashboard-kv-types.ts";

/** Diagnóstico de UMA rodada de `clarice-engagement-cohorts-v2.ts` — o que hoje só existia em stderr. */
export interface CohortsV2Diagnostics {
  campaignsTotal: number;
  campaignsFromCache: number;
  campaignsFetched: number;
  campaignsFailedCount: number;
  /** false = opt-outs administrativos (blacklist/unsub do store local) NÃO
   * foram aplicados nesta rodada — store indisponível (fail-soft) OU
   * desligado via `--no-admin-optouts`. Ver `adminOptOutsUnavailableReason`
   * pra distinguir os dois casos. */
  adminOptOutsAvailable: boolean;
  adminOptOutsApplied: number;
  /** só definido quando `adminOptOutsAvailable=false` por store indisponível
   * (nunca por `--no-admin-optouts`, que é opt-out explícito do operador). */
  adminOptOutsUnavailableReason?: string;
}

/** Shape gravado por `clarice-engagement-cohorts-v2.ts --out` (desde este fix, #4451). */
export interface CohortsV2Artifact {
  cohorts: EngagementCohorts;
  diagnostics: CohortsV2Diagnostics;
}

/**
 * Extrai `{cohorts, diagnostics}` de um JSON já parseado (`unknown` — vem de
 * `JSON.parse` num arquivo em disco, tipo não garantido). Aceita os DOIS
 * formatos possíveis dos arquivos consumidos por `compare-cohorts.ts --a/--b`:
 *
 *   - v1 (`clarice-engagement-cohorts.ts --dry-run`, redirecionado pra
 *     arquivo) ou v2 ANTIGO (`--out` de antes deste fix): `EngagementCohorts`
 *     cru, sem wrapper — `diagnostics` fica `undefined`.
 *   - v2 NOVO (`--out` deste fix em diante): `CohortsV2Artifact` — cohorts +
 *     diagnostics.
 *
 * Nunca lança em formato antigo/v1 — distinguir os dois é justamente o
 * propósito desta função (duck-typing na presença de `cohorts`+`diagnostics`
 * no nível raiz; `EngagementCohorts` nunca tem essas 2 chaves juntas).
 */
export function extractCohortsArtifact(
  raw: unknown,
): { cohorts: EngagementCohorts; diagnostics?: CohortsV2Diagnostics } {
  if (
    raw !== null &&
    typeof raw === "object" &&
    "cohorts" in raw &&
    "diagnostics" in raw
  ) {
    const obj = raw as CohortsV2Artifact;
    return { cohorts: obj.cohorts, diagnostics: obj.diagnostics };
  }
  return { cohorts: raw as EngagementCohorts, diagnostics: undefined };
}

/**
 * Mensagem de aviso quando o sinal administrativo está degradado — `null`
 * quando disponível OU quando `diagnostics` nem existe (arquivo v1/v2-antigo,
 * sem wrapper — nada a avaliar, não é um sinal degradado, é ausência de sinal
 * por formato antigo).
 */
export function describeDegradedSignal(diagnostics: CohortsV2Diagnostics | undefined): string | null {
  if (!diagnostics) return null;
  if (diagnostics.adminOptOutsAvailable) return null;
  return diagnostics.adminOptOutsUnavailableReason
    ? `opt-outs administrativos NÃO aplicados nesta rodada (${diagnostics.adminOptOutsUnavailableReason})`
    : `opt-outs administrativos NÃO aplicados nesta rodada (desligado via --no-admin-optouts)`;
}

export interface DegradedGateResult {
  /** true = comparação deve ser recusada (a não ser que o operador passe --allow-degraded). */
  blocked: boolean;
  /** 0-2 mensagens (uma por lado, a/b) — vazio quando nada degradado. */
  warnings: string[];
}

/**
 * Avalia se A e/ou B têm sinal degradado e decide se a comparação deve ser
 * BLOQUEADA. Pura — testável sem I/O. `allowDegraded=true` nunca bloqueia,
 * mas os warnings continuam sendo reportados (o operador pediu pra prosseguir
 * mesmo assim, não pediu pra silenciar o aviso).
 */
export function evaluateDegradedGate(
  a: { diagnostics?: CohortsV2Diagnostics },
  b: { diagnostics?: CohortsV2Diagnostics },
  allowDegraded: boolean,
): DegradedGateResult {
  const warnings = [a.diagnostics, b.diagnostics]
    .map((d) => describeDegradedSignal(d))
    .filter((w): w is string => w !== null);
  return { blocked: warnings.length > 0 && !allowDegraded, warnings };
}

/** Constrói o `CohortsV2Artifact` a partir do resultado de `buildCohortsV2` — pura, sem I/O. */
export function buildCohortsV2Artifact(result: {
  cohorts: EngagementCohorts;
  campaignsTotal: number;
  campaignsFromCache: number;
  campaignsFetched: number;
  campaignsFailed: unknown[];
  adminOptOutsApplied: number;
  adminOptOutsAvailable: boolean;
  adminOptOutsUnavailableReason?: string;
}): CohortsV2Artifact {
  return {
    cohorts: result.cohorts,
    diagnostics: {
      campaignsTotal: result.campaignsTotal,
      campaignsFromCache: result.campaignsFromCache,
      campaignsFetched: result.campaignsFetched,
      campaignsFailedCount: result.campaignsFailed.length,
      adminOptOutsAvailable: result.adminOptOutsAvailable,
      adminOptOutsApplied: result.adminOptOutsApplied,
      adminOptOutsUnavailableReason: result.adminOptOutsUnavailableReason,
    },
  };
}
