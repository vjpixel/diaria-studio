/**
 * test/lint-newsletter-md-erro-intencional-placeholder.test.ts (#2078, estendido #3489)
 *
 * Verifica que o check erro-intencional-placeholder detecta o placeholder
 * {PREENCHER_NARRATIVA_DO_ERRO} deixado no MD antes de publicar — e, desde
 * #3489, também detecta prosa que SUBSTITUIU o placeholder mas é inválida
 * (corrompida por auto-concatenação, genérica, ou catalog-shaped). O check
 * original só pegava o placeholder literal; prosa corrompida (ex: fallback
 * não-idempotente do #3485 produzindo "Nessa edição, Na última edição,
 * escrevi...") passava silenciosamente pelo gate do Stage 5.
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

  it("#3489: falha quando narrativa é auto-concatenação corrompida (assinatura exata do #3485)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-placeholder-selfconcat-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(
        mdPath,
        [
          "**ERRO INTENCIONAL**",
          "",
          "Na última edição, não havia erro intencional: quem respondeu que não há erro, acertou.",
          "",
          // Cenário de falha real observado no #3485/#3489: fallback não-idempotente
          // colava o reveal PASSADO ("Na última edição, ...") dentro da declaração
          // CORRENTE ("Nessa edição, ..."). Não contém o placeholder literal, mas é
          // texto agramatical e auto-contraditório.
          "Nessa edição, Na última edição, escrevi que a Acme foi fundada em 2020, quando na verdade foi em 2022.",
          "",
          "---",
          "",
          "**ASSINE**",
          "Texto.",
        ].join("\n"),
        "utf8",
      );
      const r = runLint(["--check", "erro-intencional-placeholder", "--md", mdPath]);
      assert.equal(r.status, 1, "deve retornar exit 1 quando narrativa é auto-concatenação corrompida");
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false);
      assert.match(out.label ?? "", /auto-concatenação|#3485/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#3489: falha quando narrativa é o convite genérico do sorteio (não uma declaração real)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-placeholder-generic-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(
        mdPath,
        [
          "**ERRO INTENCIONAL**",
          "",
          "Na última edição, não havia erro intencional: quem respondeu que não há erro, acertou.",
          "",
          "Nessa edição, há um erro proposital escondido em um dos destaques. Responda este e-mail com a correção para concorrer ao sorteio.",
          "",
          "---",
          "",
          "**ASSINE**",
          "Texto.",
        ].join("\n"),
        "utf8",
      );
      const r = runLint(["--check", "erro-intencional-placeholder", "--md", mdPath]);
      assert.equal(r.status, 1, "deve retornar exit 1 quando narrativa é o convite genérico");
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false);
      assert.match(out.label ?? "", /genérica/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#3489: falha quando narrativa é catalog-shaped (label interno 'DESTAQUE N')", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-placeholder-catalog-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(
        mdPath,
        [
          "**ERRO INTENCIONAL**",
          "",
          "Na última edição, não havia erro intencional: quem respondeu que não há erro, acertou.",
          "",
          "Nessa edição, DESTAQUE 2 lista o Spotify entre os assistentes de IA que teriam evoluído.",
          "",
          "---",
          "",
          "**ASSINE**",
          "Texto.",
        ].join("\n"),
        "utf8",
      );
      const r = runLint(["--check", "erro-intencional-placeholder", "--md", mdPath]);
      assert.equal(r.status, 1, "deve retornar exit 1 quando narrativa é catalog-shaped");
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false);
      assert.match(out.label ?? "", /catalog-shaped/i);
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
