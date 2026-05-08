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
      makeDestaqueMd(1, "PRODUTO", 1100),
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
      makeDestaqueMd(1, "PRODUTO", 1100),
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

  it("ok=false quando D1 acima de 1200", () => {
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
    assert.equal(r.errors[0].max, 1200);
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
  it("D1=1200, D2=1000, D3=1000 conforme #964", () => {
    assert.equal(DESTAQUE_MAX_CHARS[1], 1200);
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
        makeDestaqueMd(1, "PRODUTO", 1100),
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
        makeDestaqueMd(1, "PRODUTO", 1100),
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
