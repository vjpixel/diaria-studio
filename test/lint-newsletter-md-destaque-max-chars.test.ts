/**
 * test/lint-newsletter-md-destaque-max-chars.test.ts (#964)
 *
 * Cobre `checkDestaqueMaxChars` e `--check destaque-max-chars` CLI.
 * Caso real 260508: D2=1409 — passou despercebido porque max era só warning.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  checkDestaqueMaxChars,
  DESTAQUE_MAX_CHARS,
} from "../scripts/lint-newsletter-md.ts";

function makeDestaqueMd(num: number, category: string, chars: number): string {
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

describe("checkDestaqueMaxChars (#964) — helper puro", () => {
  it("ok=true quando todos destaques estão dentro do máximo", () => {
    const md = [
      makeDestaqueMd(1, "PRODUTO", 950),
      "---",
      makeDestaqueMd(2, "PESQUISA", 950),
      "---",
      makeDestaqueMd(3, "MERCADO", 950),
    ].join("\n");
    const r = checkDestaqueMaxChars(md);
    assert.equal(r.ok, true, JSON.stringify(r.highlights));
    assert.equal(r.errors.length, 0);
  });

  it("ok=false quando D2 acima de 1000 (caso 260508 D2=1409)", () => {
    const md = [
      makeDestaqueMd(1, "PRODUTO", 950),
      "---",
      makeDestaqueMd(2, "PESQUISA", 1409),
      "---",
      makeDestaqueMd(3, "MERCADO", 950),
    ].join("\n");
    const r = checkDestaqueMaxChars(md);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].destaque, 2);
    assert.equal(r.errors[0].max, 1000);
    assert.ok(r.errors[0].chars > 1000);
  });

  it("ok=false quando D1 acima de 1000 (janela única #6061)", () => {
    const md = [
      makeDestaqueMd(1, "PRODUTO", 1500),
      "---",
      makeDestaqueMd(2, "PESQUISA", 950),
      "---",
      makeDestaqueMd(3, "MERCADO", 950),
    ].join("\n");
    const r = checkDestaqueMaxChars(md);
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].destaque, 1);
    assert.equal(r.errors[0].max, 1000);
  });

  it("D1 com ~1150 chars é reprovado; D1 com ~950 passa (regressão #12218, desfaz a #11321)", () => {
    const over = checkDestaqueMaxChars(makeDestaqueMd(1, "PRODUTO", 1130));
    assert.ok(over.highlights[0].chars > 1000 && over.highlights[0].chars <= 1200, String(over.highlights[0].chars));
    assert.equal(over.ok, false);
    assert.equal(over.errors[0].destaque, 1);
    assert.equal(over.errors[0].max, 1000);
    const ok = checkDestaqueMaxChars(makeDestaqueMd(1, "PRODUTO", 930));
    assert.ok(ok.highlights[0].chars >= 900 && ok.highlights[0].chars <= 1000, String(ok.highlights[0].chars));
    assert.equal(ok.ok, true);
  });

  it("D1: 1000 chars passa, 1001 falha (boundary, janela única #12218)", () => {
    const base = checkDestaqueMaxChars(makeDestaqueMd(1, "PRODUTO", 1000)).highlights[0].chars;
    const atMax = checkDestaqueMaxChars(makeDestaqueMd(1, "PRODUTO", 1000 + (1000 - base)));
    assert.equal(atMax.highlights[0].chars, 1000);
    assert.equal(atMax.ok, true);
    const above = checkDestaqueMaxChars(makeDestaqueMd(1, "PRODUTO", 1000 + (1001 - base)));
    assert.equal(above.highlights[0].chars, 1001);
    assert.equal(above.ok, false);
  });

  it("teto é o mesmo nas 3 posições: o mesmo corpo estoura em D1, D2 e D3 (#12218)", () => {
    const md = [
      makeDestaqueMd(1, "PRODUTO", 1130),
      "---",
      makeDestaqueMd(2, "PESQUISA", 1130),
      "---",
      makeDestaqueMd(3, "MERCADO", 1130),
    ].join("\n");
    const r = checkDestaqueMaxChars(md);
    assert.deepEqual(r.errors.map((e) => e.destaque).sort(), [1, 2, 3]);
    assert.ok(r.highlights.every((h) => h.max === 1000));
  });

  it("D2 com exatos 1000 chars: passa (boundary)", () => {
    const md = makeDestaqueMd(2, "PESQUISA", 999);
    const r = checkDestaqueMaxChars(md);
    if (r.highlights[0].chars <= 1000) {
      assert.equal(r.ok, true);
    } else {
      assert.equal(r.ok, false);
    }
  });

  it("MD sem destaques: ok=true (nada pra checar)", () => {
    const md = "Apenas texto sem destaques.";
    const r = checkDestaqueMaxChars(md);
    assert.equal(r.ok, true);
    assert.equal(r.highlights.length, 0);
  });
});

describe("DESTAQUE_MAX_CHARS constants", () => {
  it("D1=D2=D3=1000 — janela única (#6061, pedido do editor 24/08/2026)", () => {
    assert.equal(DESTAQUE_MAX_CHARS[1], 1000);
    assert.equal(DESTAQUE_MAX_CHARS[2], 1000);
    assert.equal(DESTAQUE_MAX_CHARS[3], 1000);
  });
});

describe("--check destaque-max-chars CLI (#964)", () => {
  function runCli(args: string[]) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "lint-newsletter-md.ts");
    return spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, ...args],
      { cwd: projectRoot, encoding: "utf8" },
    );
  }

  it("exit 0 quando todos destaques estão dentro do máximo", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-max-ok-"));
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
      const r = runCli(["--check", "destaque-max-chars", "--md", mdPath]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 1 quando D2 acima de 1000", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-max-fail-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const md = [
        makeDestaqueMd(1, "PRODUTO", 950),
        "---",
        makeDestaqueMd(2, "PESQUISA", 1500),
        "---",
        makeDestaqueMd(3, "MERCADO", 950),
      ].join("\n");
      writeFileSync(mdPath, md, "utf8");
      const r = runCli(["--check", "destaque-max-chars", "--md", mdPath]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /D2.*acima do máximo de 1000/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
