/**
 * #8592: Stage 2 headless (--no-gates) — narrativa padrão no bloco e aviso
 * claro quando os 5 campos do JSON seguem {PREENCHER}.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  insertOrUpdateSection,
  renderSection,
  HEADLESS_DEFAULT_NARRATIVE_LINE,
  extractRawCurrentNarrative,
} from "../scripts/render-erro-intencional.ts";
import {
  checkIntentionalErrorPendingHeadless,
  checkStage2Invariants,
} from "../scripts/check-stage2-invariants.ts";

const MD = "# T\n\nDESTAQUE 1\n\n---\n\nSORTEIO\n\nx\n";

describe("#8592 narrativa padrão em headless", () => {
  it("renderSection headless grava a narrativa padrão, sem placeholder", () => {
    const out = renderSection(null, null, { headlessDefault: true });
    assert.match(out, /Nessa edição também tem um erro plantado, ache e responda pra concorrer\./);
    assert.doesNotMatch(out, /PREENCHER_NARRATIVA_DO_ERRO/);
  });
  it("sem headless mantém o placeholder (comportamento interativo)", () => {
    assert.match(renderSection(null, null), /\{PREENCHER_NARRATIVA_DO_ERRO\}/);
  });
  it("insertOrUpdateSection headless é idempotente e não planta erro", () => {
    const a = insertOrUpdateSection(MD, null, { headlessDefault: true }).md;
    const b = insertOrUpdateSection(a, null, { headlessDefault: true }).md;
    assert.equal(a, b);
    assert.ok(a.includes(HEADLESS_DEFAULT_NARRATIVE_LINE));
    assert.doesNotMatch(a, /PREENCHER/);
    // sem vírgula após "edição": não é lida como declaração específica
    assert.equal(extractRawCurrentNarrative(a), null);
  });
});

describe("#8592 invariante Stage 2 headless", () => {
  function mk(record: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "s2-8592-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "intentional-error.json"), JSON.stringify(record));
    return dir;
  }
  const P = "{PREENCHER — x}";
  const pending = { description: P, location: P, category: P, correct_value: P, wrong_value: P, reveal: P };

  it("acusa com a ação quando os 5 campos seguem {PREENCHER}", () => {
    const dir = mk(pending);
    try {
      const r = checkIntentionalErrorPendingHeadless(dir);
      assert.equal(r.ok, false);
      assert.match(r.label!, /proponha e plante um erro em 1 clique no gate 4/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("não acusa quando os campos foram preenchidos", () => {
    const dir = mk({ description: "d", location: "l", category: "ortografico", correct_value: "c", wrong_value: "w" });
    try {
      assert.equal(checkIntentionalErrorPendingHeadless(dir).ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("checkStage2Invariants só emite warnings com headless e não muda o ok", async () => {
    const dir = mk(pending);
    try {
      const cachePath = join(dir, "nocache.json");
      const h = await checkStage2Invariants(dir, { headless: true, cachePath });
      assert.ok(h.warnings?.some((w) => /intentional_error_pending_headless/.test(w)));
      const n = await checkStage2Invariants(dir, { cachePath });
      assert.equal(n.warnings, undefined);
      assert.equal(h.ok, n.ok);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
