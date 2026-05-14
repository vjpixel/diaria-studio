/**
 * Invariants de Stage 1 — Pesquisa (#1007 Fase 1).
 *
 * Checks rodados em 2 momentos distintos do Stage 1:
 *
 * 1. **Pré-gate** (ainda só `01-categorized.md` existe): apenas
 *    `categorized-has-eia-section` faz sentido aqui.
 *
 * 2. **Pós-gate apply** (após `apply-gate-edits.ts` escrever
 *    `_internal/01-approved.json`): `approved-has-3-highlights` +
 *    `coverage-line-present`.
 *
 * O orchestrator chama `--stage 1` no momento (2). Pré-gate é coberto
 * por `--stage 1 --rule categorized-has-eia-section` se quiser ser
 * explícito, ou simplesmente os checks pós-gate apply assumem que a
 * gate UI mostrou erros pré-aprovação.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InvariantRule, InvariantViolation } from "./types.ts";

interface ApprovedJson {
  highlights?: unknown[];
  lancamento?: unknown[];
  pesquisa?: unknown[];
  noticias?: unknown[];
  coverage?: { line?: string };
}

/**
 * Stage 2 espera exatamente 3 highlights. Editor pode ter aprovado com 2 ou 4
 * (corrupção do gate UX). Falha cedo.
 */
function checkApprovedHas3Highlights(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "01-approved.json");
  if (!existsSync(path)) {
    return [
      {
        rule: "approved-exists",
        message: `_internal/01-approved.json ausente — gate Stage 1 não foi aprovado. Rode \`/diaria-1-pesquisa {AAMMDD}\` antes.`,
        source_issue: "#583",
        severity: "error",
        file: path,
      },
    ];
  }
  let data: ApprovedJson;
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as ApprovedJson;
  } catch (e) {
    return [
      {
        rule: "approved-parseable",
        message: `_internal/01-approved.json não parseável: ${(e as Error).message}`,
        source_issue: "#583",
        severity: "error",
        file: path,
      },
    ];
  }
  const highlights = Array.isArray(data.highlights) ? data.highlights : [];
  if (highlights.length !== 3) {
    return [
      {
        rule: "approved-has-3-highlights",
        message: `_internal/01-approved.json tem ${highlights.length} highlights — Stage 2 espera exatamente 3 (D1, D2, D3).`,
        source_issue: "#159",
        severity: "error",
        file: path,
      },
    ];
  }
  return [];
}

/**
 * `01-categorized.md` deve incluir seção "## É IA?" — Stage 2 writer lê esse
 * markdown pra extrair linha de crédito. Sem ela, writer omite É IA? do draft.
 */
function checkCategorizedHasEiaSection(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "01-categorized.md");
  if (!existsSync(path)) {
    return [
      {
        rule: "categorized-md-exists",
        message: `01-categorized.md ausente`,
        source_issue: "#481",
        severity: "error",
        file: path,
      },
    ];
  }
  const md = readFileSync(path, "utf8");
  // #1260: aceitar header strict (`## É IA?`) ou placeholder com sufixo (`## É IA? ⏳ (...)`).
  // Placeholder é inserido por render-categorized-md.ts quando 01-eia.md não existe ainda.
  if (!/^## É IA\?(\s|$)/m.test(md)) {
    return [
      {
        rule: "categorized-has-eia-section",
        message:
          `01-categorized.md sem "## É IA?" — render-categorized-md.ts não inseriu o bloco. ` +
          `Stage 2 writer não vai conseguir extrair linha de crédito.`,
        source_issue: "#481",
        severity: "error",
        file: path,
      },
    ];
  }
  return [];
}

/**
 * Coverage line ("Para esta edição...") deve estar presente em `01-approved.json`.
 * Writer Stage 2 usa essa string como primeira linha do draft.
 */
function checkCoverageLinePresent(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "01-approved.json");
  if (!existsSync(path)) return []; // covered by approved-has-3-highlights
  let data: ApprovedJson;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!data.coverage?.line || data.coverage.line.trim().length === 0) {
    return [
      {
        rule: "coverage-line-present",
        message:
          `_internal/01-approved.json sem coverage.line — writer vai usar fallback "???". ` +
          `Verificar se apply-gate-edits.ts rodou após o gate humano.`,
        source_issue: "#592",
        severity: "warning",
        file: path,
      },
    ];
  }
  return [];
}

export const STAGE_1_RULES: InvariantRule[] = [
  {
    id: "approved-has-3-highlights",
    description: "01-approved.json tem 3 highlights (#159)",
    source_issue: "#159",
    stage: 1,
    run: checkApprovedHas3Highlights,
  },
  {
    id: "categorized-has-eia-section",
    description: "01-categorized.md inclui seção '## É IA?' (#481)",
    source_issue: "#481",
    stage: 1,
    run: checkCategorizedHasEiaSection,
  },
  {
    id: "coverage-line-present",
    description: "01-approved.json tem coverage.line (#592)",
    source_issue: "#592",
    stage: 1,
    run: checkCoverageLinePresent,
  },
];

export {
  checkApprovedHas3Highlights,
  checkCategorizedHasEiaSection,
  checkCoverageLinePresent,
};
