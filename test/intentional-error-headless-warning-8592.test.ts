/**
 * test/intentional-error-headless-warning-8592.test.ts (#8592)
 *
 * `intentionalErrorHeadlessWarning` (scripts/lib/intentional-errors.ts) é o
 * núcleo puro do aviso pedido pela issue #8592: quando uma edição headless
 * (`scripts/run-edition-stages.ts`, que sempre roda cada stage com
 * `--no-gates`) termina o Stage 2 sem que o editor tenha declarado o erro
 * intencional, isso precisa aparecer como aviso — nunca bloquear o pipeline.
 *
 * Casos:
 *   - `_internal/intentional-error.json` ausente → aviso (nada declarado)
 *   - JSON com campos ainda `{PREENCHER...}` → aviso, citando os campos pendentes
 *   - `{"no_error": true}` → sem aviso (editor declarou explicitamente)
 *   - JSON completo (todos os 5 campos preenchidos, sem placeholder) → sem aviso
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { intentionalErrorHeadlessWarning } from "../scripts/lib/intentional-errors.ts";

function editionDirWithJson(record?: object): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-ie-headless-warning-"));
  if (record !== undefined) {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "intentional-error.json"), JSON.stringify(record));
  }
  return dir;
}

describe("#8592: intentionalErrorHeadlessWarning", () => {
  it("JSON ausente → aviso (nada declarado ainda)", () => {
    const dir = editionDirWithJson();
    try {
      const warn = intentionalErrorHeadlessWarning(dir);
      assert.ok(warn, "esperava aviso");
      assert.match(warn!, /sem erro intencional declarado/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("campos ainda placeholder {PREENCHER...} → aviso citando os campos pendentes", () => {
    const dir = editionDirWithJson({
      description: "{PREENCHER — o que o assinante deve identificar}",
      location: "{PREENCHER — ex: DESTAQUE 2, parágrafo 1}",
      category: "{PREENCHER — factual|ortografico|...}",
      correct_value: "{PREENCHER — valor correto}",
      wrong_value: "{PREENCHER — grafia/valor ERRADO plantado no texto}",
      reveal: "{PREENCHER — prosa 1ª pessoa para o reveal}",
    });
    try {
      const warn = intentionalErrorHeadlessWarning(dir);
      assert.ok(warn, "esperava aviso");
      assert.match(warn!, /description/);
      assert.match(warn!, /reveal/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("campos parcialmente preenchidos (alguns placeholder, outros não) → aviso só com os pendentes", () => {
    const dir = editionDirWithJson({
      description: "Uma marca conhecida aparece com o nome errado.",
      location: "RADAR",
      category: "ortografico",
      correct_value: "{PREENCHER — valor correto}",
      reveal: "{PREENCHER — prosa 1ª pessoa para o reveal}",
    });
    try {
      const warn = intentionalErrorHeadlessWarning(dir);
      assert.ok(warn, "esperava aviso");
      assert.match(warn!, /correct_value/);
      assert.match(warn!, /reveal/);
      assert.doesNotMatch(warn!, /\bdescription\b.*pendente|pendente.*\bdescription\b/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("{no_error: true} → sem aviso (editor declarou explicitamente que não há erro)", () => {
    const dir = editionDirWithJson({ no_error: true });
    try {
      assert.equal(intentionalErrorHeadlessWarning(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("JSON completo, sem placeholder → sem aviso", () => {
    const dir = editionDirWithJson({
      description: "Uma marca conhecida aparece com o nome errado.",
      location: "RADAR",
      category: "ortografico",
      correct_value: "Anthropic",
      wrong_value: "Anthropik",
      reveal: "Na última edição, escrevi \"Anthropik\" onde o correto é \"Anthropic\".",
    });
    try {
      assert.equal(intentionalErrorHeadlessWarning(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
