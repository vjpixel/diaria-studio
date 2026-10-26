/**
 * #11180 — `scripts/social-schedule-rotation.ts --record --time HH:MM` grava o
 * horário REAL de publicação. Cenário de origem (ciclo 26w43): o artigo semanal
 * do LinkedIn planejado pra 09:30 saiu às 14:25 e o `--record` só sabia gravar
 * o planejado, falseando a medição da #10305.
 *
 * Os testes de CLI usam `--log` num diretório temporário: nada toca o
 * `data/social-schedule-rotation.jsonl` real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyActualTime,
  recordedTimeConflict,
} from "../scripts/lib/social-schedule-rotation-record.ts";
import type { RotationPlanRow } from "../scripts/lib/social-schedule-rotation.ts";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "scripts", "social-schedule-rotation.ts");

const article = { date: "2026-10-26", kind: "linkedin_article", time: "09:30", source: "rotation", week_index: 1 } as RotationPlanRow;
const d1 = { date: "2026-10-26", kind: "weekday", type: "d1", time: "11:00", source: "rotation" } as RotationPlanRow;

describe("applyActualTime (#11180)", () => {
  it("horário igual ao planejado: linha intacta, sem marca", () => {
    assert.deepEqual(applyActualTime([article], "09:30"), [article]);
  });

  it("horário diferente: time = real, planned_time + time_differs_from_plan", () => {
    assert.deepEqual(applyActualTime([article], "14:25"), [
      { ...article, time: "14:25", planned_time: "09:30", time_differs_from_plan: true },
    ]);
  });

  it("valor inválido lança", () => {
    for (const bad of ["", "9:30", "24:00", "14:60", "14h25", "14:25:00", "--log"]) {
      assert.throws(() => applyActualTime([article], bad), /--time inválido/, `aceitou '${bad}'`);
    }
  });

  it("mais de 1 linha (ou nenhuma) lança: o horário real é de um post só", () => {
    assert.throws(() => applyActualTime([article, d1], "14:25"), /exatamente 1 linha.*deixou 2/);
    assert.throws(() => applyActualTime([], "14:25"), /deixou 0 \(nenhuma\)/);
  });
});

describe("recordedTimeConflict (#11180)", () => {
  it("chave não gravada ou mesmo horário → null; outro horário → o gravado", () => {
    assert.equal(recordedTimeConflict("", article), null);
    const log = JSON.stringify({ ...article, recorded_at: "x" }) + "\n{corrompida\n";
    assert.equal(recordedTimeConflict(log, article), null);
    assert.equal(recordedTimeConflict(log, { ...article, time: "14:25" } as RotationPlanRow), "09:30");
    assert.equal(recordedTimeConflict(log, { ...d1, time: "14:25" } as RotationPlanRow), null);
  });
});

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { cwd: ROOT, encoding: "utf8" });
}

function readLog(p: string): Array<Record<string, unknown>> {
  return readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

describe("CLI --record --time (#11180), log temporário", () => {
  const base = ["--record", "--date", "261026", "--kind", "linkedin_article"];

  it("sem --time: grava o planejado, igual a antes", () => {
    const dir = mkdtempSync(join(tmpdir(), "rot-11180-"));
    try {
      const log = join(dir, "rot.jsonl");
      const r = runCli([...base, "--log", log]);
      assert.equal(r.status, 0, r.stderr);
      const [row] = readLog(log);
      assert.equal(row.kind, "linkedin_article");
      assert.equal(typeof row.time, "string");
      assert.ok(!("planned_time" in row) && !("time_differs_from_plan" in row));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--time igual ao planejado: mesma linha do --record sem --time", () => {
    const dir = mkdtempSync(join(tmpdir(), "rot-11180-"));
    try {
      const plain = join(dir, "a.jsonl");
      const timed = join(dir, "b.jsonl");
      assert.equal(runCli([...base, "--log", plain]).status, 0);
      const planned = String(readLog(plain)[0].time);
      const r = runCli([...base, "--time", planned, "--log", timed]);
      assert.equal(r.status, 0, r.stderr);
      const strip = (o: Record<string, unknown>) => ({ ...o, recorded_at: undefined });
      assert.deepEqual(strip(readLog(timed)[0]), strip(readLog(plain)[0]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--time diferente: grava o real com a marca", () => {
    const dir = mkdtempSync(join(tmpdir(), "rot-11180-"));
    try {
      const plainLog = join(dir, "a.jsonl");
      assert.equal(runCli([...base, "--log", plainLog]).status, 0);
      const planned = String(readLog(plainLog)[0].time);
      const actual = planned === "14:25" ? "14:26" : "14:25";
      const log = join(dir, "b.jsonl");
      const r = runCli([...base, "--time", actual, "--log", log]);
      assert.equal(r.status, 0, r.stderr);
      const [row] = readLog(log);
      assert.equal(row.time, actual);
      assert.equal(row.planned_time, planned);
      assert.equal(row.time_differs_from_plan, true);
      assert.match(r.stderr, /difere do planejado/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--time inválido: exit 1, nada gravado", () => {
    const dir = mkdtempSync(join(tmpdir(), "rot-11180-"));
    try {
      const log = join(dir, "rot.jsonl");
      const r = runCli([...base, "--time", "25:00", "--log", log]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /--time inválido/);
      assert.equal(existsSync(log), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--time sem --record: exit 1", () => {
    const r = runCli(["--date", "261026", "--time", "14:25"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--time só vale com --record/);
  });

  it("linha já gravada com outro horário: exit 1, log intacto (não descarta em silêncio)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rot-11180-"));
    try {
      const log = join(dir, "rot.jsonl");
      assert.equal(runCli([...base, "--log", log]).status, 0);
      const before = readFileSync(log, "utf8");
      const planned = String(readLog(log)[0].time);
      const r = runCli([...base, "--time", planned === "14:25" ? "14:26" : "14:25", "--log", log]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /já está gravada/);
      assert.equal(readFileSync(log, "utf8"), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dia útil sem --kind (várias linhas) com --time: exit 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "rot-11180-"));
    try {
      const log = join(dir, "rot.jsonl");
      writeFileSync(log, "");
      const r = runCli(["--record", "--date", "261026", "--kind", "weekday", "--time", "14:25", "--log", log]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /exatamente 1 linha/);
      assert.equal(readFileSync(log, "utf8"), "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
