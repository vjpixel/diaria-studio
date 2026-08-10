/**
 * test/stage-4-title-mentions-ia-invariant.test.ts (#4825)
 *
 * Cobre o registro do lint `title-mentions-ia` em
 * `invariant-checks/stage-4.ts` — espelha o padrão de
 * test/stage-4-no-trailing-ellipsis-invariant.test.ts (#2881) /
 * test/stage-4-title-normalization-invariant.test.ts (#2693 item 3).
 *
 * WARN-ONLY por decisão do editor (#4825): a violação tem `severity:
 * "warning"` — nunca deve bloquear o gate da Etapa 4.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkTitleMentionsIaInvariant,
  STAGE_4_RULES,
} from "../scripts/lib/invariant-checks/stage-4.ts";

function makeEditionWithReviewed(md: string): string {
  const dir = mkdtempSync(join(tmpdir(), "stage4-title-mentions-ia-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(resolve(dir, "02-reviewed.md"), md);
  return dir;
}

describe("checkTitleMentionsIaInvariant (#4825)", () => {
  it("flagra título DESTAQUE mencionando 'IA' (warning)", () => {
    const md = [
      "DESTAQUE 1 | INDÚSTRIA",
      "",
      "[Nova IA da Anthropic escreve código sozinha](https://example.com/d1)",
      "",
      "Por que isso importa: contexto relevante aqui.",
      "",
      "---",
    ].join("\n");
    const dir = makeEditionWithReviewed(md);
    try {
      const v = checkTitleMentionsIaInvariant(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
      assert.equal(v[0].rule, "title-mentions-ia");
      assert.equal(v[0].source_issue, "#4825");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("retorna [] quando 02-reviewed.md não existe (stage não chegou lá)", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-title-mentions-ia-missing-"));
    try {
      assert.deepEqual(checkTitleMentionsIaInvariant(dir), []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("retorna [] pra título limpo sem menção a IA/AI", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      "[Claude escreve código sozinha em novo benchmark](https://example.com/d1)",
      "",
      "Por que isso importa: contexto relevante aqui.",
      "",
      "---",
    ].join("\n");
    const dir = makeEditionWithReviewed(md);
    try {
      assert.deepEqual(checkTitleMentionsIaInvariant(dir), []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("STAGE_4_RULES registry (#4825)", () => {
  it("inclui title-mentions-ia", () => {
    const ids = STAGE_4_RULES.map((r) => r.id);
    assert.ok(ids.includes("title-mentions-ia"));
  });

  it("title-mentions-ia é a Etapa 4 (não bloqueante)", () => {
    const rule = STAGE_4_RULES.find((r) => r.id === "title-mentions-ia");
    assert.ok(rule);
    assert.equal(rule!.stage, 4);
    assert.equal(rule!.source_issue, "#4825");
  });
});
