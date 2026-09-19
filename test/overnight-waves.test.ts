/**
 * overnight-waves.test.ts (#8486)
 * Cobre o teto mecânico (6), `cap_hit` e a validação do campo `waves`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OVERNIGHT_WAVE_CAP,
  appendWave,
  buildWaveRecord,
  checkOvernightWaves,
} from "../scripts/lib/overnight-waves.ts";

const NOW = new Date("2026-09-19T20:00:00Z");

describe("buildWaveRecord", () => {
  it("teto é 6", () => assert.equal(OVERNIGHT_WAVE_CAP, 6));

  it("onda que cabe inteira: cap_hit false", () => {
    const r = buildWaveRecord({ units: [[1, 2], [3]], now: NOW });
    assert.equal(r.unit_count, 2);
    assert.equal(r.cap_hit, false);
    assert.equal(r.deferred_count, 0);
    assert.deepEqual(r.units[0], { issues: [1, 2] });
  });

  it("truncada pelo teto: deferred>0 => cap_hit true", () => {
    const r = buildWaveRecord({ units: [[1], [2], [3], [4], [5], [6]], deferred: 2, now: NOW });
    assert.equal(r.cap_hit, true);
    assert.equal(r.unit_count, 6);
  });

  it("7 unidades estoura o teto (regressão: teto era só prosa)", () => {
    assert.throws(
      () => buildWaveRecord({ units: [[1], [2], [3], [4], [5], [6], [7]] }),
      /estoura o teto 6/,
    );
  });

  it("rejeita onda vazia e unidade inválida", () => {
    assert.throws(() => buildWaveRecord({ units: [] }));
    assert.throws(() => buildWaveRecord({ units: [[NaN]] }));
    assert.throws(() => buildWaveRecord({ units: [[1]], deferred: -1 }));
  });
});

describe("appendWave / checkOvernightWaves", () => {
  it("anexa sem mutar e acumula", () => {
    const p1 = appendWave({}, buildWaveRecord({ units: [[1]], now: NOW }));
    const p2 = appendWave(p1, buildWaveRecord({ units: [[2]], now: NOW }));
    assert.equal(p1.waves.length, 1);
    assert.equal(p2.waves.length, 2);
    assert.deepEqual(checkOvernightWaves(p2), { status: "ok", present: true });
  });

  it("plano legado sem waves: fail-open", () => {
    assert.deepEqual(checkOvernightWaves({}), { status: "ok", present: false });
  });

  it("detecta unit_count e cap_hit inconsistentes", () => {
    const r = buildWaveRecord({ units: [[1], [2]], now: NOW });
    const res = checkOvernightWaves({ waves: [{ ...r, unit_count: 5, cap_hit: true }] });
    assert.equal(res.status, "invalid");
    if (res.status === "invalid") assert.equal(res.problems.length, 2);
  });
});

describe("call site real (#8486)", () => {
  it("a SKILL.md do overnight invoca record-overnight-wave.ts, não só declara a intenção", async () => {
    const { readFileSync } = await import("node:fs");
    const s = readFileSync(".claude/skills/diaria-overnight/SKILL.md", "utf8");
    assert.match(s, /scripts\/record-overnight-wave\.ts --plan/);
  });
});

describe("CLI record-overnight-wave (#8486, review #8492)", () => {
  const run = async (args: string[], plan: string) => {
    const { spawnSync } = await import("node:child_process");
    return spawnSync(process.execPath, ["--import", "tsx", "scripts/record-overnight-wave.ts", "--plan", plan, ...args], {
      encoding: "utf8",
    });
  };
  const tmp = async (content: string) => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const p = join(mkdtempSync(join(tmpdir(), "wave-")), "plan.json");
    writeFileSync(p, content);
    return p;
  };

  it("grava onda; 6 unidades com deferred=0 => cap_hit false; deferred=2 => true", async () => {
    const { readFileSync } = await import("node:fs");
    const p = await tmp('{"issues":[]}');
    assert.equal((await run(["--units", "1;2;3;4;5;6"], p)).status, 0);
    assert.equal((await run(["--units", "7;8", "--deferred", "2"], p)).status, 0);
    const w = JSON.parse(readFileSync(p, "utf8")).waves;
    assert.equal(w[0].unit_count, 6);
    assert.equal(w[0].cap_hit, false);
    assert.equal(w[1].cap_hit, true);
  });

  it("7 unidades => exit 1 e plano intocado", async () => {
    const { readFileSync } = await import("node:fs");
    const p = await tmp('{"issues":[]}');
    assert.equal((await run(["--units", "1;2;3;4;5;6;7"], p)).status, 1);
    assert.equal(readFileSync(p, "utf8"), '{"issues":[]}');
  });

  it("token malformado, issue repetida => exit 1", async () => {
    const p = await tmp("{}");
    assert.equal((await run(["--units", "1e3"], p)).status, 1);
    assert.equal((await run(["--units", "1;"], p)).status, 1);
    assert.equal((await run(["--units", "5,6;6"], p)).status, 1);
  });

  it("--deferred sem valor ou não-numérico => exit 2 (nunca cap_hit falso-negativo)", async () => {
    const p = await tmp("{}");
    assert.equal((await run(["--units", "1", "--deferred"], p)).status, 2);
    assert.equal((await run(["--units", "1", "--deferred", "abc"], p)).status, 2);
  });

  it("plan.json corrompido ou raiz não-objeto => exit 2, sem stack trace", async () => {
    for (const bad of ["{nao json", "null", "[]"]) {
      const r = await run(["--units", "1"], await tmp(bad));
      assert.equal(r.status, 2, bad);
      assert.doesNotMatch(r.stderr, /at .*\.ts:\d+/);
    }
  });
});
