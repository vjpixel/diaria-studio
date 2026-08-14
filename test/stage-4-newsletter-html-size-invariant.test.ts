/**
 * test/stage-4-newsletter-html-size-invariant.test.ts (#5232)
 *
 * Guard determinístico contra o crescimento silencioso de
 * `_internal/newsletter-final.html` — antes deste check, o único sinal era o
 * warning manual do Beehiiv no Stage 6 ("Your post is large and may get
 * clipped by Gmail"), visto só na hora de agendar.
 *
 * Espelha o padrão de test/stage-4-capture-failed-invariant.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkNewsletterHtmlSize,
  NEWSLETTER_HTML_SIZE_WARN_BYTES,
  STAGE_4_RULES,
} from "../scripts/lib/invariant-checks/stage-4.ts";

function makeEditionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stage4-html-size-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

function writeHtmlOfSize(path: string, bytes: number): void {
  // ASCII padding — 1 char = 1 byte, mantém o tamanho exato e previsível.
  writeFileSync(path, "x".repeat(bytes));
}

describe("checkNewsletterHtmlSize (#5232)", () => {
  it("arquivo ausente → [] (pré-render ainda não rodou nesta retomada)", () => {
    const dir = makeEditionDir();
    try {
      assert.deepEqual(checkNewsletterHtmlSize(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("abaixo do threshold (faixa histórica ~38-42KB) → [] (não alarma o normal)", () => {
    const dir = makeEditionDir();
    try {
      writeHtmlOfSize(resolve(dir, "_internal", "newsletter-final.html"), 40_000);
      assert.deepEqual(checkNewsletterHtmlSize(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exatamente no threshold → [] (limite é estritamente 'acima de', não 'a partir de')", () => {
    const dir = makeEditionDir();
    try {
      writeHtmlOfSize(resolve(dir, "_internal", "newsletter-final.html"), NEWSLETTER_HTML_SIZE_WARN_BYTES);
      assert.deepEqual(checkNewsletterHtmlSize(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("acima do threshold (regressão real, ex: salto 260813/260814) → warning com bytes/KB na mensagem", () => {
    const dir = makeEditionDir();
    try {
      // 47.607 bytes — o valor real observado na edição 260814 (#5232).
      writeHtmlOfSize(resolve(dir, "_internal", "newsletter-final.html"), 47_607);
      const violations = checkNewsletterHtmlSize(dir);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].rule, "newsletter-html-size");
      assert.equal(violations[0].severity, "warning");
      assert.equal(violations[0].source_issue, "#5232");
      assert.match(violations[0].message, /47607 bytes/);
      assert.match(violations[0].message, /46\.5 KB/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("STAGE_4_RULES registry (#5232)", () => {
  it("inclui newsletter-html-size", () => {
    const ids = STAGE_4_RULES.map((r) => r.id);
    assert.ok(ids.includes("newsletter-html-size"));
  });

  it("a regra registrada é severity warning via run() (nunca bloqueia o gate)", () => {
    const rule = STAGE_4_RULES.find((r) => r.id === "newsletter-html-size");
    assert.ok(rule);
    const dir = makeEditionDir();
    try {
      writeHtmlOfSize(resolve(dir, "_internal", "newsletter-final.html"), 50_000);
      const violations = rule!.run(dir);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].severity, "warning");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
