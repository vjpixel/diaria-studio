/**
 * test/stage-4-kit-html-size-invariant.test.ts (#6506)
 *
 * Guard determinístico contra o e-mail do canal Kit passar de 102 KB (limite
 * de clipping do Gmail). Severity é CONDICIONAL ao backend ativo em
 * `platform.config.json` (achado do self-review, #6506): `error` (bloqueia
 * o gate) só quando `publishing.newsletter.backend === "kit"` — pra
 * qualquer outro backend, é `warning` (não-bloqueante, mesma disciplina de
 * `checkNewsletterHtmlSize`). O backend real deste repo virou "kit" em
 * 04/09/2026 (#7388) — o teste abaixo, que roda sem override de rootDir,
 * reflete isso desde então: bloqueia de verdade, porque Kit é o canal de
 * envio em produção.
 *
 * Espelha o padrão de test/stage-4-newsletter-html-size-invariant.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkKitHtmlSize,
  KIT_HTML_SIZE_ERROR_BYTES,
  STAGE_4_RULES,
} from "../scripts/lib/invariant-checks/stage-4.ts";

function makeEditionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stage4-kit-html-size-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

function makeRootDir(backend?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "stage4-kit-html-size-root-"));
  if (backend !== undefined) {
    writeFileSync(
      join(dir, "platform.config.json"),
      JSON.stringify({ publishing: { newsletter: { backend } } }),
      "utf8",
    );
  }
  return dir;
}

function writeHtmlOfSize(path: string, bytes: number): void {
  // ASCII padding — 1 char = 1 byte, mantém o tamanho exato e previsível.
  writeFileSync(path, "x".repeat(bytes));
}

describe("checkKitHtmlSize (#6506)", () => {
  it("threshold é exatamente 102 KB (102 * 1024 bytes)", () => {
    assert.equal(KIT_HTML_SIZE_ERROR_BYTES, 102 * 1024);
  });

  it("arquivo ausente → [] (pré-render Kit ainda não rodou nesta retomada)", () => {
    const dir = makeEditionDir();
    const rootDir = makeRootDir("kit");
    try {
      assert.deepEqual(checkKitHtmlSize(dir, rootDir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("abaixo do threshold → []", () => {
    const dir = makeEditionDir();
    const rootDir = makeRootDir("kit");
    try {
      writeHtmlOfSize(resolve(dir, "_internal", "newsletter-final-kit.html"), 90_000);
      assert.deepEqual(checkKitHtmlSize(dir, rootDir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("exatamente no threshold → [] (limite é estritamente 'acima de', não 'a partir de')", () => {
    const dir = makeEditionDir();
    const rootDir = makeRootDir("kit");
    try {
      writeHtmlOfSize(resolve(dir, "_internal", "newsletter-final-kit.html"), KIT_HTML_SIZE_ERROR_BYTES);
      assert.deepEqual(checkKitHtmlSize(dir, rootDir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('acima do threshold, backend "kit" ativo → ERROR (bloqueia o gate)', () => {
    const dir = makeEditionDir();
    const rootDir = makeRootDir("kit");
    try {
      writeHtmlOfSize(resolve(dir, "_internal", "newsletter-final-kit.html"), 105_000);
      const violations = checkKitHtmlSize(dir, rootDir);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].rule, "kit-html-too-large");
      assert.equal(violations[0].severity, "error");
      assert.equal(violations[0].source_issue, "#6506");
      assert.match(violations[0].message, /105000 bytes/);
      assert.match(violations[0].message, /102\.5 KB/);
      assert.match(violations[0].message, /BLOQUEIA o gate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('acima do threshold, backend "beehiiv" (migração em curso, Kit ainda não é o canal real) → WARNING (não bloqueia)', () => {
    const dir = makeEditionDir();
    const rootDir = makeRootDir("beehiiv");
    try {
      writeHtmlOfSize(resolve(dir, "_internal", "newsletter-final-kit.html"), 105_000);
      const violations = checkKitHtmlSize(dir, rootDir);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].severity, "warning");
      assert.match(violations[0].message, /não é "kit"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("acima do threshold, platform.config.json ausente (fail-soft) → WARNING, nunca lança", () => {
    const dir = makeEditionDir();
    const rootDir = mkdtempSync(join(tmpdir(), "stage4-kit-html-size-noconfig-")); // sem platform.config.json
    try {
      writeHtmlOfSize(resolve(dir, "_internal", "newsletter-final-kit.html"), 105_000);
      const violations = checkKitHtmlSize(dir, rootDir);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].severity, "warning");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("STAGE_4_RULES registry (#6506)", () => {
  it("inclui kit-html-too-large", () => {
    const ids = STAGE_4_RULES.map((r) => r.id);
    assert.ok(ids.includes("kit-html-too-large"));
  });

  it("a regra registrada roda via run() e devolve severity condicional ao backend REAL do repo (sem override de rootDir)", () => {
    const rule = STAGE_4_RULES.find((r) => r.id === "kit-html-too-large");
    assert.ok(rule);
    const dir = makeEditionDir();
    try {
      writeHtmlOfSize(resolve(dir, "_internal", "newsletter-final-kit.html"), 110_000);
      const violations = rule!.run(dir);
      assert.equal(violations.length, 1);
      // backend real deste repo hoje é "kit" (platform.config.json, #7388) —
      // Kit é o canal de envio, então o excesso de tamanho bloqueia o gate.
      assert.equal(violations[0].severity, "error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
