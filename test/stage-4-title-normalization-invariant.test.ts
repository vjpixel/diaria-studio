/**
 * test/stage-4-title-normalization-invariant.test.ts (#2693 item 3)
 *
 * Cobre o registro dos 2 lints de título (#2664 sufixo de veículo, #2672
 * ponto final) em `invariant-checks/stage-4.ts` — antes rodavam só via CLI
 * separada (`lint-newsletter-md.ts --check title-publisher-suffix`), fora
 * do registry e portanto invisíveis em `docs/editorial-invariants.md`.
 *
 * end-to-end (lê 02-reviewed.md de um edition-dir temporário), espelhando o
 * padrão de test/stage-4-truncated-secondary-summary.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkTitlePublisherSuffixInvariant,
  checkTitleTrailingPeriodInvariant,
} from "../scripts/lib/invariant-checks/stage-4.ts";
import { STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";

function makeEditionWithReviewed(md: string): string {
  const dir = mkdtempSync(join(tmpdir(), "stage4-title-norm-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(resolve(dir, "02-reviewed.md"), md);
  return dir;
}

describe("checkTitlePublisherSuffixInvariant (#2693 item 3)", () => {
  it("flagra título DESTAQUE com sufixo de veículo residual (warning)", () => {
    const md = [
      "DESTAQUE 1 | INTELIGÊNCIA ARTIFICIAL",
      "",
      "[ChatGPT consegue fazer check-up do seu PC; veja como - Canaltech](https://example.com/d1)",
      "",
      "Por que isso importa: contexto relevante aqui.",
      "",
      "---",
    ].join("\n");
    const dir = makeEditionWithReviewed(md);
    try {
      const v = checkTitlePublisherSuffixInvariant(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
      assert.equal(v[0].rule, "title-publisher-suffix");
      assert.equal(v[0].source_issue, "#2664");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("retorna [] quando 02-reviewed.md não existe (stage não chegou lá)", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-title-norm-missing-"));
    try {
      assert.deepEqual(checkTitlePublisherSuffixInvariant(dir), []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("retorna [] pra título limpo sem sufixo", () => {
    const md = [
      "DESTAQUE 1 | INTELIGÊNCIA ARTIFICIAL",
      "",
      "[Modelo de IA da Meta supera GPT-4 em benchmarks](https://example.com/d1)",
      "",
      "Por que isso importa: contexto relevante aqui.",
      "",
      "---",
    ].join("\n");
    const dir = makeEditionWithReviewed(md);
    try {
      assert.deepEqual(checkTitlePublisherSuffixInvariant(dir), []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("checkTitleTrailingPeriodInvariant (#2693 item 3)", () => {
  it("flagra título de item RADAR com ponto final (warning)", () => {
    const md = [
      "RADAR",
      "",
      "[AINews: relatório da OpenAI sobre Codex em 2025.](https://example.com/radar)",
      "Descrição do item.",
      "",
    ].join("\n");
    const dir = makeEditionWithReviewed(md);
    try {
      const v = checkTitleTrailingPeriodInvariant(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
      assert.equal(v[0].rule, "title-trailing-period");
      assert.equal(v[0].source_issue, "#2672");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("retorna [] quando 02-reviewed.md não existe", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-title-norm-missing-"));
    try {
      assert.deepEqual(checkTitleTrailingPeriodInvariant(dir), []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("STAGE_4_RULES registry (#2693 item 3)", () => {
  it("inclui title-publisher-suffix e title-trailing-period", () => {
    const ids = STAGE_4_RULES.map((r) => r.id);
    assert.ok(ids.includes("title-publisher-suffix"));
    assert.ok(ids.includes("title-trailing-period"));
  });
});
