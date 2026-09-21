import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeTouchByPhase,
  countDomainLiterals,
  flagStalledPhases,
  parseGitNumstatLog,
  summarizeAllowlistGrowth,
  summarizeCalibrationPrLatency,
} from "../scripts/lib/calibration-audit.ts";
import { previousQuarter } from "../scripts/calibration-allowlist-growth-report.ts";
import { parseTouchJsonl } from "../scripts/calibration-touch-minutes-report.ts";
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

describe("#7982 tasks agendadas declaradas", () => {
  it("registradas, mensais, sem colisão de horário", () => {
    for (const [n, script] of [
      ["Diaria-Calibration-Allowlist-Audit-Quarterly", "scripts/calibration-allowlist-growth-report.ts"],
      ["Diaria-Calibration-Touch-Minutes-Monthly", "scripts/calibration-touch-minutes-report.ts"],
    ] as const) {
      const t = getScheduledTaskByName(n);
      assert.ok(t, n);
      assert.equal(t!.steps[0].script, script);
      assert.equal(t!.schedule.kind, "monthly");
      const clash = SCHEDULED_TASKS.filter(
        (o) => o.name !== n && JSON.stringify(o.schedule) === JSON.stringify(t!.schedule),
      );
      assert.deepEqual(clash, []);
    }
  });
});
