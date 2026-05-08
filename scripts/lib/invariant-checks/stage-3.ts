/**
 * Invariants de Stage 3 — Imagens (#1007 Fase 1).
 *
 * Verifica que as 4 imagens existem (eia A, d1 2x1, d1 1x1, d2 1x1, d3 1x1) e
 * que prompts não violam regras editoriais (sem pixels explícitos, sem
 * Noite Estrelada).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { InvariantRule, InvariantViolation } from "./types.ts";

const REQUIRED_IMAGES = [
  "01-eia-A.jpg",
  "01-eia-B.jpg",
  "04-d1-2x1.jpg",
  "04-d1-1x1.jpg",
  "04-d2-1x1.jpg",
  "04-d3-1x1.jpg",
];

const PROMPT_FILES = [
  "04-d1-sd-prompt.json",
  "04-d2-sd-prompt.json",
  "04-d3-sd-prompt.json",
];

/**
 * Stage 4 (publicação) precisa de todas as 6 imagens. Sem elas, Beehiiv +
 * social falham — pegar antes do dispatch.
 */
function checkAllImagesExist(editionDir: string): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  for (const name of REQUIRED_IMAGES) {
    const path = resolve(editionDir, name);
    if (!existsSync(path)) {
      violations.push({
        rule: "all-images-exist",
        message: `Imagem ausente: ${name}`,
        source_issue: "#stage-3",
        severity: "error",
        file: path,
      });
      continue;
    }
    const size = statSync(path).size;
    if (size < 1024) {
      violations.push({
        rule: "all-images-non-empty",
        message: `Imagem ${name} muito pequena (${size} bytes) — provavelmente corrompida`,
        source_issue: "#stage-3",
        severity: "error",
        file: path,
      });
    }
  }
  return violations;
}

/**
 * Prompts não devem mencionar resolução em pixels (ex: "1024x1024", "2048px")
 * nem "Noite Estrelada" — duas regras editoriais explícitas em CLAUDE.md.
 */
function checkPromptsClean(editionDir: string): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  for (const name of PROMPT_FILES) {
    const path = resolve(editionDir, name);
    if (!existsSync(path)) continue; // covered by all-images-exist via missing image
    let prompt: string;
    try {
      const json = JSON.parse(readFileSync(path, "utf8")) as { prompt?: string };
      prompt = json.prompt ?? "";
    } catch (e) {
      violations.push({
        rule: "prompts-parseable",
        message: `${name} JSON inválido: ${(e as Error).message}`,
        source_issue: "#stage-3",
        severity: "error",
        file: path,
      });
      continue;
    }
    // Pixels: detect "NNNNxNNNN" or "NNNN px" patterns
    if (/\b\d{3,4}\s*x\s*\d{3,4}\b/i.test(prompt) || /\b\d{3,4}\s*px\b/i.test(prompt)) {
      violations.push({
        rule: "prompts-no-pixels",
        message: `Prompt em ${name} contém resolução em pixels (proibido por editorial-rules)`,
        source_issue: "#editorial-rules",
        severity: "error",
        file: path,
      });
    }
    if (/noite\s*estrelada|starry\s*night/i.test(prompt)) {
      violations.push({
        rule: "prompts-no-noite-estrelada",
        message: `Prompt em ${name} menciona Noite Estrelada (proibido por editorial-rules)`,
        source_issue: "#editorial-rules",
        severity: "error",
        file: path,
      });
    }
  }
  return violations;
}

/**
 * `01-eia.md` deve ter frontmatter:
 * ```yaml
 * eia_answer:
 *   A: real|ia
 *   B: real|ia
 * ```
 * (gerado por scripts/eia-compose.ts:171-176). Sem isso, Stage 4 não sabe
 * qual imagem é a verdadeira — quebra a Foto do Dia.
 */
function checkEiaAnswerResolved(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "01-eia.md");
  if (!existsSync(path)) {
    return [
      {
        rule: "eia-md-exists",
        message: `01-eia.md ausente`,
        source_issue: "#stage-3",
        severity: "error",
        file: path,
      },
    ];
  }
  const md = readFileSync(path, "utf8");
  const fmMatch = md.match(/^---\s*\n([\s\S]*?)\n---/m);
  const fm = fmMatch?.[1] ?? "";
  const aMatch = fm.match(/^\s+A:\s*(real|ia)\s*$/m);
  const bMatch = fm.match(/^\s+B:\s*(real|ia)\s*$/m);
  if (!aMatch || !bMatch) {
    return [
      {
        rule: "eia-answer-resolved",
        message:
          `01-eia.md sem frontmatter completo "eia_answer: { A: real|ia, B: real|ia }" — ` +
          `eia-composer não resolveu o sorteio. Stage 4 não sabe qual imagem promover.`,
        source_issue: "#192",
        severity: "error",
        file: path,
      },
    ];
  }
  if (aMatch[1] === bMatch[1]) {
    return [
      {
        rule: "eia-answer-pair-distinct",
        message:
          `01-eia.md tem A=${aMatch[1]} e B=${bMatch[1]} — par precisa ser real+ia, não duplicado.`,
        source_issue: "#192",
        severity: "error",
        file: path,
      },
    ];
  }
  return [];
}

export const STAGE_3_RULES: InvariantRule[] = [
  {
    id: "all-images-exist",
    description: "6 imagens (eia A/B + d1 2x1/1x1 + d2/d3 1x1) presentes",
    source_issue: "#stage-3",
    stage: 3,
    run: checkAllImagesExist,
  },
  {
    id: "prompts-clean",
    description: "Prompts não mencionam pixels nem Noite Estrelada",
    source_issue: "#editorial-rules",
    stage: 3,
    run: checkPromptsClean,
  },
  {
    id: "eia-answer-resolved",
    description: "01-eia.md tem eia_answer A|B resolvido (#192)",
    source_issue: "#192",
    stage: 3,
    run: checkEiaAnswerResolved,
  },
];

export {
  checkAllImagesExist,
  checkPromptsClean,
  checkEiaAnswerResolved,
  REQUIRED_IMAGES,
  PROMPT_FILES,
};
