/**
 * Invariants pós-publicação — Stage 5 (#1007 Fase 1).
 *
 * Rodam após Stage 4 dispatch completo (newsletter + LinkedIn + Facebook),
 * antes do auto-reporter. Detectam falhas silenciosas que aparecem só após
 * publicar — ex: sentinel não escrito, social-published incompleto.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InvariantRule, InvariantViolation } from "./types.ts";

interface SocialPublishedJson {
  posts?: Array<{ platform?: string; status?: string }>;
}

/**
 * `_internal/.step-4-done.json` deve existir após Stage 4 completo. Sem isso,
 * resume-aware do orchestrator (Stage 0b) não detecta que Stage 4 rodou e
 * pode tentar re-disparar publish-* no próximo run.
 *
 * Valida o sentinel escrito por scripts/pipeline-sentinel.ts (#780).
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
 * `_internal/06-social-published.json` deve ter `posts[]` com pelo menos 1
 * entry (idealmente 6 = 3 LinkedIn + 3 Facebook), nenhuma com `status:
 * "failed"`. Sinal de que dispatch social rodou e publish-{linkedin,facebook}
 * completaram.
 */
function checkSocialPublishedComplete(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "06-social-published.json");
  if (!existsSync(path)) {
    return [
      {
        rule: "social-published-exists",
        message:
          `_internal/06-social-published.json ausente — publish-linkedin/facebook não rodaram ` +
          `ou falharam antes de gravar. Stage 4 incompleto.`,
        source_issue: "#272",
        severity: "error",
        file: path,
      },
    ];
  }
  let data: SocialPublishedJson;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return [
      {
        rule: "social-published-parseable",
        message: `06-social-published.json não parseável: ${(e as Error).message}`,
        source_issue: "#272",
        severity: "error",
        file: path,
      },
    ];
  }
  const posts = Array.isArray(data.posts) ? data.posts : [];
  const violations: InvariantViolation[] = [];
  if (posts.length === 0) {
    violations.push({
      rule: "social-published-non-empty",
      message: `06-social-published.json com posts[] vazio — nenhum dispatch teve sucesso`,
      source_issue: "#272",
      severity: "error",
      file: path,
    });
  }
  const failed = posts.filter((p) => p.status === "failed");
  if (failed.length > 0) {
    violations.push({
      rule: "social-published-no-failed",
      message: `06-social-published.json tem ${failed.length} post(s) com status=failed`,
      source_issue: "#272",
      severity: "warning",
      file: path,
    });
  }
  return violations;
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
    id: "social-published-complete",
    description: "06-social-published.json não-vazio, sem failed (#272)",
    source_issue: "#272",
    stage: 5,
    run: checkSocialPublishedComplete,
  },
];

export { checkStep4Sentinel, checkSocialPublishedComplete };
