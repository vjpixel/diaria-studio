/**
 * test/stage4-decision.test.ts (#6447 Fatia 4, achado 7)
 *
 * `scripts/lib/stage4-decision.ts` — leitura/escrita de
 * `_internal/.step-4-decision.json` (decisão "gate 4 aprovado pelo painel").
 * Mesmo padrão de `test/stage4-capture-state.test.ts` (tmpdir real, sem
 * mock de fs) — a disciplina de lock+tmp+rename é a mesma dos dois módulos.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readStage4Decision,
  writeStage4ApprovedDecision,
  decideGateApproveAction,
} from "../scripts/lib/stage4-decision.ts";

describe("stage4-decision (#6447 Fatia 4, achado 7)", () => {
  let editionDir: string;

  beforeEach(() => {
    editionDir = mkdtempSync(join(tmpdir(), "stage4-decision-"));
    mkdirSync(resolve(editionDir, "_internal"), { recursive: true });
  });
  afterEach(() => rmSync(editionDir, { recursive: true, force: true }));

  it("readStage4Decision: arquivo ausente -> null (caso normal)", () => {
    assert.equal(readStage4Decision(editionDir), null);
  });

  it("write depois read: round-trip completo", () => {
    const written = writeStage4ApprovedDecision(editionDir, { now: () => new Date("2026-08-28T12:00:00.000Z") });
    assert.equal(written.decision, "approved");
    assert.equal(written.decided_via, "studio");
    assert.equal(written.decided_at, "2026-08-28T12:00:00.000Z");

    const read = readStage4Decision(editionDir);
    assert.deepEqual(read, written);
  });

  it("JSON corrompido -> null, nunca lança", () => {
    writeFileSync(resolve(editionDir, "_internal", ".step-4-decision.json"), "{not json", "utf8");
    assert.equal(readStage4Decision(editionDir), null);
  });

  it("shape inesperado (decision != 'approved') -> null", () => {
    writeFileSync(
      resolve(editionDir, "_internal", ".step-4-decision.json"),
      JSON.stringify({ decision: "rejected", decided_at: "2026-08-28T12:00:00.000Z" }),
      "utf8",
    );
    assert.equal(readStage4Decision(editionDir), null);
  });

  it("2ª escrita sobrescreve a 1ª com novo timestamp", () => {
    writeStage4ApprovedDecision(editionDir, { now: () => new Date("2026-08-28T12:00:00.000Z") });
    const second = writeStage4ApprovedDecision(editionDir, { now: () => new Date("2026-08-28T13:00:00.000Z") });
    assert.equal(second.decided_at, "2026-08-28T13:00:00.000Z");
    assert.equal(readStage4Decision(editionDir)?.decided_at, "2026-08-28T13:00:00.000Z");
  });

  it("escrita é atômica (tmp+rename) — nunca deixa .tmp órfão", () => {
    writeStage4ApprovedDecision(editionDir);
    assert.throws(() => readFileSync(resolve(editionDir, "_internal", ".step-4-decision.json.tmp")));
  });
});

describe("decideGateApproveAction (#6447 Fatia 4, achado 7 — guard de duplo-approve)", () => {
  it("nunca aprovado antes -> write, mesmo sem force", () => {
    assert.deepEqual(decideGateApproveAction(null, false), { kind: "write" });
  });

  it("já aprovado, sem force -> conflict com a decisão existente", () => {
    const existing = { decision: "approved" as const, decided_at: "2026-08-28T12:00:00.000Z", decided_via: "studio" as const };
    const result = decideGateApproveAction(existing, false);
    assert.equal(result.kind, "conflict");
    assert.deepEqual((result as { kind: "conflict"; existing: typeof existing }).existing, existing);
  });

  it("já aprovado, com force:true -> write (sobrescreve)", () => {
    const existing = { decision: "approved" as const, decided_at: "2026-08-28T12:00:00.000Z", decided_via: "studio" as const };
    assert.deepEqual(decideGateApproveAction(existing, true), { kind: "write" });
  });
});
