/**
 * test/destaque-category-noticias-stage2-9105.test.ts (#9105)
 *
 * Regressão (#633): na edição 260930 os 3 destaques saíram do Stage 2
 * (spawn headless) como `⚠️ NOTÍCIAS` / `📊 NOTÍCIAS` / `📦 NOTÍCIAS`. O
 * guard `destaque-category-noticias` (#8200) só rodava no agregador do
 * Stage 4, então `check-invariants --stage 2` passava e o sentinel do Stage 2
 * era gravado sem acusar. Agora o check integra `reviewed-passes-all-lints`
 * (Stage 2), e uma violation `severity: error` faz `pipeline-sentinel.ts
 * write --step 2` recusar o sentinel.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReviewedPassesAllLints } from "../scripts/lib/invariant-checks/stage-2.ts";

const RULE = "reviewed-destaque-category-noticias";

function mdWithCategories(cats: [string, string, string]): string {
  return cats
    .map((c, i) => `**DESTAQUE ${i + 1} | ${c}**\n\nTítulo do destaque ${i + 1}\n\nCorpo.\n`)
    .join("\n");
}

describe("Stage 2 barra categoria NOTÍCIAS nos destaques (#9105)", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("CASO REAL 260930: 3 destaques NOTÍCIAS geram violation error no Stage 2", () => {
    dir = mkdtempSync(join(tmpdir(), "stage2-noticias-"));
    writeFileSync(
      join(dir, "02-reviewed.md"),
      mdWithCategories(["⚠️ NOTÍCIAS", "📊 NOTÍCIAS", "📦 NOTÍCIAS"]),
    );
    const v = checkReviewedPassesAllLints(dir).filter((x) => x.rule === RULE);
    assert.equal(v.length, 1, "esperava 1 violation reviewed-destaque-category-noticias");
    assert.equal(v[0].severity, "error");
    assert.equal(v[0].source_issue, "#8200");
    // Conteúdo do stderr do lint (não só o nome do check, que runCheck sempre
    // inclui via args): prova que falhou pela categoria, não por outro exit != 0.
    assert.match(v[0].message, /categoria 'NOTÍCIAS'/);
    assert.match(v[0].message, /DESTAQUE 1/);
  });

  it("um único destaque NOTÍCIAS (os outros temáticos) já bloqueia — sem exceção de 'último recurso' (#6083)", () => {
    dir = mkdtempSync(join(tmpdir(), "stage2-noticias-one-"));
    writeFileSync(
      join(dir, "02-reviewed.md"),
      mdWithCategories(["🚀 LANÇAMENTO", "📰 NOTÍCIAS", "⚖️ REGULAÇÃO"]),
    );
    const v = checkReviewedPassesAllLints(dir).filter((x) => x.rule === RULE);
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "error");
    assert.match(v[0].message, /DESTAQUE 2/);
  });

  it("categorias temáticas (MERCADO, REGULAÇÃO, LANÇAMENTO) não geram essa violation", () => {
    dir = mkdtempSync(join(tmpdir(), "stage2-noticias-ok-"));
    writeFileSync(
      join(dir, "02-reviewed.md"),
      mdWithCategories(["🚀 LANÇAMENTO", "📈 MERCADO", "⚖️ REGULAÇÃO"]),
    );
    const v = checkReviewedPassesAllLints(dir).filter((x) => x.rule === RULE);
    assert.equal(v.length, 0, JSON.stringify(v));
  });
});
