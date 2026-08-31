/**
 * test/gen-carousel-cards-preserves-bold-6862.test.ts (#6862)
 *
 * O ponto central da issue: o fix de #6862 (strip de markdown de ênfase no
 * PUBLISH) não pode vazar pro carrossel, que MANTÉM o negrito de propósito
 * (decisão do editor, 31/08/2026 — `.claude/agents/social-writer.md` #6086
 * item c: cada parágrafo de `## d{N}` tem EXATAMENTE UM trecho `**...**`,
 * renderizado como negrito real no card). Guard estático: nem
 * `gen-carousel-cards.ts` nem `lib/daily-carousel-card.ts` podem importar
 * `strip-markdown-emphasis.ts` — se algum dia importarem, o negrito some
 * silenciosamente dos cards (regressão sem teste funcional óbvio, já que o
 * card ainda "funciona", só sai sem a ênfase visual).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("gen-carousel-cards.ts / daily-carousel-card.ts NUNCA importam strip-markdown-emphasis (#6862)", () => {
  for (const file of ["scripts/gen-carousel-cards.ts", "scripts/lib/daily-carousel-card.ts"]) {
    it(`${file} não referencia strip-markdown-emphasis nem stripMarkdownEmphasis`, () => {
      const src = readFileSync(resolve(ROOT, file), "utf8");
      assert.ok(
        !src.includes("strip-markdown-emphasis") && !src.includes("stripMarkdownEmphasis"),
        `${file} não deveria importar o strip de ênfase — o carrossel mantém o negrito de propósito (#6086 item c)`,
      );
    });
  }
});
