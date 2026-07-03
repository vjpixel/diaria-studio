/**
 * test/stage-4-no-trailing-ellipsis-invariant.test.ts (#2881)
 *
 * Cobre o registro do lint `no-trailing-ellipsis` em
 * `invariant-checks/stage-4.ts` — espelha o padrão de
 * test/stage-4-title-normalization-invariant.test.ts (#2693 item 3).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkNoTrailingEllipsisInvariant,
  STAGE_4_RULES,
} from "../scripts/lib/invariant-checks/stage-4.ts";

function makeEditionWithReviewed(md: string): string {
  const dir = mkdtempSync(join(tmpdir(), "stage4-no-trailing-ellipsis-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(resolve(dir, "02-reviewed.md"), md);
  return dir;
}

describe("checkNoTrailingEllipsisInvariant (#2881)", () => {
  it("flagra descrição RADAR terminando em reticência (warning)", () => {
    const md = [
      "RADAR",
      "",
      "[Gestão lança Matriz de Competências em IA](https://example.com/radar)",
      "com ênfase em ética, transparência, não-discriminação, segurança e soberania…",
      "",
    ].join("\n");
    const dir = makeEditionWithReviewed(md);
    try {
      const v = checkNoTrailingEllipsisInvariant(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
      assert.equal(v[0].rule, "no-trailing-ellipsis");
      assert.equal(v[0].source_issue, "#2881");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("retorna [] quando 02-reviewed.md não existe (stage não chegou lá)", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-no-trailing-ellipsis-missing-"));
    try {
      assert.deepEqual(checkNoTrailingEllipsisInvariant(dir), []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("retorna [] pra descrição limpa sem reticência", () => {
    const md = [
      "RADAR",
      "",
      "[Startup brasileira capta rodada Series A](https://example.com/radar)",
      "A empresa vai usar o aporte para expandir operações.",
      "",
    ].join("\n");
    const dir = makeEditionWithReviewed(md);
    try {
      assert.deepEqual(checkNoTrailingEllipsisInvariant(dir), []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("STAGE_4_RULES registry (#2881)", () => {
  it("inclui no-trailing-ellipsis", () => {
    const ids = STAGE_4_RULES.map((r) => r.id);
    assert.ok(ids.includes("no-trailing-ellipsis"));
  });
});
