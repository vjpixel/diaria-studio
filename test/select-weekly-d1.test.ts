/**
 * select-weekly-d1.test.ts (#4101, seleção removida pelo #4483)
 *
 * Cobre só a aritmética de calendário que sobrou neste arquivo depois do
 * #4483 (`computeWeekdayEditionDates`, `resolveWeeklyEditionDirs`) — a
 * seleção por clique (`selectWeeklyD1` foi REMOVIDO) tem seus próprios
 * testes em `test/weekly-instagram-select.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import {
  computeWeekdayEditionDates,
  resolveWeeklyEditionDirs,
} from "../scripts/lib/select-weekly-d1.ts";

function setupEdition(root: string, date: string, d1Title: string, d1Url: string): string {
  const dir = resolve(root, date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, "02-reviewed.md"),
    `DESTAQUE 1 | Notícias\n${d1Title}\n${d1Url}\n\nCorpo do D1.\n\nPor que isso importa:\nExplicação D1.`,
    "utf8",
  );
  return dir;
}

describe("computeWeekdayEditionDates", () => {
  it("retorna segunda a sexta imediatamente anteriores, em ordem cronológica", () => {
    // Sábado 2026-04-25 → segunda 2026-04-20 .. sexta 2026-04-24
    const saturday = new Date(2026, 3, 25); // month 0-indexed: abril=3
    const dates = computeWeekdayEditionDates(saturday);
    assert.deepEqual(dates, ["260420", "260421", "260422", "260423", "260424"]);
  });

  it("cruza virada de mês corretamente", () => {
    // Sábado 2026-08-01 → segunda 2026-07-27 .. sexta 2026-07-31
    const saturday = new Date(2026, 7, 1); // agosto
    const dates = computeWeekdayEditionDates(saturday);
    assert.deepEqual(dates, ["260727", "260728", "260729", "260730", "260731"]);
  });

  it("cruza virada de ano corretamente", () => {
    // Sábado 2026-01-03 → segunda 2025-12-29 .. sexta 2026-01-02
    const saturday = new Date(2026, 0, 3); // janeiro
    const dates = computeWeekdayEditionDates(saturday);
    assert.deepEqual(dates, ["251229", "251230", "251231", "260101", "260102"]);
  });
});

describe("resolveWeeklyEditionDirs", () => {
  it("marca exists:true só para dirs com 02-reviewed.md no disco", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-"));
    try {
      setupEdition(root, "260421", "Título Segunda", "https://example.com/seg");
      // 260422 (terça) não existe no disco.
      const saturday = new Date(2026, 3, 25);
      const result = resolveWeeklyEditionDirs(saturday, root);
      assert.equal(result.length, 5);
      assert.equal(result[0].date, "260420");
      assert.equal(result[0].exists, false);
      assert.equal(result[1].date, "260421");
      assert.equal(result[1].exists, true);
      assert.equal(result[2].exists, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolve edições no layout NESTED (data/editions/{AAMM}/{AAMMDD}), não só flat (#5xxx)", () => {
    // Regressão: resolveWeeklyEditionDirs montava `resolve(editionsRoot, date)`
    // direto, ignorando o layout nested pós-migração (#3024) — mesma classe
    // de bug do #3030/#3031. `select-linkedin-weekly.ts` já usava
    // `resolveEditionDir` (dual flat/nested) corretamente; este arquivo não.
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-nested-"));
    try {
      // 260421 só existe em layout NESTED — nunca em flat.
      const nestedDir = resolve(root, "2604", "260421");
      mkdirSync(nestedDir, { recursive: true });
      writeFileSync(
        resolve(nestedDir, "02-reviewed.md"),
        "DESTAQUE 1 | Notícias\nTítulo Segunda\nhttps://example.com/seg\n\nCorpo do D1.\n\nPor que isso importa:\nExplicação D1.",
        "utf8",
      );
      const saturday = new Date(2026, 3, 25);
      const result = resolveWeeklyEditionDirs(saturday, root);
      const monday = result.find((c) => c.date === "260421");
      assert.ok(monday, "260421 deveria estar entre os 5 candidatos");
      assert.equal(monday!.exists, true, "edição nested deveria ser encontrada");
      assert.equal(monday!.dir, nestedDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
