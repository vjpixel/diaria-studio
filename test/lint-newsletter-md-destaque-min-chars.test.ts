/**
 * test/lint-newsletter-md-destaque-min-chars.test.ts (#914)
 *
 * Cobre `checkDestaqueMinChars` e `--check destaque-min-chars` CLI.
 * Caso real 260507: D1=999, D2=708, D3=679 — dois bem abaixo do
 * proposto 900/900/1000.
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
      makeDestaqueMd(1, "PRODUTO", 950),
      "---",
      makeDestaqueMd(2, "PESQUISA", 950),
      "---",
      makeDestaqueMd(3, "MERCADO", 950),
    ].join("\n");
    const r = checkDestaqueMinChars(md);
    assert.equal(r.ok, true, JSON.stringify(r.highlights));
    assert.equal(r.errors.length, 0);
  });

  it("ok=false quando D1 abaixo de 900 (janela única #6061)", () => {
    const md = [
      makeDestaqueMd(1, "PRODUTO", 800),
      "---",
      makeDestaqueMd(2, "PESQUISA", 950),
      "---",
      makeDestaqueMd(3, "MERCADO", 950),
    ].join("\n");
    const r = checkDestaqueMinChars(md);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].destaque, 1);
    assert.equal(r.errors[0].min, 900);
    assert.ok(r.errors[0].chars < 900);
  });

  it("ok=false quando D2/D3 abaixo de 900 (caso 260507 D2=708, D3=679)", () => {
    const md = [
      makeDestaqueMd(1, "PRODUTO", 950),
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

  it("D1: 1 char abaixo do piso de 900 falha, no piso passa (boundary, janela única #12218)", () => {
    const base = checkDestaqueMinChars(makeDestaqueMd(1, "PRODUTO", 1000)).highlights[0].chars;
    // Ajusta o filler pra cair exatamente em 899 e 900 chars medidos.
    const atMin = checkDestaqueMinChars(makeDestaqueMd(1, "PRODUTO", 1000 + (900 - base)));
    assert.equal(atMin.highlights[0].chars, 900);
    assert.equal(atMin.ok, true);
    const below = checkDestaqueMinChars(makeDestaqueMd(1, "PRODUTO", 1000 + (899 - base)));
    assert.equal(below.highlights[0].chars, 899);
    assert.equal(below.ok, false);
  });

  it("D1 com ~950 chars passa no piso (antes da #12218 o piso do D1 era 1100)", () => {
    const r = checkDestaqueMinChars(makeDestaqueMd(1, "PRODUTO", 950));
    assert.ok(r.highlights[0].chars >= 900 && r.highlights[0].chars < 1100, String(r.highlights[0].chars));
    assert.equal(r.ok, true);
    assert.equal(r.highlights[0].min, 900);
  });

  it("piso é o mesmo nas 3 posições: o mesmo corpo dá o mesmo veredito em D1, D2 e D3 (#12218)", () => {
    for (const chars of [880, 950]) {
      const md = [
        makeDestaqueMd(1, "PRODUTO", chars),
        "---",
        makeDestaqueMd(2, "PESQUISA", chars),
        "---",
        makeDestaqueMd(3, "MERCADO", chars),
      ].join("\n");
      const r = checkDestaqueMinChars(md);
      assert.deepEqual(r.highlights.map((h) => h.min), [900, 900, 900]);
      const failing = r.errors.map((e) => e.destaque).sort();
      assert.ok(failing.length === 0 || failing.length === 3, `veredito por posição divergiu: ${JSON.stringify(failing)}`);
    }
  });

  it("ignora destaques numerados além de 3 (não tem min definido)", () => {
    const md = [
      makeDestaqueMd(1, "PRODUTO", 950),
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
  it("D1=D2=D3=900 — janela única (#6061, pedido do editor 24/08/2026)", () => {
    assert.equal(DESTAQUE_MIN_CHARS[1], 900);
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
        makeDestaqueMd(1, "PRODUTO", 950),
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
        makeDestaqueMd(1, "PRODUTO", 950),
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
