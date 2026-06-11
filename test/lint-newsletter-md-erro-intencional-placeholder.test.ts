/**
 * test/lint-newsletter-md-erro-intencional-placeholder.test.ts (#2078)
 *
 * Verifica que o check erro-intencional-placeholder detecta o placeholder
 * {PREENCHER_NARRATIVA_DO_ERRO} deixado no MD antes de publicar.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

function runLint(args: string[]) {
  const projectRoot = join(import.meta.dirname, "..");
  const scriptPath = join(projectRoot, "scripts", "lint-newsletter-md.ts");
  return spawnSync(
    process.execPath,
    ["--import", "tsx", scriptPath, ...args],
    { cwd: projectRoot, encoding: "utf8" },
  );
}

describe("lint-newsletter-md --check erro-intencional-placeholder (#2078)", () => {
  it("falha quando placeholder {PREENCHER_NARRATIVA_DO_ERRO} ainda presente", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-placeholder-fail-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(
        mdPath,
        [
          "**ERRO INTENCIONAL**",
          "",
          "Na última edição, não havia erro intencional: quem respondeu que não há erro, acertou.",
          "",
          "Nessa edição, {PREENCHER_NARRATIVA_DO_ERRO}.",
          "",
          "---",
          "",
          "**ASSINE**",
          "Texto.",
        ].join("\n"),
        "utf8",
      );
      const r = runLint(["--check", "erro-intencional-placeholder", "--md", mdPath]);
      assert.equal(r.status, 1, "deve retornar exit 1 quando placeholder presente");
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false);
      assert.match(out.label ?? "", /PREENCHER_NARRATIVA_DO_ERRO/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passa quando placeholder foi substituído pelo editor", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-placeholder-ok-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(
        mdPath,
        [
          "**ERRO INTENCIONAL**",
          "",
          "Na última edição, não havia erro intencional: quem respondeu que não há erro, acertou.",
          "",
          "Nessa edição, escrevi que o modelo foi lançado em 2024, mas o correto é 2025.",
          "",
          "---",
          "",
          "**ASSINE**",
          "Texto.",
        ].join("\n"),
        "utf8",
      );
      const r = runLint(["--check", "erro-intencional-placeholder", "--md", mdPath]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passa quando seção ERRO INTENCIONAL não existe no MD (edição sem o bloco)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-placeholder-noblock-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(
        mdPath,
        ["**ASSINE**", "", "Texto.", ""].join("\n"),
        "utf8",
      );
      const r = runLint(["--check", "erro-intencional-placeholder", "--md", mdPath]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
