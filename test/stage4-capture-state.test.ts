/**
 * test/stage4-capture-state.test.ts (#5414)
 *
 * Cobre `scripts/lib/stage4-capture-state.ts` — os 2 valores computados em
 * §4c.1b/§4c.1c do Stage 4 e consumidos no gate (§4d) precisam sobreviver a
 * um corte de contexto DENTRO do Stage 4 (o stage mais longo do pipeline —
 * 587 turnos medidos na auditoria do #5414), não só entre stages.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readStage4CaptureState,
  writeStage4CaptureState,
  type Stage4CaptureState,
} from "../scripts/lib/stage4-capture-state.ts";

const DEFAULT: Stage4CaptureState = {
  whatsappUrl: null,
  metaDescriptionSuggestion: null,
  capturedAt: null,
};

describe("readStage4CaptureState / writeStage4CaptureState (#5414)", () => {
  let editionDir: string;

  before(() => {
    editionDir = mkdtempSync(join(tmpdir(), "stage4-capture-state-"));
  });

  after(() => {
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("sem arquivo -> default (ambos null)", () => {
    assert.deepEqual(readStage4CaptureState(editionDir), DEFAULT);
  });

  it("write parcial (só whatsappUrl, §4c.1b) grava e read reflete", () => {
    const written = writeStage4CaptureState(
      editionDir,
      { whatsappUrl: "https://diar.ia.br/e/260817?w=1" },
      { now: () => new Date("2026-08-16T20:00:00.000Z") },
    );
    assert.equal(written.whatsappUrl, "https://diar.ia.br/e/260817?w=1");
    assert.equal(written.metaDescriptionSuggestion, null);
    assert.equal(written.capturedAt, "2026-08-16T20:00:00.000Z");
  });

  it("write subsequente (§4c.1c) faz upsert — não apaga whatsappUrl já gravado", () => {
    writeStage4CaptureState(
      editionDir,
      { metaDescriptionSuggestion: "Uma sugestão de meta description." },
      { now: () => new Date("2026-08-16T20:05:00.000Z") },
    );
    const read = readStage4CaptureState(editionDir);
    assert.equal(read.whatsappUrl, "https://diar.ia.br/e/260817?w=1");
    assert.equal(read.metaDescriptionSuggestion, "Uma sugestão de meta description.");
    assert.equal(read.capturedAt, "2026-08-16T20:05:00.000Z");
  });

  it("string vazia é valor legítimo já capturado — distinto de null (nunca computado)", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-capture-state-empty-"));
    writeStage4CaptureState(dir, { metaDescriptionSuggestion: "" });
    const read = readStage4CaptureState(dir);
    assert.equal(read.metaDescriptionSuggestion, ""); // computado, sem sugestão — não é "ainda não rodou"
    assert.notEqual(read.metaDescriptionSuggestion, null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("§4d.1 recompute (editor ajustou título do D1) sobrescreve whatsappUrl", () => {
    writeStage4CaptureState(editionDir, { whatsappUrl: "https://diar.ia.br/e/260817?w=2" });
    assert.equal(readStage4CaptureState(editionDir).whatsappUrl, "https://diar.ia.br/e/260817?w=2");
  });

  it("cria _internal/ se ainda não existir", () => {
    const fresh = mkdtempSync(join(tmpdir(), "stage4-capture-state-nodir-"));
    assert.equal(existsSync(join(fresh, "_internal")), false);
    writeStage4CaptureState(fresh, { whatsappUrl: "https://x" });
    assert.equal(existsSync(join(fresh, "_internal", "stage4-capture-state.json")), true);
    rmSync(fresh, { recursive: true, force: true });
  });

  it("JSON corrompido -> default fail-soft, nunca lança", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-capture-state-corrupt-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "stage4-capture-state.json"), "{{{", "utf8");
    assert.deepEqual(readStage4CaptureState(dir), DEFAULT);
    rmSync(dir, { recursive: true, force: true });
  });

  it("nunca sobrescreve outro arquivo sob _internal/ — path é dedicado", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-capture-state-dedicated-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    const other = join(dir, "_internal", "outro-estado.json");
    writeFileSync(other, JSON.stringify({ hello: "world" }), "utf8");
    writeStage4CaptureState(dir, { whatsappUrl: "https://x" });
    assert.equal(JSON.parse(readFileSync(other, "utf8")).hello, "world");
    rmSync(dir, { recursive: true, force: true });
  });
});
