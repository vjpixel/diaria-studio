/**
 * test/stage-4-truncated-secondary-summary.test.ts (#2596)
 *
 * Cobre o lint Stage 4 `truncated-secondary-item-summary` end-to-end (lê
 * 02-reviewed.md de um edition-dir temporário).
 *
 * Casos:
 *   - RADAR item canônico (link+desc na mesma linha) com 'conformidade…' → warning.
 *   - Item 2-linhas (link sozinho + desc) truncado → warning.
 *   - Item com URL Wikipedia (parênteses balanceados) truncado → warning
 *     (trava o finding #1: regex não pode parar no 1º `)` da URL — #2413).
 *   - Reticência intencional ('e por aí vai…') → sem warning.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkTruncatedSecondaryItemSummary } from "../scripts/lib/invariant-checks/stage-4.ts";

function makeEditionWithReviewed(md: string): string {
  const dir = mkdtempSync(join(tmpdir(), "stage4-trunc-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(resolve(dir, "02-reviewed.md"), md);
  return dir;
}

describe("checkTruncatedSecondaryItemSummary (#2596)", () => {
  it("RADAR item canônico com 'conformidade…' → warning", () => {
    const md = [
      "**📡 RADAR**",
      "",
      "**[Exame](https://exame.com/tech)** Nova política de conformidade…",
      "",
    ].join("\n");
    const dir = makeEditionWithReviewed(md);
    try {
      const v = checkTruncatedSecondaryItemSummary(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
      assert.equal(v[0].rule, "truncated-secondary-item-summary");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("item 2-linhas com descrição truncada → warning", () => {
    const md = [
      "**🚀 LANÇAMENTOS**",
      "",
      "**[Acme](https://acme.com)**",
      "A nova ferramenta promete integração com…",
      "",
    ].join("\n");
    const dir = makeEditionWithReviewed(md);
    try {
      const v = checkTruncatedSecondaryItemSummary(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("FINDING #1: URL Wikipedia (parênteses balanceados) + desc truncada → warning", () => {
    // Sem URL_WITH_BALANCED_PARENS_RE_PART, a regex pararia no 1º `)` da URL
    // e o item escaparia silenciosamente o check (bug pré-#2413 reintroduzido).
    const md = [
      "**📡 RADAR**",
      "",
      "**[GPT-4](https://en.wikipedia.org/wiki/GPT-4_(language_model))** O modelo é capaz de…",
      "",
    ].join("\n");
    const dir = makeEditionWithReviewed(md);
    try {
      const v = checkTruncatedSecondaryItemSummary(dir);
      assert.equal(v.length, 1, "item com URL de parens balanceados deve ser checado");
      assert.equal(v[0].severity, "warning");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("reticência intencional 'e por aí vai…' → sem warning", () => {
    const md = [
      "**📡 RADAR**",
      "",
      "**[Blog](https://blog.com/post)** O setor cresce e por aí vai…",
      "",
    ].join("\n");
    const dir = makeEditionWithReviewed(md);
    try {
      assert.equal(checkTruncatedSecondaryItemSummary(dir).length, 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("02-reviewed.md ausente → sem violações", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-trunc-empty-"));
    try {
      assert.equal(checkTruncatedSecondaryItemSummary(dir).length, 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
