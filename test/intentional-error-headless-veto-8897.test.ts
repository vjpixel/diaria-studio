/**
 * intentional-error-headless-veto-8897.test.ts (#8897)
 *
 * Regressão: no caminho `--no-gates`, categoria de risco de desinformação
 * (numeric/factual/data, #2149) deixa de ser só warn e vira BLOQUEANTE —
 * sem editor pra ler o aviso, a seleção automática publicaria a estatística
 * plantada sem revisão (achado ao vivo, edição 260928: "65%" onde a fonte
 * dizia "60%").
 *
 * Caminho COM gate humano (headless omitido/false) precisa continuar
 * warn-only — é o comportamento que já funciona hoje (editor troca a
 * categoria/valor no próprio gate).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkIntentionalErrorSafety,
} from "../scripts/lib/lint-checks/intentional-error.ts";

describe("checkIntentionalErrorSafety — headless veto (#8897)", () => {
  it("category=numeric + headless=true → blocking=true", () => {
    const result = checkIntentionalErrorSafety("numeric", { headless: true });
    assert.equal(result.safe, false);
    assert.equal(result.blocking, true, "headless deve escalar pra bloqueio");
    assert.ok(result.warn?.includes("#8897"));
  });

  it("category=numeric sem headless (default) → blocking indefinido (warn-only, comportamento pré-existente)", () => {
    const result = checkIntentionalErrorSafety("numeric");
    assert.equal(result.safe, false);
    assert.ok(!result.blocking, "sem headless, não deve bloquear — caminho com gate humano continua warn-only");
  });

  it("category=numeric + headless=false (explícito) → warn-only", () => {
    const result = checkIntentionalErrorSafety("numeric", { headless: false });
    assert.equal(result.safe, false);
    assert.ok(!result.blocking);
  });

  it("category segura (attribution) + headless=true → safe=true, sem bloqueio", () => {
    const result = checkIntentionalErrorSafety("attribution", { headless: true });
    assert.equal(result.safe, true);
  });

  it("category=data + headless=true → blocking=true", () => {
    const result = checkIntentionalErrorSafety("data", { headless: true });
    assert.equal(result.safe, false);
    assert.equal(result.blocking, true);
  });
});

describe("intentional-error-flagged CLI — --headless true escala pra exit 1 (#8897)", () => {
  function makeEdition(category: string): string {
    const dir = mkdtempSync(join(tmpdir(), "diaria-8897-"));
    const internalDir = join(dir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    writeFileSync(
      join(internalDir, "intentional-error.json"),
      JSON.stringify({
        description: "descrição de teste",
        location: "DESTAQUE 1, parágrafo 1",
        category,
        correct_value: "60%",
      }),
    );
    const mdPath = join(dir, "02-reviewed.md");
    writeFileSync(mdPath, "# edição de teste\n");
    return mdPath;
  }

  const cliPath = join(
    process.cwd(),
    "scripts",
    "lint-newsletter-md.ts",
  );

  it("categoria numeric + --headless true → exit 1", () => {
    const mdPath = makeEdition("numeric");
    try {
      assert.throws(() => {
        execFileSync(
          "npx",
          [
            "tsx",
            cliPath,
            "--check",
            "intentional-error-flagged",
            "--md",
            mdPath,
            "--headless",
            "true",
          ],
          { stdio: "pipe" },
        );
      });
    } finally {
      rmSync(join(mdPath, ".."), { recursive: true, force: true });
    }
  });

  it("categoria numeric SEM --headless → exit 0 (warn-only, comportamento pré-existente)", () => {
    const mdPath = makeEdition("numeric");
    try {
      execFileSync(
        "npx",
        ["tsx", cliPath, "--check", "intentional-error-flagged", "--md", mdPath],
        { stdio: "pipe" },
      );
      // Sem throw = exit 0. Sucesso.
    } finally {
      rmSync(join(mdPath, ".."), { recursive: true, force: true });
    }
  });

  it("categoria segura (ortografico) + --headless true → exit 0", () => {
    const mdPath = makeEdition("ortografico");
    try {
      execFileSync(
        "npx",
        [
          "tsx",
          cliPath,
          "--check",
          "intentional-error-flagged",
          "--md",
          mdPath,
          "--headless",
          "true",
        ],
        { stdio: "pipe" },
      );
    } finally {
      rmSync(join(mdPath, ".."), { recursive: true, force: true });
    }
  });
});
