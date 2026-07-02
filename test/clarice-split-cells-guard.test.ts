import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { assertCellsNotDropped, parseBlockArg } from "../scripts/clarice-split-cells.ts";

describe("assertCellsNotDropped (guard de re-split)", () => {
  it("não lança quando o sentinel .a-dropped.json está ausente", () => {
    const dir = mkdtempSync(join(tmpdir(), "cells-noguard-"));
    try {
      assert.doesNotThrow(() => assertCellsNotDropped(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lança quando o sentinel existe (protege CSVs editados à mão)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cells-guard-"));
    try {
      writeFileSync(resolve(dir, ".a-dropped.json"), '{"reason":"test"}');
      assert.throws(() => assertCellsNotDropped(dir), /re-split abortado/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// #2775: qual bloco recebe o teste A/B/C é configurável (era sempre "semana 1"
// hardcoded). Default preserva o comportamento do ciclo 2605-06.
describe("parseBlockArg (#2775 — bloco A/B/C configurável)", () => {
  it("sem --block: default 1", () => {
    assert.equal(parseBlockArg([]), 1);
    assert.equal(parseBlockArg(["--cycle", "2605-06"]), 1);
  });

  it("--block 2 retorna 2", () => {
    assert.equal(parseBlockArg(["--block", "2"]), 2);
  });

  it("--block sem valor lança erro explícito", () => {
    assert.throws(() => parseBlockArg(["--block"]), /--block requer um valor/);
  });

  it("--block seguido de outra flag (sem valor) lança erro explícito", () => {
    assert.throws(() => parseBlockArg(["--block", "--execute"]), /--block requer um valor/);
  });

  it("--block 0 lança erro explícito", () => {
    assert.throws(() => parseBlockArg(["--block", "0"]), /--block deve ser um inteiro/);
  });

  // Valor negativo começa com "-" — mesma convenção de todo parser de flag deste
  // arquivo (ex: --subject, --label): é tratado como "flag sem valor", não como
  // um número negativo válido. Mensagem correta é a de "requer um valor".
  it("--block -1 (começa com '-') é tratado como valor ausente", () => {
    assert.throws(() => parseBlockArg(["--block", "-1"]), /--block requer um valor/);
  });

  it("--block não-numérico lança erro explícito", () => {
    assert.throws(() => parseBlockArg(["--block", "abc"]), /--block deve ser um inteiro/);
  });
});
