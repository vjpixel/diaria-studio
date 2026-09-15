/**
 * test/stage-4-approved-item-removal-invariant.test.ts (#8121)
 *
 * Cobre o registro do guard warn-only `approved-item-removed` em
 * `invariant-checks/stage-4.ts` — mesmo padrão de
 * test/stage-4-box-divulgacao-alt-invariant.test.ts (#4086).
 *
 * checkApprovedItemRemoval compara `_internal/01-approved.json` ATUAL
 * contra o snapshot pós-Stage 1/2 (`_internal/editor-request-snapshots/
 * stage2-post-gate/_internal/01-approved.json`, já mantido por
 * `derive-editor-requests.ts snapshot-stage2`, #5731) e avisa (nunca
 * bloqueia) quando um item foi REMOVIDO — não apenas recategorizado.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkApprovedItemRemoval,
  STAGE_4_RULES,
} from "../scripts/lib/invariant-checks/stage-4.ts";

function makeEditionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stage4-approved-removal-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

function writeSnapshot(dir: string, approvedJson: unknown): void {
  const snapshotDir = join(dir, "_internal", "editor-request-snapshots", "stage2-post-gate", "_internal");
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(join(snapshotDir, "01-approved.json"), JSON.stringify(approvedJson));
}

function writeCurrent(dir: string, approvedJson: unknown): void {
  writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(approvedJson));
}

describe("checkApprovedItemRemoval (#8121)", () => {
  it("retorna [] quando não há snapshot pós-Stage 1/2 (edição sem gate humano, ou pré-#5731)", () => {
    const dir = makeEditionDir();
    writeCurrent(dir, { radar: [{ url: "https://example.com/a", title: "A" }] });
    assert.deepEqual(checkApprovedItemRemoval(dir), []);
  });

  it("retorna [] quando 01-approved.json atual não existe (Stage 1 não rodou)", () => {
    const dir = makeEditionDir();
    writeSnapshot(dir, { radar: [{ url: "https://example.com/a", title: "A" }] });
    assert.deepEqual(checkApprovedItemRemoval(dir), []);
  });

  it("retorna [] quando o item só MUDOU de bucket (recategorização legítima do Stage 4)", () => {
    const dir = makeEditionDir();
    writeSnapshot(dir, { radar: [{ url: "https://example.com/a", title: "Item A" }] });
    writeCurrent(dir, { lancamento: [{ url: "https://example.com/a", title: "Item A" }] });
    assert.deepEqual(checkApprovedItemRemoval(dir), []);
  });

  it("warning quando um item foi removido de TODOS os buckets entre o snapshot e o estado atual", () => {
    const dir = makeEditionDir();
    writeSnapshot(dir, {
      radar: [
        { url: "https://example.com/a", title: "Item A" },
        { url: "https://example.com/b", title: "Item B" },
      ],
    });
    writeCurrent(dir, { radar: [{ url: "https://example.com/a", title: "Item A" }] }); // B sumiu
    const violations = checkApprovedItemRemoval(dir);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, "approved-item-removed");
    assert.equal(violations[0].source_issue, "#8121");
    assert.match(violations[0].message, /Item B/);
    assert.match(violations[0].message, /https:\/\/example\.com\/b/);
    assert.match(violations[0].message, /"radar"/);
  });

  it("nunca é gate-blocking — severity é sempre 'warning', nunca 'error'", () => {
    const dir = makeEditionDir();
    writeSnapshot(dir, { radar: [{ url: "https://example.com/a", title: "A" }] });
    writeCurrent(dir, { radar: [] });
    const violations = checkApprovedItemRemoval(dir);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].severity, "warning");
  });

  it("JSON corrompido (snapshot ou atual) não lança — retorna []", () => {
    const dir = makeEditionDir();
    const snapshotDir = join(dir, "_internal", "editor-request-snapshots", "stage2-post-gate", "_internal");
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, "01-approved.json"), "{ isto não é json");
    writeCurrent(dir, { radar: [] });
    assert.deepEqual(checkApprovedItemRemoval(dir), []);
  });
});

describe("STAGE_4_RULES registry (#8121)", () => {
  it("inclui approved-item-removed", () => {
    const rule = STAGE_4_RULES.find((r) => r.id === "approved-item-removed");
    assert.ok(rule, "regra approved-item-removed ausente de STAGE_4_RULES");
  });

  it("approved-item-removed está registrado no stage 4, source_issue #8121", () => {
    const rule = STAGE_4_RULES.find((r) => r.id === "approved-item-removed");
    assert.equal(rule?.stage, 4);
    assert.equal(rule?.source_issue, "#8121");
    assert.equal(rule?.run, checkApprovedItemRemoval);
  });
});
