/**
 * lint-checks/eia-answer-check.ts (#1737 item 2 — extraído de lint-newsletter-md.ts)
 *
 * Check `--check eia-answer` (#744/#927): garante que, se `01-eia.md` existe, o
 * gabarito (`eia_answer`) está presente — no sidecar JSON OU no frontmatter do
 * `02-reviewed.md`. (Não confundir com `../eia-answer.ts`, que é o reader do
 * sidecar — este é o lint que o consome.)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readEiaAnswerSidecar } from "../eia-answer.ts"; // #927

export interface EiaAnswerCheckResult {
  ok: boolean;
  label?: string;
}

export function checkEiaAnswer(
  mdPath: string,
  editionDir?: string,
): EiaAnswerCheckResult {
  const dir = editionDir ?? dirname(mdPath);
  const eiaPath = join(dir, "01-eia.md");
  if (!existsSync(eiaPath)) {
    // 01-eia.md não existe — check não aplicável
    return { ok: true };
  }
  // #927: gabarito também pode estar no sidecar JSON. Sidecar sobrevive
  // Drive round-trip (frontmatter não), então sidecar válido = ok mesmo
  // que frontmatter tenha sido strippado.
  if (readEiaAnswerSidecar(dir)) {
    return { ok: true };
  }
  // 01-eia.md existe: verificar que o md tem eia_answer no frontmatter
  if (!existsSync(mdPath)) {
    return {
      ok: false,
      label: "eia_answer_missing: 01-eia.md exists but 02-reviewed.md not found",
    };
  }
  const md = readFileSync(mdPath, "utf8");
  const hasFm = /^---[\s\S]*?eia_answer[\s\S]*?---/.test(md);
  if (!hasFm) {
    return {
      ok: false,
      label:
        "eia_answer_missing: 01-eia.md exists but neither 01-eia-answer.json sidecar nor 02-reviewed.md frontmatter has eia_answer",
    };
  }
  return { ok: true };
}
