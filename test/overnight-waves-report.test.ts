/**
 * overnight-waves-report.test.ts (#8496)
 *
 * Cobre os 3 pedidos da issue: leitor/agregador de N rondas, cálculo de p90
 * segmentado por `cap_hit`, e a idempotência de `record-overnight-wave.ts`
 * (dedup por conjunto de issues idêntico numa janela curta).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import {
  aggregateWaveRounds,
  computeWaveUnitDurations,
  percentile,
  renderWavesReportMarkdown,
} from "../scripts/lib/overnight-waves-report.ts";
import { buildWaveRecord, findDuplicateWave } from "../scripts/lib/overnight-waves.ts";
import { scanOvernightRounds } from "../scripts/report-overnight-waves.ts";
import type { PlanIssue } from "../scripts/render-overnight-timeline.ts";

const NOW = new Date("2026-09-20T20:00:00Z");

function issue(number: number, pr_opened?: string, merged?: string): PlanIssue {
  return {
    number,
    priority: "P2",
    status: merged ? "mergeada" : "in_progress",
    batch: null,
    pr: null,
    timeline: { pr_opened, merged },
  };
}

describe("percentile", () => {
  it("vazio -> null", () => assert.equal(percentile([], 90), null));
  it("1 elemento -> ele mesmo", () => assert.equal(percentile([42], 90), 42));
  it("p90 de [1..10] (interpolado)", () => {
    const vals = Array.from({ length: 10 }, (_, i) => i + 1);
    assert.equal(percentile(vals, 90), 9.1);
  });
});

describe("computeWaveUnitDurations", () => {
  it("cruza units.issues com timeline e calcula pr_opened(mais cedo)->merged(mais tarde)", () => {
    const waves = [
      buildWaveRecord({
        units: [[1, 2], [3]],
        now: NOW,
      }),
    ];
    const issues = [
      issue(1, "2026-09-20T10:00:00Z", "2026-09-20T10:30:00Z"),
      issue(2, "2026-09-20T10:05:00Z", "2026-09-20T11:00:00Z"), // batch: earliest open=10:00, latest merged=11:00 => 1h
      issue(3, "2026-09-20T09:00:00Z"), // sem merged -> duration null
    ];
    const durations = computeWaveUnitDurations(waves, issues);
    assert.equal(durations.length, 2);
    assert.equal(durations[0].duration_ms, 60 * 60 * 1000);
    assert.equal(durations[0].cap_hit, false);
    assert.equal(durations[1].duration_ms, null);
  });
});

describe("aggregateWaveRounds", () => {
  it("agrega distribuição de unit_count, cap_hit fraction e p90 segmentado", () => {
    const roundA = {
      waves: [
        buildWaveRecord({ units: [[1], [2]], now: NOW }), // cap_hit false, 2 unidades
      ],
      issues: [
        issue(1, "2026-09-20T10:00:00Z", "2026-09-20T10:10:00Z"), // 10min
        issue(2, "2026-09-20T10:00:00Z", "2026-09-20T10:20:00Z"), // 20min
      ],
    };
    const roundB = {
      waves: [
        buildWaveRecord({ units: [[3], [4], [5], [6], [7], [8]], deferred: 2, now: NOW }), // cap_hit true, 6 unidades
      ],
      issues: [
        issue(3, "2026-09-20T10:00:00Z", "2026-09-20T11:00:00Z"), // 1h
        issue(4, "2026-09-20T10:00:00Z", "2026-09-20T12:00:00Z"), // 2h
        issue(5),
        issue(6),
        issue(7),
        issue(8),
      ],
    };
    const roundLegacy = { issues: [] }; // sem waves — plano pré-#8486

    const report = aggregateWaveRounds([roundA, roundB, roundLegacy]);
    assert.equal(report.rounds_scanned, 3);
    assert.equal(report.waves_total, 2);
    assert.deepEqual(report.unit_count_distribution, { 2: 1, 6: 1 });
    assert.equal(report.cap_hit_count, 1);
    assert.equal(report.cap_hit_fraction, 0.5);
    assert.equal(report.pr_to_merge_sample_size.cap_hit_false, 2);
    assert.equal(report.pr_to_merge_sample_size.cap_hit_true, 2);
    // p90 dentro do grupo false (10min, 20min) e true (1h, 2h) — ambos != null
    assert.notEqual(report.pr_to_merge_p90_ms.cap_hit_false, null);
    assert.notEqual(report.pr_to_merge_p90_ms.cap_hit_true, null);
  });

  it("nenhuma onda em nenhuma ronda -> waves_total 0, sem lançar", () => {
    const report = aggregateWaveRounds([{ issues: [] }, { waves: [], issues: [] }]);
    assert.equal(report.waves_total, 0);
    assert.equal(report.cap_hit_fraction, 0);
    assert.match(renderWavesReportMarkdown(report), /Nenhuma onda registrada/);
  });
});

describe("findDuplicateWave (#8496 item 3 — idempotência)", () => {
  it("mesmo conjunto de issues dentro da janela -> duplicata", () => {
    const w1 = buildWaveRecord({ units: [[10, 11], [12]], now: new Date("2026-09-20T10:00:00Z") });
    const w2 = buildWaveRecord({ units: [[12], [11, 10]], now: new Date("2026-09-20T10:05:00Z") }); // mesmo conjunto, ordem/agrupamento diferente
    const dup = findDuplicateWave([w1], w2);
    assert.equal(dup, w1);
  });

  it("conjunto diferente -> não é duplicata", () => {
    const w1 = buildWaveRecord({ units: [[10]], now: new Date("2026-09-20T10:00:00Z") });
    const w2 = buildWaveRecord({ units: [[99]], now: new Date("2026-09-20T10:05:00Z") });
    assert.equal(findDuplicateWave([w1], w2), null);
  });

  it("mesmo conjunto mas fora da janela -> não é duplicata (onda nova genuína)", () => {
    const w1 = buildWaveRecord({ units: [[10]], now: new Date("2026-09-20T10:00:00Z") });
    const w2 = buildWaveRecord({ units: [[10]], now: new Date("2026-09-20T12:00:00Z") }); // 2h depois
    assert.equal(findDuplicateWave([w1], w2), null);
  });
});

describe("scanOvernightRounds", () => {
  it("varre dirs AAMMDD[a-z]?, aplica --since, degrada em plan.json corrompido", () => {
    const base = mkdtempSync(join(tmpdir(), "overnight-waves-"));
    for (const [dir, content] of [
      ["260918", JSON.stringify({ issues: [], waves: [] })],
      ["260920", JSON.stringify({ issues: [{ number: 1 }], waves: [buildWaveRecord({ units: [[1]], now: NOW })] })],
      ["260920b", "{not json"],
      ["nao-e-rodada", JSON.stringify({ issues: [] })],
    ] as const) {
      mkdirSync(join(base, dir), { recursive: true });
      writeFileSync(join(base, dir, "plan.json"), content);
    }
    const all = scanOvernightRounds(base);
    assert.deepEqual(
      all.map((r) => r.dir),
      ["260918", "260920"], // corrompido pulado, dir fora do padrão ignorado
    );
    const sinced = scanOvernightRounds(base, "260920");
    assert.deepEqual(sinced.map((r) => r.dir), ["260920"]);
  });

  it("dir ausente -> array vazio, nunca lança", () => {
    assert.deepEqual(scanOvernightRounds(join(tmpdir(), "nao-existe-" + Date.now())), []);
  });
});

describe("record-overnight-wave.ts CLI — dedup idempotente (#8496 item 3)", () => {
  const run = (args: string[], plan: string) =>
    spawnSync(process.execPath, ["--import", "tsx", "scripts/record-overnight-wave.ts", "--plan", plan, ...args], {
      encoding: "utf8",
    });
  const tmp = (content: string) => {
    const p = join(mkdtempSync(join(tmpdir(), "wave-dup-")), "plan.json");
    writeFileSync(p, content);
    return p;
  };

  it("re-executar com o MESMO conjunto de issues não grava 2ª onda", () => {
    const p = tmp('{"issues":[]}');
    assert.equal(run(["--units", "1,2;3"], p).status, 0);
    const afterFirst = JSON.parse(readFileSync(p, "utf8"));
    assert.equal(afterFirst.waves.length, 1);

    const second = run(["--units", "3;1,2"], p); // mesmo conjunto, unidades reordenadas
    assert.equal(second.status, 0);
    assert.match(second.stdout, /no-op idempotente/);
    const afterSecond = JSON.parse(readFileSync(p, "utf8"));
    assert.equal(afterSecond.waves.length, 1); // não inflou
  });

  it("onda com issues genuinamente diferentes grava normalmente", () => {
    const p = tmp('{"issues":[]}');
    assert.equal(run(["--units", "1;2"], p).status, 0);
    assert.equal(run(["--units", "3;4"], p).status, 0);
    const plan = JSON.parse(readFileSync(p, "utf8"));
    assert.equal(plan.waves.length, 2);
  });
});
