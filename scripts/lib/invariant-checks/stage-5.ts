/**
 * Invariants pós-publicação — Stage 5 (#1007 Fase 1).
 *
 * Rodam após Stage 4 dispatch completo (newsletter + LinkedIn + Facebook),
 * antes do auto-reporter. Detectam falhas silenciosas que aparecem só após
 * publicar — ex: sentinel não escrito, refresh-dedup auto-stamp não rodou.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InvariantRule, InvariantViolation } from "./types.ts";

interface PublishedJson {
  refresh_dedup_stamped_at?: string;
  edition_url?: string;
  status?: string;
}

/**
 * `_internal/.step-4-done.json` deve existir após Stage 4 completo. Sem isso,
 * resume-aware do orchestrator (Stage 0b) não detecta que Stage 4 rodou e
 * pode tentar re-disparar publish-* no próximo run.
 */
function checkStep4Sentinel(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", ".step-4-done.json");
  if (!existsSync(path)) {
    return [
      {
        rule: "step-4-sentinel-exists",
        message:
          `_internal/.step-4-done.json ausente — pipeline-sentinel.ts não foi chamado. ` +
          `Resume-aware no próximo run pode re-publicar.`,
        source_issue: "#780",
        severity: "error",
        file: path,
      },
    ];
  }
  return [];
}

/**
 * `05-published.json` deve ter `refresh_dedup_stamped_at` setado (#978).
 * Sem isso, próxima edição pode repetir URLs publicadas hoje porque o dedup
 * não foi atualizado.
 */
function checkRefreshDedupStamped(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "05-published.json");
  if (!existsSync(path)) {
    return [
      {
        rule: "published-json-exists",
        message: `_internal/05-published.json ausente — Stage 4 newsletter não completou`,
        source_issue: "#978",
        severity: "error",
        file: path,
      },
    ];
  }
  let data: PublishedJson;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return [
      {
        rule: "published-json-parseable",
        message: `_internal/05-published.json não parseável: ${(e as Error).message}`,
        source_issue: "#978",
        severity: "error",
        file: path,
      },
    ];
  }
  if (!data.refresh_dedup_stamped_at) {
    return [
      {
        rule: "refresh-dedup-stamped",
        message:
          `_internal/05-published.json sem refresh_dedup_stamped_at — auto-stamp do refresh-dedup não rodou. ` +
          `Próxima edição pode repetir URLs já publicadas hoje.`,
        source_issue: "#978",
        severity: "error",
        file: path,
      },
    ];
  }
  return [];
}

export const STAGE_5_RULES: InvariantRule[] = [
  {
    id: "step-4-sentinel-exists",
    description: "_internal/.step-4-done.json escrito (#780)",
    source_issue: "#780",
    stage: 5,
    run: checkStep4Sentinel,
  },
  {
    id: "refresh-dedup-stamped",
    description: "05-published.json tem refresh_dedup_stamped_at (#978)",
    source_issue: "#978",
    stage: 5,
    run: checkRefreshDedupStamped,
  },
];

export { checkStep4Sentinel, checkRefreshDedupStamped };
