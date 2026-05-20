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

/**
 * #1410: enforcement do loop verify→fix do Stage 4 §4f.
 *
 * Se `05-published.json.review_status === "issues_unfixable"`, então o
 * orchestrator declarou que o test email tem issues e foi tentado fix-mode
 * pelo menos 1×. Pra essa declaração ser válida:
 *   - `review_attempts >= 2` (1 review + ao menos 1 fix-mode dispatch)
 *
 * Sem esse guard, orchestrator pode pular fix-mode silenciosamente quando
 * agent retorna issues que ele acha falso-positivo. Caso 260520: review_status
 * marcado `issues_unfixable` com `review_attempts: 1` — fix-mode nunca rodou,
 * issues foram só descartadas por julgamento.
 *
 * Em 260520, após #1421 (filter de falso-positivos no orchestrator), issues
 * legítimas chegam até fix-mode automaticamente. Esse guard serve de safety
 * net pra caso filter falhe ou novo tipo de issue apareça.
 */
function checkStage4ReviewLoop(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "05-published.json");
  if (!existsSync(path)) {
    // Outro check (#272/#780) já reporta ausência do file — não dup.
    return [];
  }
  let data: {
    review_status?: string;
    review_attempts?: number;
  };
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    // 05-published.json corrupted é raro mas precisa ser reportado — nenhum
    // outro rule lê esse arquivo (checkSocialPublishedComplete lê
    // 06-social-published.json, file diferente).
    return [
      {
        rule: "stage-4-review-loop-parseable",
        message: `05-published.json não parseável: ${(e as Error).message}`,
        source_issue: "#1410",
        severity: "error",
        file: path,
      },
    ];
  }
  if (data.review_status !== "issues_unfixable") return [];

  const attempts = typeof data.review_attempts === "number" ? data.review_attempts : 0;
  if (attempts < 2) {
    return [
      {
        rule: "stage-4-review-loop-enforced",
        message:
          `05-published.json marca review_status="issues_unfixable" mas review_attempts=${attempts} ` +
          `(esperado >= 2 — 1 review + ao menos 1 fix-mode dispatch). ` +
          `Orchestrator pulou o loop verify→fix silenciosamente. ` +
          `Re-rode publish-newsletter em modo fix antes de declarar unfixable.`,
        source_issue: "#1410",
        severity: "error",
        file: path,
      },
    ];
  }
  return [];
}

/**
 * #1367: `_internal/.close-poll-done.json` deve existir após Stage 4 §4h.
 * Marker é escrito por close-poll.ts apenas se: (a) /admin/correct retornou
 * ok, (b) sanity check /stats confirmou correct_answer registrado.
 *
 * Sem esse marker, a próxima edição não consegue mostrar "Resultado da última
 * edição: X% acertaram" porque worker retorna correct_pct=null.
 *
 * Caso real 260518: close-poll falhou silently (Node fetch broken), pipeline
 * marcou Stage 4 done, 260519 renderizou sem a linha de stats.
 */
function checkClosePollMarker(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", ".close-poll-done.json");
  if (!existsSync(path)) {
    return [
      {
        rule: "close-poll-marker-exists",
        message:
          `_internal/.close-poll-done.json ausente — close-poll.ts não rodou ou falhou. ` +
          `Próxima edição não vai conseguir exibir % de acertos. ` +
          `Rode manualmente: \`npx tsx scripts/close-poll.ts --edition {AAMMDD}\`.`,
        source_issue: "#1367",
        severity: "error",
        file: path,
      },
    ];
  }
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as {
      answer?: string;
      sanity_check?: { correct_answer?: string };
    };
    if (!data.answer || !data.sanity_check?.correct_answer) {
      return [
        {
          rule: "close-poll-marker-valid",
          message: `close-poll marker existe mas sem answer/sanity_check válidos: ${JSON.stringify(data)}`,
          source_issue: "#1367",
          severity: "error",
          file: path,
        },
      ];
    }
    if (data.answer !== data.sanity_check.correct_answer) {
      return [
        {
          rule: "close-poll-marker-consistency",
          message:
            `close-poll marker answer="${data.answer}" diverge do sanity check correct_answer=` +
            `"${data.sanity_check.correct_answer}". Worker pode estar com state errado.`,
          source_issue: "#1367",
          severity: "error",
          file: path,
        },
      ];
    }
  } catch (e) {
    return [
      {
        rule: "close-poll-marker-parseable",
        message: `close-poll marker não parseável: ${(e as Error).message}`,
        source_issue: "#1367",
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
    id: "social-published-complete",
    description: "06-social-published.json não-vazio, sem failed (#272)",
    source_issue: "#272",
    stage: 5,
    run: checkSocialPublishedComplete,
  },
  {
    id: "stage-4-review-loop-enforced",
    description:
      "review_status=issues_unfixable exige review_attempts>=2 (#1410)",
    source_issue: "#1410",
    stage: 5,
    run: checkStage4ReviewLoop,
  },
  {
    id: "close-poll-marker-exists",
    description: "_internal/.close-poll-done.json escrito (#1367)",
    source_issue: "#1367",
    stage: 5,
    run: checkClosePollMarker,
  },
];

export {
  checkStep4Sentinel,
  checkSocialPublishedComplete,
  checkStage4ReviewLoop,
  checkClosePollMarker,
};
