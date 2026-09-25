import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeCalibrationDecisionUpdates,
  computeTouchByPhase,
  countDomainLiterals,
  flagStalledPhases,
  parseGitNumstatLog,
  summarizeAllowlistGrowth,
  summarizeCalibrationPrLatency,
  type CalibrationPrState,
} from "../scripts/lib/calibration-audit.ts";
import { previousQuarter } from "../scripts/calibration-allowlist-growth-report.ts";
import { addMonths } from "../scripts/lib/calibration-audit.ts";
import { parseTouchJsonl, validatePhases } from "../scripts/calibration-touch-minutes-report.ts";
import { getScheduledTaskByName, SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";

describe("#7982 allowlist growth", () => {
  it("parseia git numstat e agrega por arquivo", () => {
    const log =
      "@@aaa|2026-07-02T10:00:00-03:00|feat: add x\n3\t1\tscripts/lib/official-domains.ts\n\n" +
      "@@bbb|2026-08-01T10:00:00-03:00|feat: add y\n2\t0\tscripts/lib/official-domains.ts\n-\t-\tscripts/lib/other.ts\n";
    const commits = parseGitNumstatLog(log);
    assert.equal(commits.length, 3);
    const s = summarizeAllowlistGrowth(commits, ["scripts/lib/official-domains.ts"], {
      "scripts/lib/official-domains.ts": { start: 10, end: 14 },
    });
    assert.equal(s.perFile[0].commits, 2);
    assert.equal(s.perFile[0].linesAdded, 5);
    assert.equal(s.netLines, 4);
    assert.equal(s.perFile[0].sizeEnd, 14);
  });
  it("countDomainLiterals conta hosts e host/path", () => {
    assert.equal(countDomainLiterals('domains: ["openai.com", "blog.google/products"], x: "abc"'), 2);
  });
  it("previousQuarter", () => {
    assert.deepEqual(previousQuarter(new Date("2026-01-15T00:00:00Z")), {
      since: "2025-10-01",
      until: "2026-01-01",
      label: "2025-Q4",
    });
    assert.equal(previousQuarter(new Date("2026-09-20T00:00:00Z")).label, "2026-Q2");
  });
});

describe("#7982 touch minutes por fase", () => {
  const mk = (edition: string, total: number) => ({ edition, editMinutes: total - 5, signoffMinutes: 5 });
  const phases = [{ name: "Fase X", activatedAt: "2026-03-01" }];
  const before = ["251201", "251215", "260110", "260201"].map((e) => mk(e, 40));
  const done = new Date("2026-09-20");
  it("reduziu quando a média cai", () => {
    const after = ["260305", "260405", "260505"].map((e) => mk(e, 20));
    const [r] = computeTouchByPhase([...before, ...after], phases, { months: 3, now: done });
    assert.equal(r.verdict, "reduziu");
  });
  it("sinalizada quando não cai e a janela completou", () => {
    const after = ["260305", "260405", "260505"].map((e) => mk(e, 45));
    const res = computeTouchByPhase([...before, ...after], phases, { months: 3, now: done });
    assert.equal(flagStalledPhases(res).length, 1);
  });
  it("em-observacao antes de N meses; sem-dados com poucas edições", () => {
    const after = ["260305", "260405", "260505"].map((e) => mk(e, 45));
    assert.equal(
      computeTouchByPhase([...before, ...after], phases, { months: 3, now: new Date("2026-04-20") })[0].verdict,
      "em-observacao",
    );
    assert.equal(computeTouchByPhase(before, phases, { months: 3, now: done })[0].verdict, "sem-dados");
  });
  it("parseTouchJsonl descarta linhas inválidas", () => {
    const r = parseTouchJsonl('{"edition":"260901","editMinutes":20,"signoffMinutes":5}\nlixo\n{"edition":"x"}\n');
    assert.equal(r.samples.length, 1);
    assert.equal(r.skipped, 2);
  });
});

describe("#7982 latência de PRs de calibração", () => {
  it("calcula mediana e lista os sem campos", () => {
    const s = summarizeCalibrationPrLatency([
      { id: "calibration-1", kind: "calibration", sessionId: "1", createdAt: "2026-09-01T00:00:00Z", decisionAt: "2026-09-01T10:00:00Z", estimatedReviewMinutes: 5 },
      { id: "calibration-2", kind: "calibration", sessionId: "2", createdAt: "2026-09-02T00:00:00Z" },
      { id: "overnight-1", kind: "overnight", sessionId: "3", createdAt: "2026-09-02T00:00:00Z" },
    ]);
    assert.equal(s.rows.length, 2);
    assert.equal(s.medianLatencyHours, 10);
    assert.deepEqual(s.missingFields, ["2"]);
  });
});

describe("#7982 produtor de decisionAt/estimatedReviewMinutes", () => {
  const entries = [
    { id: "calibration-1", kind: "calibration" as const, sessionId: "1", createdAt: "2026-09-01T00:00:00Z" },
    { id: "calibration-2", kind: "calibration" as const, sessionId: "2", createdAt: "2026-09-02T00:00:00Z" },
    { id: "calibration-3", kind: "calibration" as const, sessionId: "3", createdAt: "2026-09-03T00:00:00Z", decisionAt: "2026-09-03T01:00:00Z" },
  ];
  it("gera update só para PR mergeada, calcula minutos entre createdAt e mergedAt", () => {
    const prStates = new Map<string, CalibrationPrState>([
      ["1", { merged: true, mergedAt: "2026-09-01T02:00:00Z" }],
      ["2", { merged: false, mergedAt: null }],
    ]);
    const updates = computeCalibrationDecisionUpdates(entries, prStates);
    assert.deepEqual(updates, [{ sessionId: "1", decisionAt: "2026-09-01T02:00:00Z", estimatedReviewMinutes: 120 }]);
  });
  it("entrada com decisionAt já gravado nunca é recalculada, mesmo se prStates tiver dado novo", () => {
    const prStates = new Map<string, CalibrationPrState>([["3", { merged: true, mergedAt: "2026-09-05T00:00:00Z" }]]);
    assert.deepEqual(computeCalibrationDecisionUpdates(entries, prStates), []);
  });
  it("PR não encontrada em prStates: sem update", () => {
    assert.deepEqual(computeCalibrationDecisionUpdates(entries, new Map()), []);
  });
  it("mergedAt anterior a createdAt (dado inconsistente): sem update", () => {
    const prStates = new Map<string, CalibrationPrState>([["1", { merged: true, mergedAt: "2026-08-01T00:00:00Z" }]]);
    assert.deepEqual(computeCalibrationDecisionUpdates(entries, prStates), []);
  });
});

describe("#7982 tasks agendadas declaradas", () => {
  it("registradas, mensais, sem colisão de horário", () => {
    for (const [n, script] of [
      ["Diaria-Calibration-Allowlist-Audit-Quarterly", "scripts/calibration-allowlist-growth-report.ts"],
      ["Diaria-Calibration-Touch-Minutes-Monthly", "scripts/calibration-touch-minutes-report.ts"],
    ] as const) {
      const t = getScheduledTaskByName(n);
      assert.ok(t, n);
      // A task de toque tem 2 steps (#7982): derive ANTES do report.
      const scripts = t!.steps.map((st) => st.script);
      assert.equal(scripts[scripts.length - 1], script);
      if (n.includes("Touch-Minutes")) {
        assert.deepEqual(scripts, ["scripts/derive-touch-minutes.ts", script]);
      } else {
        // #7982: o produtor de decisionAt roda ANTES do relatório trimestral — sem
        // ele a seção de latência sai sempre n/d.
        assert.deepEqual(scripts, ["scripts/record-calibration-pr-decisions.ts", script]);
        assert.deepEqual(t!.steps[0].args, ["--write"]);
      }
      assert.equal(t!.schedule.kind, "monthly");
      const clash = SCHEDULED_TASKS.filter(
        (o) => o.name !== n && JSON.stringify(o.schedule) === JSON.stringify(t!.schedule),
      );
      assert.deepEqual(clash, []);
    }
  });
});

describe("#7982 review fixes", () => {
  const mk = (edition: string, total: number) => ({ edition, editMinutes: total - 5, signoffMinutes: 5 });
  it("empate de média => sinalizada", () => {
    const s = [...["251201", "251215", "260110"].map((e) => mk(e, 40)), ...["260305", "260405", "260505"].map((e) => mk(e, 40))];
    const [r] = computeTouchByPhase(s, [{ name: "F", activatedAt: "2026-03-01" }], { months: 3, now: new Date("2026-09-20") });
    assert.equal(r.verdict, "sinalizada");
  });
  it("latência filtra por createdAt em [since, until)", () => {
    const e = (id: string, createdAt: string) => ({ id, kind: "calibration", sessionId: id, createdAt });
    const s = summarizeCalibrationPrLatency([e("1", "2026-06-30T23:00:00Z"), e("2", "2026-07-01T00:00:00Z"), e("3", "2026-10-01T00:00:00Z")], { since: "2026-07-01", until: "2026-10-01" });
    assert.deepEqual(s.rows.map((r) => r.pr), ["2"]);
  });
  it("validatePhases rejeita não-array e activatedAt inválido", () => {
    assert.ok("error" in validatePhases({}));
    assert.ok("error" in validatePhases([{ name: "F", activatedAt: "2026-13-45" }]));
    assert.ok("error" in validatePhases([{ name: "F", activatedAt: "01/03/2026" }]));
    assert.ok("phases" in validatePhases([{ name: "F", activatedAt: "2026-03-01" }]));
  });
  it("--months inválido sai 2", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/calibration-touch-minutes-report.ts", "--months", "0"], { encoding: "utf-8" });
    assert.equal(r.status, 2);
  });
  it("addMonths não transborda mês", () => {
    assert.equal(addMonths(new Date("2026-03-31T00:00:00Z"), -1).toISOString().slice(0, 10), "2026-02-28");
    assert.equal(addMonths(new Date("2024-03-31T00:00:00Z"), -1).toISOString().slice(0, 10), "2024-02-29");
    assert.equal(addMonths(new Date("2026-11-30T00:00:00Z"), 3).toISOString().slice(0, 10), "2027-02-28");
  });
  it("countDomainLiterals: aspas simples, host/path; other.ts ignorado", () => {
    assert.equal(countDomainLiterals("['openai.com', 'blog.google/products']"), 2);
    const commits = parseGitNumstatLog("@@a|2026-07-01T00:00:00Z|x\n1\t0\tscripts/lib/other.ts\n");
    assert.equal(summarizeAllowlistGrowth(commits, ["scripts/lib/official-domains.ts"]).totalCommits, 0);
  });
});
