/**
 * test/edition-utils.test.ts (#852 follow-up)
 *
 * Cobre os helpers `firstEditionOfCurrentMonth` e `aammddToGmailDate`
 * usados pelo cutoff do drain Gmail no sorteio (Stage 0p + skill).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  firstEditionOfCurrentMonth,
  aammddToGmailDate,
} from "../scripts/lib/edition-utils.ts";

function makeEditionsDir(editionDirs: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "edition-utils-"));
  for (const e of editionDirs) {
    mkdirSync(join(root, e), { recursive: true });
  }
  return root;
}

describe("firstEditionOfCurrentMonth (#852)", () => {
  it("retorna primeira edição do mês corrente em ordem ascendente", () => {
    const dir = makeEditionsDir(["260417", "260418", "260504", "260505", "260506"]);
    try {
      // Mock now = 7 de maio 2026 BRT (10h UTC)
      const now = new Date("2026-05-07T13:00:00Z");
      const result = firstEditionOfCurrentMonth(now, dir);
      assert.equal(result, "260504");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignora edições de meses anteriores", () => {
    const dir = makeEditionsDir(["260417", "260420", "260430", "260504"]);
    try {
      const now = new Date("2026-05-07T13:00:00Z");
      const result = firstEditionOfCurrentMonth(now, dir);
      assert.equal(result, "260504", "deve pegar 260504, não 260417 ou 260420");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna null se não há edições do mês corrente", () => {
    const dir = makeEditionsDir(["260417", "260418", "260420"]);
    try {
      const now = new Date("2026-05-07T13:00:00Z");
      const result = firstEditionOfCurrentMonth(now, dir);
      assert.equal(result, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna null se editionsDir não existe", () => {
    const result = firstEditionOfCurrentMonth(new Date(), "/nonexistent/path");
    assert.equal(result, null);
  });

  it("BRT timezone: 1º maio 02:00 UTC ainda é abril em BRT", () => {
    const dir = makeEditionsDir(["260430", "260501"]);
    try {
      // 1º maio 02:00 UTC = 30 abril 23:00 BRT
      const now = new Date("2026-05-01T02:00:00Z");
      const result = firstEditionOfCurrentMonth(now, dir);
      // Mês corrente em BRT é abril → 260430 deve ser primeira de abril
      assert.equal(result, "260430");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("BRT timezone: 1º maio 04:00 UTC é maio em BRT", () => {
    const dir = makeEditionsDir(["260430", "260501"]);
    try {
      // 1º maio 04:00 UTC = 1º maio 01:00 BRT
      const now = new Date("2026-05-01T04:00:00Z");
      const result = firstEditionOfCurrentMonth(now, dir);
      assert.equal(result, "260501");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignora arquivos não-AAMMDD (backups, etc)", () => {
    const dir = makeEditionsDir([
      "260504",
      "260504-backup-2026-05-04T10-00",
      "260505-local-backup",
      "260506",
    ]);
    try {
      const now = new Date("2026-05-07T13:00:00Z");
      const result = firstEditionOfCurrentMonth(now, dir);
      assert.equal(result, "260504");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("aammddToGmailDate (#852)", () => {
  it("converte AAMMDD pra YYYY/MM/DD", () => {
    assert.equal(aammddToGmailDate("260504"), "2026/05/04");
    assert.equal(aammddToGmailDate("251231"), "2025/12/31");
    assert.equal(aammddToGmailDate("270101"), "2027/01/01");
  });

  it("throw em AAMMDD inválido", () => {
    assert.throws(() => aammddToGmailDate("2605"), /AAMMDD inválido/);
    assert.throws(() => aammddToGmailDate("26050a"), /AAMMDD inválido/);
    assert.throws(() => aammddToGmailDate(""), /AAMMDD inválido/);
  });
});
