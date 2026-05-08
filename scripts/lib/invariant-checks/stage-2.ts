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

function runCheck(
  script: string,
  args: string[],
  ruleId: string,
  sourceIssue: string,
  file: string,
): InvariantViolation[] {
  if (!existsSync(file)) {
    return [
      {
        rule: `${ruleId}-file-exists`,
        message: `${file} ausente`,
        source_issue: sourceIssue,
        severity: "error",
        file,
      },
    ];
  }
  // Chama tsx via `node --import tsx` direto (não `npx tsx` com shell:true)
  // — evita mangling de args quando edition-dir tem espaços (#1010).
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", resolve(ROOT, "scripts", script), ...args],
    { encoding: "utf8" },
  );
  if (result.status === 0) return [];
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  return [
    {
      rule: ruleId,
      message: `${script} ${args.join(" ")} falhou (exit ${result.status}): ${(stderr || stdout).slice(0, 400)}`,
      source_issue: sourceIssue,
      severity: "error",
      file,
    },
  ];
}

/**
 * `02-reviewed.md` deve passar todos os checks granulares de
 * lint-newsletter-md (titles-per-highlight, why-matters-format,
 * destaque-min-chars, destaque-max-chars, intro-count, eai-section).
 *
 * Cada check é invocado individualmente pra produzir mensagens específicas.
 * Não chamamos o modo "default" (que exige `--approved` JSON) porque o
 * approved.json já foi consumido upstream.
 */
function checkReviewedPassesAllLints(editionDir: string): InvariantViolation[] {
  const file = resolve(editionDir, "02-reviewed.md");
  const checks: Array<{ name: string; issue: string; extraArgs?: string[] }> = [
    { name: "titles-per-highlight", issue: "#159" },
    { name: "title-length", issue: "#editorial-rules" },
    { name: "why-matters-format", issue: "#editorial-rules" },
    { name: "destaque-min-chars", issue: "#914" },
    { name: "destaque-max-chars", issue: "#964" },
    { name: "intro-count", issue: "#743" },
    { name: "eai-section", issue: "#481" },
    { name: "relative-time", issue: "#editorial-rules" },
  ];
  const violations: InvariantViolation[] = [];
  for (const check of checks) {
    violations.push(
      ...runCheck(
        "lint-newsletter-md.ts",
        ["--check", check.name, "--md", file, ...(check.extraArgs ?? [])],
        `reviewed-${check.name}`,
        check.issue,
        file,
      ),
    );
  }
  return violations;
}

/**
 * `03-social.md` deve passar lint social. Roda 2 checks granulares:
 * `linkedin-schema` (#595) e `relative-time` (qualidade editorial).
 */
function checkSocialPassesLints(editionDir: string): InvariantViolation[] {
  const file = resolve(editionDir, "03-social.md");
  const violations: InvariantViolation[] = [];
  violations.push(
    ...runCheck(
      "lint-social-md.ts",
      ["--check", "linkedin-schema", "--md", file],
      "social-linkedin-schema",
      "#595",
      file,
    ),
  );
  violations.push(
    ...runCheck(
      "lint-social-md.ts",
      ["--check", "relative-time", "--md", file],
      "social-relative-time",
      "#editorial-rules",
      file,
    ),
  );
  return violations;
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
    description: "02-reviewed.md passa lint-newsletter-md granulares (#964)",
    source_issue: "#964",
    stage: 2,
    run: checkReviewedPassesAllLints,
  },
  {
    id: "social-passes-lints",
    description: "03-social.md passa linkedin-schema + relative-time (#595)",
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
