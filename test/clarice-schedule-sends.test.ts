import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scheduledAtFor, SUBJECTS, PREVIEW_TEXT, parseWeeksArg } from "../scripts/clarice-schedule-sends.ts";

describe("scheduledAtFor (guard de range #2007/#2018)", () => {
  it("d01 → 10/jun/2026 06:00 BRT", () => {
    assert.equal(scheduledAtFor(1), "2026-06-10T06:00:00-03:00");
  });

  it("d07 → 16/jun/2026 06:00 BRT (último dia S1)", () => {
    assert.equal(scheduledAtFor(7), "2026-06-16T06:00:00-03:00");
  });

  it("d08 → 17/jun/2026 06:00 BRT (primeiro dia S2)", () => {
    assert.equal(scheduledAtFor(8), "2026-06-17T06:00:00-03:00");
  });

  it("d14 → 23/jun/2026 06:00 BRT (último dia S2)", () => {
    assert.equal(scheduledAtFor(14), "2026-06-23T06:00:00-03:00");
  });

  it("d15 → 24/jun/2026 06:00 BRT (primeiro dia S3)", () => {
    assert.equal(scheduledAtFor(15), "2026-06-24T06:00:00-03:00");
  });

  it("d21 → 30/jun/2026 06:00 BRT (último dia S3)", () => {
    assert.equal(scheduledAtFor(21), "2026-06-30T06:00:00-03:00");
  });

  // Guard de range: n fora de 1..21 lança erro explícito (nunca data silenciosamente errada)
  it("n=0 lança erro (fora do range)", () => {
    assert.throws(() => scheduledAtFor(0), /n deve ser inteiro 1\.\.21/);
  });

  it("n=22 lança erro (fora do range)", () => {
    assert.throws(() => scheduledAtFor(22), /n deve ser inteiro 1\.\.21/);
  });

  it("n=1.5 lança erro (não-inteiro)", () => {
    assert.throws(() => scheduledAtFor(1.5), /n deve ser inteiro 1\.\.21/);
  });
});

describe("SUBJECTS / PREVIEW_TEXT (S1)", () => {
  it("tem 3 variantes A/B/C", () => {
    assert.ok("A" in SUBJECTS && "B" in SUBJECTS && "C" in SUBJECTS);
    assert.equal(Object.keys(SUBJECTS).length, 3);
  });

  it("PREVIEW_TEXT não está vazio", () => {
    assert.ok(PREVIEW_TEXT.length > 10);
  });
});

describe("parseWeeksArg (#2007/#2018)", () => {
  it("sem --weeks retorna [1] (default S1)", () => {
    assert.deepEqual(parseWeeksArg([]), [1]);
    assert.deepEqual(parseWeeksArg(["--cycle", "2605-06"]), [1]);
  });

  it("--weeks 1 retorna [1]", () => {
    assert.deepEqual(parseWeeksArg(["--weeks", "1"]), [1]);
  });

  it("--weeks 2,3 retorna [2,3]", () => {
    assert.deepEqual(parseWeeksArg(["--weeks", "2,3"]), [2, 3]);
  });

  it("--weeks 1,2,3 retorna [1,2,3]", () => {
    assert.deepEqual(parseWeeksArg(["--weeks", "1,2,3"]), [1, 2, 3]);
  });

  // Regressão #2007: --weeks --dry-run (sem valor) não pode resultar em weeks=[] silencioso
  it("--weeks --dry-run (sem valor) lança erro explícito", () => {
    assert.throws(
      () => parseWeeksArg(["--weeks", "--dry-run"]),
      /--weeks requer um valor/,
    );
  });

  it("--weeks sem valor no final do argv lança erro explícito", () => {
    assert.throws(
      () => parseWeeksArg(["--weeks"]),
      /--weeks requer um valor/,
    );
  });

  it("--weeks com valor inválido lança erro explícito", () => {
    assert.throws(
      () => parseWeeksArg(["--weeks", "abc"]),
      /não contém semanas válidas/,
    );
  });

  it("--weeks 4 (semana inexistente) lança erro explícito", () => {
    assert.throws(
      () => parseWeeksArg(["--weeks", "4"]),
      /não contém semanas válidas/,
    );
  });

  it("--weeks 2 retorna [2] (S2 isolada)", () => {
    assert.deepEqual(parseWeeksArg(["--weeks", "2"]), [2]);
  });
});
