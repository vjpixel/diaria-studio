/**
 * test/kit-draft-freshness-9428.test.ts (#9428)
 *
 * Regressão: na edição 261002 o editor corrigiu `02-reviewed.md` 12 min depois
 * de `publish-newsletter-kit.ts` criar o rascunho, e nada no pipeline acusou
 * que o broadcast/e-mail de teste estavam com o texto velho. Aqui: helper puro
 * (`kit-draft-freshness.ts`) + registro/casos-limite da regra `kit-draft-fresh`.
 * Os cenários que exigem render real (publish → edição → warning → re-run)
 * estão em `test/publish-newsletter-kit.test.ts`, que tem a fixture de edição.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KIT_DRAFT_SOURCE_FILES,
  kitContentHash,
  changedSourceFiles,
  computeKitDraftSourceHashes,
  changedSourceFilesOnDisk,
  sha256OfFile,
} from "../scripts/lib/kit-draft-freshness.ts";
import { checkKitDraftFresh, STAGE_6_RULES } from "../scripts/lib/invariant-checks/stage-6.ts";

function makeEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-draft-fresh-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), "Vencedora: Melina R.\n", "utf8");
  writeFileSync(join(dir, "01-eia.md"), "eia\n", "utf8");
  return dir;
}

function writeStateRaw(dir: string, raw: string): void {
  writeFileSync(join(dir, "_internal", "newsletter-kit-published.json"), raw, "utf8");
}

describe("kit-draft-freshness helpers (#9428)", () => {
  it("diagnóstico cobre os 3 insumos diretos do content", () => {
    assert.deepEqual([...KIT_DRAFT_SOURCE_FILES], ["02-reviewed.md", "01-eia.md", "06-public-images.json"]);
  });

  it("kitContentHash é determinístico e sensível a cada campo", () => {
    const h = kitContentHash("s", "p", "<p>x</p>");
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(h, kitContentHash("s", "p", "<p>x</p>"));
    assert.notEqual(h, kitContentHash("s2", "p", "<p>x</p>"));
    assert.notEqual(h, kitContentHash("s", "p2", "<p>x</p>"));
    assert.notEqual(h, kitContentHash("s", "p", "<p>y</p>"));
    assert.notEqual(kitContentHash("ab", "", "c"), kitContentHash("a", "b", "c"), "separador evita colisão");
  });

  it("sha256OfFile: ausente ou diretório → null, nunca lança", () => {
    const dir = makeEdition();
    try {
      assert.equal(sha256OfFile(join(dir, "nao-existe")), null);
      assert.equal(sha256OfFile(join(dir, "_internal")), null);
      assert.match(sha256OfFile(join(dir, "02-reviewed.md")) ?? "", /^[0-9a-f]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("changedSourceFiles: só chaves registradas, criado/apagado contam", () => {
    assert.deepEqual(changedSourceFiles({ x: "1" }, { x: "1" }), []);
    assert.deepEqual(changedSourceFiles({ x: "1", y: null }, { x: "2", y: null }), ["x"]);
    assert.deepEqual(changedSourceFiles({ y: null }, { y: "3" }), ["y"]);
    assert.deepEqual(changedSourceFiles(undefined, { x: "1" }), []);
  });

  it("changedSourceFilesOnDisk detecta arquivo apagado depois do publish", () => {
    const dir = makeEdition();
    try {
      const recorded = computeKitDraftSourceHashes(dir);
      unlinkSync(join(dir, "01-eia.md"));
      assert.deepEqual(changedSourceFilesOnDisk(dir, recorded), ["01-eia.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("invariante kit-draft-fresh — registro e casos-limite (#9428)", () => {
  it("está registrada no Stage 6", () => {
    const entry = STAGE_6_RULES.find((r) => r.id === "kit-draft-fresh");
    assert.ok(entry);
    assert.equal(entry!.stage, 6);
    assert.equal(entry!.source_issue, "#9428");
  });

  it("backend beehiiv → nunca acusa", () => {
    const dir = makeEdition();
    try {
      writeStateRaw(dir, JSON.stringify({ broadcast_id: 1, content_hash: "deadbeef" }));
      assert.deepEqual(checkKitDraftFresh(dir, { backend: "beehiiv" }), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("estado ausente, ilegível, JSON null/array, ou legado sem content_hash → sem violação e sem lançar", () => {
    const dir = makeEdition();
    try {
      assert.deepEqual(checkKitDraftFresh(dir, { backend: "kit" }), [], "ausente: scheduled-at-present já acusa");
      for (const raw of ["{nope", "null", "[]", "42", JSON.stringify({ broadcast_id: 1, status: "draft" })]) {
        writeStateRaw(dir, raw);
        assert.deepEqual(checkKitDraftFresh(dir, { backend: "kit" }), [], `estado ${raw}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-render falha (02-reviewed.md inválido) → warning com o erro, não crash", () => {
    const dir = makeEdition();
    try {
      writeStateRaw(dir, JSON.stringify({ broadcast_id: 1, content_hash: "abc" }));
      const v = checkKitDraftFresh(dir, { backend: "kit" });
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "kit-draft-fresh");
      assert.equal(v[0].severity, "warning");
      assert.match(v[0].message, /não foi possível re-renderizar/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
