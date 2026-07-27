/**
 * select-weekly-d1.test.ts (#4101)
 *
 * Teste de regressão exigido pela issue #4101:
 *   - selectWeeklyD1(editionDirs) retorna exatamente 1 item por edição,
 *     sempre o DESTAQUE 1, em ordem cronológica seg→sex.
 *   - Semana com 4 edições retorna 4 itens (nunca completa com D2).
 *   - Semana com 0 edições retorna [] (e o publisher não é chamado — testado
 *     separadamente em publish-weekly-social.test.ts).
 *   - computeWeekdayEditionDates cobre a ambiguidade de virada de mês/ano.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import {
  computeWeekdayEditionDates,
  resolveWeeklyEditionDirs,
  selectWeeklyD1,
} from "../scripts/lib/select-weekly-d1.ts";

function makeReviewedMd(d1Title: string, d1Url: string, extraDestaques = 2): string {
  const blocks = [
    `DESTAQUE 1 | Notícias\n${d1Title}\n${d1Url}\n\nCorpo do D1.\n\nPor que isso importa:\nExplicação D1.`,
  ];
  for (let n = 2; n <= extraDestaques + 1; n++) {
    blocks.push(
      `DESTAQUE ${n} | Notícias\nTítulo D${n}\nhttps://example.com/d${n}\n\nCorpo D${n}.\n\nPor que isso importa:\nExplicação D${n}.`,
    );
  }
  return blocks.join("\n\n---\n\n");
}

function setupEdition(root: string, date: string, d1Title: string, d1Url: string): string {
  const dir = resolve(root, date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "02-reviewed.md"), makeReviewedMd(d1Title, d1Url), "utf8");
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
});

describe("selectWeeklyD1", () => {
  it("retorna exatamente 1 item por edição, sempre DESTAQUE 1, em ordem", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-"));
    try {
      const dirs = [
        setupEdition(root, "260420", "Título Segunda", "https://example.com/seg"),
        setupEdition(root, "260421", "Título Terça", "https://example.com/ter"),
        setupEdition(root, "260422", "Título Quarta", "https://example.com/qua"),
        setupEdition(root, "260423", "Título Quinta", "https://example.com/qui"),
        setupEdition(root, "260424", "Título Sexta", "https://example.com/sex"),
      ];
      const items = selectWeeklyD1(dirs);
      assert.equal(items.length, 5);
      assert.deepEqual(
        items.map((i) => i.editionDate),
        ["260420", "260421", "260422", "260423", "260424"],
      );
      assert.deepEqual(
        items.map((i) => i.title),
        ["Título Segunda", "Título Terça", "Título Quarta", "Título Quinta", "Título Sexta"],
      );
      // Nunca pega D2/D3 — confere que a URL bate com o D1, não com d2/d3 fixtures.
      assert.equal(items[0].url, "https://example.com/seg");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("semana com 4 edições retorna 4 itens — nunca completa com D2", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-"));
    try {
      const dirs = [
        setupEdition(root, "260420", "Segunda", "https://example.com/seg"),
        setupEdition(root, "260421", "Terça", "https://example.com/ter"),
        // Quarta ausente (feriado) — nunca deve ser preenchida com D2 de outra edição.
        setupEdition(root, "260423", "Quinta", "https://example.com/qui"),
        setupEdition(root, "260424", "Sexta", "https://example.com/sex"),
      ];
      const items = selectWeeklyD1(dirs);
      assert.equal(items.length, 4);
      assert.deepEqual(
        items.map((i) => i.title),
        ["Segunda", "Terça", "Quinta", "Sexta"],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("semana com 0 edições retorna []", () => {
    const items = selectWeeklyD1([]);
    assert.deepEqual(items, []);
  });

  it("pula edição com 02-reviewed.md ausente sem lançar", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-"));
    try {
      const dirs = [
        setupEdition(root, "260420", "Segunda", "https://example.com/seg"),
        resolve(root, "260421"), // dir nem existe
      ];
      const items = selectWeeklyD1(dirs);
      assert.equal(items.length, 1);
      assert.equal(items[0].editionDate, "260420");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pula edição sem DESTAQUE 1 parseável (sem URL) sem lançar", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-"));
    try {
      const dir = resolve(root, "260420");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        resolve(dir, "02-reviewed.md"),
        "DESTAQUE 1 | Notícias\nTítulo sem URL\n\nCorpo sem link.",
        "utf8",
      );
      const items = selectWeeklyD1([dir]);
      assert.deepEqual(items, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
