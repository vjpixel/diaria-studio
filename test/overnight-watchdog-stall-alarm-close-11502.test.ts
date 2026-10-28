/**
 * #11502: as issues de alarme de STALL das rodadas 261025 (#11063) e 261027b
 * (#11272) continuavam abertas depois que as rodadas morreram — o watchdog só
 * avalia a rodada ATIVA (`findActiveRun`), e nada fechava o alarme de uma
 * rodada encerrada, superada ou abandonada. Agora `runWatchdogForKind` chama
 * `closeEndedRunStallAlarms` a cada execução (fora do dry-run).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeEndedRunStallAlarms,
  findActiveRun,
  planStallAlarmClosures,
} from "../scripts/overnight-watchdog.ts";
import { alarmFindingMarker, type GhRunFn } from "../scripts/lib/alarm-issues.ts";

const stall = (n: number, fp: string) => ({ number: n, body: `Rodada parada.\n\n${alarmFindingMarker("overnight-watchdog-stall", fp)}` });
const semRetomada = (n: number, fp: string) => ({
  number: n,
  body: `Escalada.\n\n${alarmFindingMarker("overnight-watchdog-stall-sem-retomada", fp)}`,
});

describe("#11502 — planStallAlarmClosures (puro)", () => {
  const issues = [
    stall(11063, "overnight:261025"),
    stall(11272, "overnight:261027b"),
    semRetomada(11280, "overnight:261027b:sem-retomada"),
    stall(11500, "overnight:261028"),
    stall(9000, "continuo:261020"),
    { number: 7000, body: alarmFindingMarker("outro-alarme", "overnight:261025") },
    stall(7001, "overnight:lixo"),
    { number: 7002, body: null },
  ];

  it("caso real: rodada ativa 261028 → fecha as de 261025 e 261027b (inclusive a escalada), mantém a ativa", () => {
    const closures = planStallAlarmClosures(issues, "overnight", "261028");
    assert.deepEqual(closures.map((c) => c.issueNumber).sort(), [11063, 11272, 11280]);
    assert.deepEqual(closures.find((c) => c.issueNumber === 11280)?.round, "261027b");
  });

  it("nenhuma rodada ativa → fecha todas as do kind, inclusive a da rodada que acabou de terminar", () => {
    const closures = planStallAlarmClosures(issues, "overnight", null);
    assert.deepEqual(closures.map((c) => c.issueNumber).sort(), [11063, 11272, 11280, 11500]);
  });

  it("outro kind, outro check, fingerprint ilegível e corpo vazio nunca entram", () => {
    const n = planStallAlarmClosures(issues, "overnight", null).map((c) => c.issueNumber);
    for (const x of [9000, 7000, 7001, 7002]) assert.ok(!n.includes(x), `#${x}`);
  });
});

describe("#11502 — closeEndedRunStallAlarms (I/O injetável)", () => {
  function fakeGh(list: unknown, closeStatus = 0): { run: GhRunFn; calls: string[][] } {
    const calls: string[][] = [];
    const run: GhRunFn = (args) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "list") return { status: 0, stdout: JSON.stringify(list), stderr: "" };
      return { status: closeStatus, stdout: "", stderr: "" };
    };
    return { run, calls };
  }

  it("fecha com --reason 'not planned' e comentário citando a rodada", () => {
    const { run, calls } = fakeGh([stall(11063, "overnight:261025"), stall(11500, "overnight:261028")]);
    const r = closeEndedRunStallAlarms("/x", "overnight", "261028", run);
    assert.deepEqual(r, { listed: true, closed: [11063], failed: [] });
    const close = calls.find((a) => a[1] === "close")!;
    assert.equal(close[2], "11063");
    assert.ok(close.includes("not planned"));
    assert.match(close[close.indexOf("--comment") + 1], /rodada 261025 \(overnight\)/);
    assert.ok(calls[0].includes("--label") && calls[0].includes("alarm"));
  });

  it("fail-soft: listagem falha ou JSON ruim → listed false, nada fechado, nunca lança", () => {
    const failing: GhRunFn = () => ({ status: 1, stdout: "", stderr: "boom" });
    assert.deepEqual(closeEndedRunStallAlarms("/x", "overnight", null, failing), { listed: false, closed: [], failed: [] });
    const bad: GhRunFn = () => ({ status: 0, stdout: "{nao json", stderr: "" });
    assert.equal(closeEndedRunStallAlarms("/x", "overnight", null, bad).listed, false);
  });

  it("fechamento que falha vai pra failed (retry na próxima execução)", () => {
    const { run } = fakeGh([stall(11063, "overnight:261025")], 1);
    assert.deepEqual(closeEndedRunStallAlarms("/x", "overnight", null, run), { listed: true, closed: [], failed: [11063] });
  });
});

describe("#11502 — com rodadas reais em disco (findActiveRun + fechamento)", () => {
  const roots: string[] = [];
  after(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  it("rodada encerrada (report.md) sem atividade nova → a reconciliação fecha a issue dela", () => {
    const root = mkdtempSync(join(tmpdir(), "watchdog-11502-"));
    roots.push(root);
    const dir = join(root, "data", "overnight", "261025");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan.json"), JSON.stringify({ started_at: "2026-10-25T03:00:00Z" }));
    writeFileSync(join(dir, "report.md"), "# fim\n");
    const active = findActiveRun(root, "overnight", { lastActivityOf: () => ({ ts: Date.now(), source: "test" }) });
    assert.equal(active, null);
    const run: GhRunFn = (args) =>
      args[1] === "list"
        ? { status: 0, stdout: JSON.stringify([stall(11063, "overnight:261025")]), stderr: "" }
        : { status: 0, stdout: "", stderr: "" };
    const activeRound: string | null = active === null ? null : (active as { aammdd: string }).aammdd;
    assert.deepEqual(closeEndedRunStallAlarms(root, "overnight", activeRound, run).closed, [11063]);
  });

  it("o main path chama a reconciliação antes do return de 'nenhuma rodada ativa'", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", "overnight-watchdog.ts"), "utf8");
    const fn = src.slice(src.indexOf("async function runWatchdogForKind("));
    const callAt = fn.indexOf("closeEndedRunStallAlarms(ROOT, kind, active?.aammdd ?? null)");
    const earlyReturnAt = fn.indexOf("Nenhuma rodada ${kind} ativa detectada");
    assert.ok(callAt > 0, "runWatchdogForKind chama closeEndedRunStallAlarms");
    assert.ok(callAt < earlyReturnAt, "antes do return sem rodada ativa");
  });
});
