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
import { assertHumanized } from "../assert-humanized.ts";

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
 * destaque-min-chars, destaque-max-chars, intro-count, coverage-line-format (#1207), eai-section).
 *
 * Cada check é invocado individualmente pra produzir mensagens específicas.
 * Não chamamos o modo "default" (que exige `--approved` JSON) porque o
 * approved.json já foi consumido upstream.
 *
 * Nota (#2372): `use-melhor-tempo` NÃO entra aqui — `check-invariants --stage 2`
 * roda PRÉ-gate, e `stitch-newsletter.ts` renderiza a descrição do USE MELHOR a
 * partir do `summary` (sem injetar `(N min)`). O editor adiciona o tempo no gate.
 * O check é blocking no CLI (exit 1) e roda no Stage 4 (pós-gate), onde a
 * descrição já tem o tempo. Wirar aqui quebraria toda edição do fluxo default.
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
    { name: "coverage-line-format", issue: "#1207" },
    { name: "multiline-links", issue: "#1213" },
    { name: "eai-section", issue: "#481" },
    { name: "relative-time", issue: "#editorial-rules" },
    { name: "erro-intencional-placeholder", issue: "#2078" },
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
 * `03-social.md` deve passar lint social. Roda checks granulares:
 * `linkedin-schema` (#595), `relative-time` (qualidade editorial),
 * `post_pixel-matches-d1` (#1861), `personal-post-no-newsletter-deixis` (#2148),
 * `no-email-cta-linkedin` (#2458), `linkedin-page-link` (#2458),
 * e `humanizer-section-coverage` (#2148, quando snapshot pré-humanizador existe).
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
  // #1861: post_pixel (post pessoal do Pixel) deve ser sobre o D1 atual — pega
  // stale após reorder dos destaques pós-geração do social.
  violations.push(
    ...runCheck(
      "lint-social-md.ts",
      ["--check", "post_pixel-matches-d1", "--md", file],
      "social-post-pixel-matches-d1",
      "#1861",
      file,
    ),
  );
  // #2148: post_pixel e comment_pixel não devem usar deixis pessoal referindo-se
  // à newsletter/boletim como "esta newsletter" / "nossa newsletter" etc.
  // (framing inválido em post pessoal de perfil — o leitor não sabe qual newsletter).
  violations.push(
    ...runCheck(
      "lint-social-md.ts",
      ["--check", "personal-post-no-newsletter-deixis", "--md", file],
      "social-personal-post-no-newsletter-deixis",
      "#2148",
      file,
    ),
  );
  // #2458: posts do LinkedIn não devem conter CTA de assinatura por e-mail —
  // substituído por CTA de seguir a página da Diar.ia.
  violations.push(
    ...runCheck(
      "lint-social-md.ts",
      ["--check", "no-email-cta-linkedin", "--md", file],
      "social-no-email-cta-linkedin",
      "#2458",
      file,
    ),
  );
  // #2458: comment_diaria e post_pixel devem conter link da página da Diar.ia
  // no LinkedIn (linkedin.com/company/diaria) como CTA de follow.
  violations.push(
    ...runCheck(
      "lint-social-md.ts",
      ["--check", "linkedin-page-link", "--md", file],
      "social-linkedin-page-link",
      "#2458",
      file,
    ),
  );
  // #2148: humanizador deve ter coberto todas as seções de 03-social.md (main,
  // comment_pixel, post_pixel). Snapshot pré-humanizador pode não existir em
  // edições antigas ou quando o humanizador foi pulado — nesse caso o guard
  // humanizer-ran (checkHumanizerRan) já captura. Aqui: só roda se o snapshot existe.
  const preSnapshot = resolve(editionDir, "_internal", "03-social-pre-humanizador.md");
  if (existsSync(preSnapshot)) {
    violations.push(
      ...runCheck(
        "lint-social-md.ts",
        ["--check", "humanizer-section-coverage", "--pre", preSnapshot, "--md", file],
        "social-humanizer-section-coverage",
        "#2148",
        file,
      ),
    );
  }
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

/**
 * #1385: assert humanizador rodou em 02-reviewed.md + 03-social.md.
 * Critério mecânico: snapshot pre-humanizer (_internal/02-humanized.md +
 * _internal/03-social-pre-humanizador.md) presente com mtime >= final
 * (com tolerance 1h pra edições leves manuais).
 *
 * Caso real 260519: editor pulou humanizer no social por timeout Clarice.
 * Sem este gate, padrões IA no copy ficam invisíveis ao orchestrator.
 */
function checkHumanizerRan(editionDir: string): InvariantViolation[] {
  const result = assertHumanized(editionDir);
  if (result.ok) return [];
  return result.missing.map((m) => ({
    rule: "humanizer-ran",
    message:
      `${m.final}: snapshot ${m.snapshot} ${m.reason === "snapshot_missing" ? "ausente" : "stale (mtime < final)"} — ` +
      `humanizer foi pulado. Rodar Skill("humanizador", "Leia ${m.final}, humanize..., salve em ${m.final}.") ` +
      `e re-commitar snapshot.`,
    source_issue: "#1385",
    severity: "error" as const,
    file: m.final,
  }));
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
    description: "03-social.md passa linkedin-schema + relative-time + post_pixel-matches-d1 + personal-post-no-newsletter-deixis + humanizer-section-coverage (#595, #1861, #2148)",
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
  {
    id: "humanizer-ran",
    description: "humanizer rodou em 02-reviewed.md + 03-social.md (#1385)",
    source_issue: "#1385",
    stage: 2,
    run: checkHumanizerRan,
  },
];

export {
  checkReviewedPassesAllLints,
  checkSocialPassesLints,
  checkPorQueIssoImportaSeparate,
  checkHumanizerRan,
};
