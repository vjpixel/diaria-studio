/**
 * Invariants de Stage 2 — Escrita (#1007 Fase 1).
 *
 * Checks rodados antes do gate humano de Stage 2 e antes de Stage 3 começar.
 * Delegam pros lints canônicos via `child_process` — assim qualquer regressão
 * em lint-newsletter-md.ts ou lint-social-md.ts é capturada como invariant.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { InvariantRule, InvariantViolation } from "./types.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function runLint(
  script: string,
  file: string,
  ruleId: string,
  sourceIssue: string,
): InvariantViolation[] {
  if (!existsSync(file)) {
    return [
      {
        rule: `${ruleId}-file-exists`,
        message: `${file} ausente — Stage 2 não completou`,
        source_issue: sourceIssue,
        severity: "error",
        file,
      },
    ];
  }
  const result = spawnSync(
    "npx",
    ["tsx", resolve(ROOT, "scripts", script), "--check", file],
    { encoding: "utf8", shell: process.platform === "win32" },
  );
  if (result.status === 0) return [];
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  return [
    {
      rule: ruleId,
      message: `${script} falhou (exit ${result.status}): ${(stderr || stdout).slice(0, 400)}`,
      source_issue: sourceIssue,
      severity: "error",
      file,
    },
  ];
}

/**
 * `02-reviewed.md` deve passar todos os lints da newsletter (titles per
 * destaque, "Por que isso importa" linha separada, ≤52 chars, etc).
 */
function checkReviewedPassesAllLints(editionDir: string): InvariantViolation[] {
  const file = resolve(editionDir, "02-reviewed.md");
  return runLint("lint-newsletter-md.ts", file, "reviewed-passes-all-lints", "#964");
}

/**
 * `03-social.md` deve passar lint social (LinkedIn schema, CTA rules,
 * Diar.ia ausente do main post — #595).
 */
function checkSocialPassesLints(editionDir: string): InvariantViolation[] {
  const file = resolve(editionDir, "03-social.md");
  return runLint("lint-social-md.ts", file, "social-passes-lints", "#595");
}

/**
 * Sanity check: editorial-rules requer "Por que isso importa:" em linha
 * separada. Lint cobre, mas guard barato pra detectar early.
 */
function checkPorQueIssoImportaSeparate(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");
  const lines = md.split("\n");
  const violations: InvariantViolation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(.+?)Por que isso importa:/);
    if (m && m[1].trim().length > 0) {
      violations.push({
        rule: "por-que-isso-importa-separate-line",
        message: `"Por que isso importa:" deve estar em linha separada (linha ${i + 1})`,
        source_issue: "#editorial-rules",
        severity: "error",
        file: path,
        line: i + 1,
      });
    }
  }
  return violations;
}

export const STAGE_2_RULES: InvariantRule[] = [
  {
    id: "reviewed-passes-all-lints",
    description: "02-reviewed.md passa lint-newsletter-md (#964)",
    source_issue: "#964",
    stage: 2,
    run: checkReviewedPassesAllLints,
  },
  {
    id: "social-passes-lints",
    description: "03-social.md passa lint-social-md (#595)",
    source_issue: "#595",
    stage: 2,
    run: checkSocialPassesLints,
  },
  {
    id: "por-que-isso-importa-separate-line",
    description: "'Por que isso importa:' em linha separada (editorial-rules)",
    source_issue: "#editorial-rules",
    stage: 2,
    run: checkPorQueIssoImportaSeparate,
  },
];

export {
  checkReviewedPassesAllLints,
  checkSocialPassesLints,
  checkPorQueIssoImportaSeparate,
};
