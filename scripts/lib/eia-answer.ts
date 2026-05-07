/**
 * eia-answer.ts (#927)
 *
 * Source-of-truth helper para o gabarito do É IA? (qual slot — A ou B —
 * é a imagem real e qual é a IA).
 *
 * **Por que existe:** o frontmatter YAML em `01-eia.md` (e propagado pra
 * `02-reviewed.md` via `normalize-newsletter.ts`) é strippado pelo Google
 * Drive no round-trip Markdown → Google Doc → Markdown. Editor edita no
 * Drive, pull volta sem frontmatter, gabarito perde. Fix: persistir o
 * gabarito num **sidecar JSON** (`_internal/01-eia-answer.json`) que não
 * sofre esse stripping.
 *
 * **Source-of-truth ordem (mais novo → mais antigo):**
 *   1. `_internal/01-eia-answer.json` — sidecar dedicado (pós-#927).
 *   2. `_internal/01-eia-meta.json` — derivar A/B a partir de `ai_side`.
 *   3. `01-eia.md` frontmatter — backward compat com edições antigas.
 *
 * Helpers:
 *   - `writeEiaAnswerSidecar(editionDir, answer)` — grava o sidecar.
 *   - `readEiaAnswer(editionDir)` — lê com fallback chain.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

export interface EiaAnswer {
  /** Slot A: "real" se foto real, "ia" se imagem gerada. */
  A: "real" | "ia";
  /** Slot B: "real" se foto real, "ia" se imagem gerada. */
  B: "real" | "ia";
}

/** Estrutura serializada em `_internal/01-eia-answer.json`. */
export interface EiaAnswerSidecar {
  edition: string;
  answer: EiaAnswer;
  /** Slot da imagem IA = letra correta no poll. Derivado de `answer`. */
  ai_side: "A" | "B";
}

/** Path canônico do sidecar a partir de um `editionDir`. */
export function eiaAnswerSidecarPath(editionDir: string): string {
  return resolve(editionDir, "_internal", "01-eia-answer.json");
}

/**
 * Grava o sidecar JSON com o gabarito do É IA?. Cria `_internal/` se
 * ausente. Idempotente — re-gravar não muda comportamento (mesmo conteúdo
 * pra mesmo input).
 */
export function writeEiaAnswerSidecar(
  editionDir: string,
  edition: string,
  answer: EiaAnswer,
): void {
  const path = eiaAnswerSidecarPath(editionDir);
  mkdirSync(dirname(path), { recursive: true });
  const aiSide: "A" | "B" = answer.A === "ia" ? "A" : "B";
  const sidecar: EiaAnswerSidecar = { edition, answer, ai_side: aiSide };
  // Atomic write: .tmp + renameSync — match convenção do projeto (lib/json-safe).
  // Evita sidecar parcial se processo morrer no meio do writeFileSync.
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(sidecar, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/**
 * Lê o gabarito do sidecar JSON. Retorna null se ausente ou malformado.
 */
export function readEiaAnswerSidecar(editionDir: string): EiaAnswer | null {
  const path = eiaAnswerSidecarPath(editionDir);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Partial<EiaAnswerSidecar>;
    const a = data.answer?.A;
    const b = data.answer?.B;
    if ((a === "real" || a === "ia") && (b === "real" || b === "ia")) {
      return { A: a, B: b };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Lê `ai_side` de `_internal/01-eia-meta.json` e deriva o mapping A/B.
 * Retorna null se meta ausente, malformado ou ai_side null.
 */
export function readEiaAnswerFromMeta(editionDir: string): EiaAnswer | null {
  const path = resolve(editionDir, "_internal", "01-eia-meta.json");
  if (!existsSync(path)) return null;
  try {
    const meta = JSON.parse(readFileSync(path, "utf8")) as { ai_side?: "A" | "B" | null };
    if (meta.ai_side === "A") return { A: "ia", B: "real" };
    if (meta.ai_side === "B") return { A: "real", B: "ia" };
    return null;
  } catch {
    return null;
  }
}

/**
 * Lê o gabarito do frontmatter de `01-eia.md`. Suporta a forma mapeamento
 * (`eia_answer:\n  A: real\n  B: ia`). Retorna null se ausente, sem
 * frontmatter, ou malformado.
 *
 * **Backward compat only.** Edições antigas (pré-#927) gravavam só no
 * frontmatter — esse helper resgata o gabarito quando o sidecar não foi
 * gravado e o meta.json também não tem `ai_side`.
 */
export function readEiaAnswerFromFrontmatter(editionDir: string): EiaAnswer | null {
  const eiaPath = resolve(editionDir, "01-eia.md");
  const legacyPath = resolve(editionDir, "01-eai.md");
  const path = existsSync(eiaPath) ? eiaPath : existsSync(legacyPath) ? legacyPath : null;
  if (!path) return null;
  const text = readFileSync(path, "utf8");
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];
  if (!/eia_answer/i.test(fm) && !/eai_answer/i.test(fm)) return null;
  const aMatch = fm.match(/^\s*A:\s*(real|ia)\s*$/m);
  const bMatch = fm.match(/^\s*B:\s*(real|ia)\s*$/m);
  if (!aMatch || !bMatch) return null;
  return { A: aMatch[1] as "real" | "ia", B: bMatch[1] as "real" | "ia" };
}

/**
 * Resolve o gabarito do É IA? consultando, em ordem:
 *   1. Sidecar `_internal/01-eia-answer.json` (pós-#927).
 *   2. `_internal/01-eia-meta.json` campo `ai_side`.
 *   3. Frontmatter de `01-eia.md` (backward compat).
 *
 * Retorna null quando nenhuma source tem dado válido — caller decide o
 * que fazer (pular gabarito, falhar, fallback, etc).
 */
export function readEiaAnswer(editionDir: string): EiaAnswer | null {
  return (
    readEiaAnswerSidecar(editionDir) ??
    readEiaAnswerFromMeta(editionDir) ??
    readEiaAnswerFromFrontmatter(editionDir)
  );
}

/** Helper: deriva `ai_side` ("A" | "B") a partir de um EiaAnswer. */
export function aiSideFromAnswer(answer: EiaAnswer): "A" | "B" {
  return answer.A === "ia" ? "A" : "B";
}
