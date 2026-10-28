/**
 * test/lint-newsletter-md-destaque-min-chars.test.ts (#914)
 *
 * Cobre `checkDestaqueMinChars` e `--check destaque-min-chars` CLI.
 * Caso real 260507: D1=999, D2=708, D3=679 — dois bem abaixo do
 * proposto 900/900/1000.
 *
 * #11321: janela por posição — D1 1100–1200, D2/D3 900–1000.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  checkDestaqueMinChars,
  DESTAQUE_MIN_CHARS,
} from "../scripts/lint-newsletter-md.ts";

// Filler do D1 dentro da janela 1100–1200 (#11321): 1130 X + o why curto.
const D1_OK = 1130;

function makeDestaqueMd(num: number, category: string, chars: number): string {
  // Generate body com chars caracteres aproximados (mede após URL strip + collapse)
  const filler = "X".repeat(Math.max(10, chars));
  return [
    `**DESTAQUE ${num} | ${category}**`,
    "",
    `[Título](https://example.com/${num})`,
    "",
    `https://example.com/${num}`,
    "",
    filler,
    "",
    "Por que isso importa: impacto.",
    "",
  ].join("\n");
}

describe("checkDestaqueMinChars (#914) — helper puro", () => {
  it("ok=true quando todos destaques atingem mínimo", () => {
    const md = [
      makeDestaqueMd(1, "PRODUTO", D1_OK),
      "---",
      makeDestaqueMd(2, "PESQUISA", 950),
      "---",
      makeDestaqueMd(3, "MERCADO", 950),
    ].join("\n");
    const r = checkDestaqueMinChars(md);
    assert.equal(r.ok, true, JSON.stringify(r.highlights));
    assert.equal(r.errors.length, 0);
  });

  it("ok=false quando D1 abaixo de 1100, mesmo dentro da janela de D2/D3 (#11321)", () => {
    // ~980 chars: passaria em D2/D3 (900–1000), mas o piso do D1 é 1100.
    const md = [
      makeDestaqueMd(1, "PRODUTO", 950),
      "---",
      makeDestaqueMd(2, "PESQUISA", 950),
      "---",
      makeDestaqueMd(3, "MERCADO", 950),
    ].join("\n");
    const r = checkDestaqueMinChars(md);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].destaque, 1);
    assert.equal(r.errors[0].min, 1100);
    assert.ok(r.errors[0].chars >= 900 && r.errors[0].chars < 1100, String(r.errors[0].chars));
  });

  it("o mesmo corpo de ~980 chars passa em D2 e D3 (piso 900, #11321)", () => {
    const md = [
      makeDestaqueMd(1, "PRODUTO", D1_OK),
      "---",
      makeDestaqueMd(2, "PESQUISA", 950),
      "---",
      makeDestaqueMd(3, "MERCADO", 950),
    ].join("\n");
    const r = checkDestaqueMinChars(md);
    assert.equal(r.ok, true, JSON.stringify(r.highlights));
    const byNum = new Map(r.highlights.map((h) => [h.destaque, h]));
    assert.equal(byNum.get(1)?.min, 1100);
    assert.equal(byNum.get(2)?.min, 900);
    assert.equal(byNum.get(3)?.min, 900);
    assert.ok((byNum.get(1)?.chars ?? 0) >= 1100 && (byNum.get(1)?.chars ?? 0) <= 1200);
  });

  it("ok=false quando D2/D3 abaixo de 900 (caso 260507 D2=708, D3=679)", () => {
    const md = [
      makeDestaqueMd(1, "PRODUTO", D1_OK),
      "---",
      makeDestaqueMd(2, "PESQUISA", 700),
      "---",
      makeDestaqueMd(3, "MERCADO", 650),
    ].join("\n");
    const r = checkDestaqueMinChars(md);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 2);
    assert.equal(
      r.errors.find((e) => e.destaque === 2)?.min,
      900,
    );
    assert.equal(
      r.errors.find((e) => e.destaque === 3)?.min,
      900,
    );
  });

  it("D1: 1 char abaixo do piso de 1100 falha, no piso passa (boundary, #11321)", () => {
    const base = checkDestaqueMinChars(makeDestaqueMd(1, "PRODUTO", 1000)).highlights[0].chars;
    // Ajusta o filler pra cair exatamente em 1099 e 1100 chars medidos.
    const atMin = checkDestaqueMinChars(makeDestaqueMd(1, "PRODUTO", 1000 + (1100 - base)));
    assert.equal(atMin.highlights[0].chars, 1100);
    assert.equal(atMin.ok, true);
    const below = checkDestaqueMinChars(makeDestaqueMd(1, "PRODUTO", 1000 + (1099 - base)));
    assert.equal(below.highlights[0].chars, 1099);
    assert.equal(below.ok, false);
  });

  it("ignora destaques numerados além de 3 (não tem min definido)", () => {
    const md = [
      makeDestaqueMd(1, "PRODUTO", D1_OK),
      "---",
      makeDestaqueMd(2, "PESQUISA", 950),
      "---",
      makeDestaqueMd(3, "MERCADO", 950),
      "---",
      makeDestaqueMd(4, "EXTRA", 200),
    ].join("\n");
    const r = checkDestaqueMinChars(md);
    // D4 tem 200 chars — apenas D3 default min (900) aplicado pra ele
    assert.ok(r.highlights.find((h) => h.destaque === 4));
  });

  it("MD sem destaques: ok=true (nada pra checar)", () => {
    const md = "Apenas texto sem destaques.";
    const r = checkDestaqueMinChars(md);
    assert.equal(r.ok, true);
    assert.equal(r.highlights.length, 0);
  });
});

describe("DESTAQUE_MIN_CHARS constants", () => {
  it("D1=1100, D2=D3=900 — janela por posição (#11321, pedido do editor 27/10/2026)", () => {
    assert.equal(DESTAQUE_MIN_CHARS[1], 1100);
    assert.equal(DESTAQUE_MIN_CHARS[2], 900);
    assert.equal(DESTAQUE_MIN_CHARS[3], 900);
  });
});

describe("--check destaque-min-chars CLI (#914)", () => {
  function runCli(args: string[]) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "lint-newsletter-md.ts");
    return spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, ...args],
      { cwd: projectRoot, encoding: "utf8" },
    );
  }

  it("exit 0 quando todos destaques atingem mínimo", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-min-ok-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const md = [
        makeDestaqueMd(1, "PRODUTO", D1_OK),
        "---",
        makeDestaqueMd(2, "PESQUISA", 950),
        "---",
        makeDestaqueMd(3, "MERCADO", 950),
      ].join("\n");
      writeFileSync(mdPath, md, "utf8");
      const r = runCli(["--check", "destaque-min-chars", "--md", mdPath]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 1 quando D2 abaixo de 900", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-min-fail-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const md = [
        makeDestaqueMd(1, "PRODUTO", D1_OK),
        "---",
        makeDestaqueMd(2, "PESQUISA", 600),
        "---",
        makeDestaqueMd(3, "MERCADO", 950),
      ].join("\n");
      writeFileSync(mdPath, md, "utf8");
      const r = runCli(["--check", "destaque-min-chars", "--md", mdPath]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /D2.*abaixo do mínimo de 900/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
