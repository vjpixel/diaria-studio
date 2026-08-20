/**
 * test/render-warnings-invariant-4673.test.ts (#4673, regressão #633)
 *
 * `divulgacao_box_dropped_no_gap` (#4624) e `whatsapp_share_no_d1` eram
 * fire-and-forget: `render-newsletter-html.ts` só logava via `console.error`,
 * o CLI sempre saía 0, e nada no Stage 4 (o gate humano que o editor de fato
 * revisa antes de publicar) grepava stderr por esses eventos.
 *
 * Fix (#4673): `renderHTML()`/`getRenderWarnings()` (scripts/lib/newsletter-
 * render-html.ts) coletam os eventos desta chamada; o CLI persiste em
 * `_internal/render-warnings.json` a cada render (sempre — mesmo array
 * vazio, pra nunca deixar entrada STALE sobreviver depois que a causa foi
 * corrigida); `checkRenderWarnings` (scripts/lib/invariant-checks/stage-4.ts)
 * lê esse arquivo e surfaced os eventos no gate como warning (nunca bloqueia
 * — mesmo padrão de `image-crop-warn`/`card-4x5-upload-missing`).
 *
 * Arquivo separado (padrão já estabelecido em test/card-4x5-invariants.test.ts,
 * test/stage-4-box-divulgacao-alt-invariant.test.ts etc.) — evita tocar o
 * describe block já-grande de test/check-invariants-stage.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRenderWarnings } from "../scripts/lib/invariant-checks/stage-4.ts";
import { getRulesForStage } from "../scripts/lib/invariant-checks/index.ts";

function makeFixtureEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-render-warnings-invariant-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

function writeWarningsFile(dir: string, warnings: unknown[]): void {
  writeFileSync(
    join(dir, "_internal", "render-warnings.json"),
    JSON.stringify({ generated_at: new Date().toISOString(), warnings }, null, 2),
  );
}

describe("registry — render-warnings-consumed está registrada no stage 4 (#4673)", () => {
  it("aparece em getRulesForStage(4) com o source_issue correto", () => {
    const rule = getRulesForStage(4).find((r) => r.id === "render-warnings-consumed");
    assert.ok(rule, "esperava rule 'render-warnings-consumed' no stage 4");
    assert.equal(rule!.stage, 4);
    assert.equal(rule!.source_issue, "#4673");
  });
});

describe("checkRenderWarnings — Stage 4, warning-only (#4673)", () => {
  it("arquivo ausente (edição pré-#4673, ou render ainda não rodou) → nenhuma violação", () => {
    const dir = makeFixtureEdition();
    try {
      assert.deepEqual(checkRenderWarnings(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("edição normal — nada perdido — warnings: [] → nenhuma violação (não produz ruído)", () => {
    const dir = makeFixtureEdition();
    try {
      writeWarningsFile(dir, []);
      assert.deepEqual(checkRenderWarnings(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("divulgacao_box_dropped_no_gap → 1 violação warning, rule/slot/source_issue corretos", () => {
    const dir = makeFixtureEdition();
    try {
      writeWarningsFile(dir, [
        { event: "divulgacao_box_dropped_no_gap", edition: "260806", slot: 3 },
      ]);
      const violations = checkRenderWarnings(dir);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].rule, "divulgacao-box-dropped-no-gap");
      assert.equal(violations[0].severity, "warning", "nunca deve bloquear o gate — conteúdo comercial some, mas a decisão de como corrigir é editorial");
      assert.equal(violations[0].source_issue, "#4673");
      assert.match(violations[0].message, /slot 3/);
      assert.match(violations[0].message, /COMERCIAL/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("whatsapp_share_no_d1 → 1 violação warning, rule/source_issue corretos", () => {
    const dir = makeFixtureEdition();
    try {
      writeWarningsFile(dir, [{ event: "whatsapp_share_no_d1", edition: "260806" }]);
      const violations = checkRenderWarnings(dir);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].rule, "whatsapp-share-no-d1");
      assert.equal(violations[0].severity, "warning");
      assert.equal(violations[0].source_issue, "#4673");
      assert.match(violations[0].message, /WhatsApp/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#5152: whatsapp_share_d1_mismatch → 1 violação warning, rule/source_issue corretos", () => {
    const dir = makeFixtureEdition();
    try {
      writeWarningsFile(dir, [{ event: "whatsapp_share_d1_mismatch", edition: "260806" }]);
      const violations = checkRenderWarnings(dir);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].rule, "whatsapp-share-d1-mismatch");
      assert.equal(violations[0].severity, "warning", "nunca deve bloquear o gate — mesmo padrão warning-only dos demais eventos");
      assert.equal(violations[0].source_issue, "#5152");
      assert.match(violations[0].message, /WhatsApp/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#5817: convite_amigo_snippet_missing → 1 violação warning, rule/source_issue corretos", () => {
    const dir = makeFixtureEdition();
    try {
      writeWarningsFile(dir, [{ event: "convite_amigo_snippet_missing", edition: "260806" }]);
      const violations = checkRenderWarnings(dir);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].rule, "convite-amigo-snippet-missing");
      assert.equal(violations[0].severity, "warning", "nunca deve bloquear o gate — mesmo padrão warning-only dos demais eventos");
      assert.equal(violations[0].source_issue, "#5817");
      assert.match(violations[0].message, /Convide um amigo/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ambos eventos na mesma edição → 2 violações, uma por evento", () => {
    const dir = makeFixtureEdition();
    try {
      writeWarningsFile(dir, [
        { event: "divulgacao_box_dropped_no_gap", edition: "260806", slot: 2 },
        { event: "whatsapp_share_no_d1", edition: "260806" },
      ]);
      const violations = checkRenderWarnings(dir);
      assert.equal(violations.length, 2);
      assert.deepEqual(
        violations.map((v) => v.rule).sort(),
        ["divulgacao-box-dropped-no-gap", "whatsapp-share-no-d1"],
      );
      assert.ok(violations.every((v) => v.severity === "warning"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("JSON inválido no arquivo → falha graciosamente, nenhuma violação (não trava o gate por um arquivo corrompido)", () => {
    const dir = makeFixtureEdition();
    try {
      writeFileSync(join(dir, "_internal", "render-warnings.json"), "{ isto não é json válido");
      assert.deepEqual(checkRenderWarnings(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
