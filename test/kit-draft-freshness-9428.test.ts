/**
 * test/kit-draft-freshness-9428.test.ts (#9428)
 *
 * Regressão: na edição 261002 o editor corrigiu `02-reviewed.md` 12 min depois
 * de `publish-newsletter-kit.ts` criar o rascunho, e nada no pipeline acusou
 * que o broadcast/e-mail de teste estavam com o texto velho. Cobre o helper
 * puro (`kit-draft-freshness.ts`) e a regra `kit-draft-fresh` do Stage 6.
 * A integração com o publisher (hash gravado no `main()`) está em
 * `test/publish-newsletter-kit.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KIT_DRAFT_SOURCE_FILES,
  compareSourceHashes,
  computeKitDraftSourceHashes,
  checkKitDraftFreshness,
} from "../scripts/lib/kit-draft-freshness.ts";
import { checkKitDraftFresh, STAGE_6_RULES } from "../scripts/lib/invariant-checks/stage-6.ts";

function makeEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-draft-fresh-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), "Vencedora: Melina R.\n", "utf8");
  writeFileSync(join(dir, "01-eia.md"), "eia\n", "utf8");
  return dir;
}

function writeState(dir: string, extra: Record<string, unknown>): void {
  writeFileSync(
    join(dir, "_internal", "newsletter-kit-published.json"),
    JSON.stringify({ broadcast_id: 1, subject: "s", preview_text: "p", status: "draft", ...extra }),
    "utf8",
  );
}

describe("kit-draft-freshness (#9428)", () => {
  it("cobre os 3 insumos do content do broadcast", () => {
    assert.deepEqual([...KIT_DRAFT_SOURCE_FILES], ["02-reviewed.md", "01-eia.md", "06-public-images.json"]);
  });

  it("hash estável; arquivo ausente vira null", () => {
    const dir = makeEdition();
    try {
      const a = computeKitDraftSourceHashes(dir);
      const b = computeKitDraftSourceHashes(dir);
      assert.deepEqual(a, b);
      assert.equal(a["06-public-images.json"], null);
      assert.match(a["02-reviewed.md"] ?? "", /^[0-9a-f]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compareSourceHashes: fresh / stale / unknown", () => {
    assert.equal(compareSourceHashes({ x: "1" }, { x: "1" }).status, "fresh");
    assert.deepEqual(compareSourceHashes({ x: "1", y: null }, { x: "2", y: null }), { status: "stale", changed: ["x"] });
    assert.deepEqual(compareSourceHashes({ y: null }, { y: "3" }), { status: "stale", changed: ["y"] }, "arquivo criado depois");
    assert.equal(compareSourceHashes(undefined, {}).status, "unknown");
    assert.equal(compareSourceHashes({}, {}).status, "unknown");
  });

  it("checkKitDraftFreshness detecta arquivo apagado depois do publish", () => {
    const dir = makeEdition();
    try {
      const recorded = computeKitDraftSourceHashes(dir);
      unlinkSync(join(dir, "01-eia.md"));
      assert.deepEqual(checkKitDraftFreshness(dir, recorded), { status: "stale", changed: ["01-eia.md"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("invariante kit-draft-fresh (Stage 6, #9428)", () => {
  it("está registrada no Stage 6 como warning-level", () => {
    const entry = STAGE_6_RULES.find((r) => r.id === "kit-draft-fresh");
    assert.ok(entry);
    assert.equal(entry!.stage, 6);
    assert.equal(entry!.source_issue, "#9428");
  });

  it("02-reviewed.md editado depois do publish → warning acionável", () => {
    const dir = makeEdition();
    try {
      writeState(dir, { source_hashes: computeKitDraftSourceHashes(dir), source_hashed_at: "2026-10-01T22:42:00Z" });
      assert.deepEqual(checkKitDraftFresh(dir, "kit"), []);
      writeFileSync(join(dir, "02-reviewed.md"), "Vencedora: Luciana B.\n", "utf8");
      const v = checkKitDraftFresh(dir, "kit");
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
      assert.match(v[0].message, /02-reviewed\.md mudou/);
      assert.match(v[0].message, /2026-10-01T22:42:00Z/);
      assert.match(v[0].message, /--send-test/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("06-public-images.json criado/alterado depois do publish também acusa", () => {
    const dir = makeEdition();
    try {
      writeState(dir, { source_hashes: computeKitDraftSourceHashes(dir) });
      writeFileSync(join(dir, "06-public-images.json"), "{}", "utf8");
      const v = checkKitDraftFresh(dir, "kit");
      assert.equal(v.length, 1);
      assert.match(v[0].message, /06-public-images\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backend beehiiv → nunca acusa", () => {
    const dir = makeEdition();
    try {
      writeState(dir, { source_hashes: { "02-reviewed.md": "deadbeef" } });
      assert.deepEqual(checkKitDraftFresh(dir, "beehiiv"), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("estado legado (sem source_hashes), ausente ou ilegível → sem violação", () => {
    const dir = makeEdition();
    try {
      assert.deepEqual(checkKitDraftFresh(dir, "kit"), [], "estado ausente: scheduled-at-present já acusa");
      writeState(dir, {});
      assert.deepEqual(checkKitDraftFresh(dir, "kit"), [], "publicado antes do #9428");
      writeFileSync(join(dir, "_internal", "newsletter-kit-published.json"), "{nope", "utf8");
      assert.deepEqual(checkKitDraftFresh(dir, "kit"), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
