/**
 * test/beehiiv-backup-10710.test.ts (#10710)
 *
 * Regressão das duas lacunas do histórico Beehiiv achadas em 21/10/2026:
 *
 * 1. Snapshots de `data/beehiiv-backup/` anteriores a 04/10 sumiram (remoção
 *    vinda do OneDrive remoto em 14/10). O relatório do gc-data-dir listava
 *    todos eles como "liberariam" — agora poupa o mais antigo de cada mês —
 *    e o alarme semanal passa a acusar mês fechado sem nenhum snapshot.
 * 2. `exit-history/` nunca foi gravado: o agent `beehiiv-exit-history-drain`
 *    (#7248) não era despachado por nada. Agora o Stage 0 pede o dispatch
 *    enquanto o manifest não estiver completo, e o alarme acusa a ausência.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planBeehiivSnapshotReport } from "../scripts/lib/data-dir-gc-policy.ts";
import {
  findMonthsWithoutSnapshot,
  computeCoverageFingerprint,
  buildCoverageAlarmEmail,
  BEEHIIV_BACKUP_COVERAGE_START_MONTH,
} from "../scripts/lib/beehiiv-backup-staleness-alarm.ts";
import { exitHistoryDrainStatus } from "../scripts/lib/beehiiv-exit-history.ts";
import { planExitHistoryDispatch } from "../scripts/stage-0-run.ts";
import { main as alarmMain } from "../scripts/beehiiv-backup-staleness-alarm.ts";

// Os 13 snapshots que o relatório de 10/10/2026 (data/gc-data-dir/.gc.log) listava.
const SNAPSHOTS_261010 = [
  "2026-06-05",
  "2026-06-17",
  "2026-08-14",
  "2026-08-16",
  "2026-08-21",
  "2026-08-23",
  "2026-08-26",
  "2026-08-30",
  "2026-09-06",
  "2026-09-13",
  "2026-09-20",
  "2026-09-27",
  "2026-10-04",
];

describe("#10710 — planBeehiivSnapshotReport poupa o mais antigo de cada mês", () => {
  it("cenário real de 10/10: o relatório não lista mais o único registro de cada mês como dispensável", () => {
    const snaps = SNAPSHOTS_261010.map((d) => ({ relPath: `beehiiv-backup/${d}`, sizeBytes: 10 }));
    const r = planBeehiivSnapshotReport(snaps, 4);
    const kept = r.kept.map((s) => s.relPath.slice("beehiiv-backup/".length));
    const removed = r.wouldRemove.map((s) => s.relPath.slice("beehiiv-backup/".length));
    // 4 mais recentes (10-04 … 09-13) + piso mensal: 09-06 (set), 08-14 (ago), 06-05 (jun).
    assert.deepEqual(kept, ["2026-10-04", "2026-09-27", "2026-09-20", "2026-09-13", "2026-09-06", "2026-08-14", "2026-06-05"]);
    assert.deepEqual(removed, ["2026-08-30", "2026-08-26", "2026-08-23", "2026-08-21", "2026-08-16", "2026-06-17"]);
    assert.deepEqual(
      r.monthlyFloor.map((s) => s.relPath),
      ["beehiiv-backup/2026-09-06", "beehiiv-backup/2026-08-14", "beehiiv-backup/2026-06-05"],
    );
    // Antes do fix o relatório dizia "9 liberariam" — inclusive todo o histórico de junho e agosto.
    for (const month of ["2026-06", "2026-08", "2026-09", "2026-10"]) {
      assert.ok(kept.some((d) => d.startsWith(month)), `mês ${month} precisa manter ao menos 1 snapshot`);
    }
  });

  it("keep=1 com um snapshot por mês não libera nada", () => {
    const snaps = ["2026-07-05", "2026-08-02", "2026-09-06"].map((d) => ({ relPath: `beehiiv-backup/${d}`, sizeBytes: 1 }));
    const r = planBeehiivSnapshotReport(snaps, 1);
    assert.equal(r.wouldRemove.length, 0);
    assert.equal(r.kept.length, 3);
  });

  it("nunca poda o mais antigo do mês, mesmo quando é o único fora do top-N", () => {
    const snaps = ["2026-09-06", "2026-09-13", "2026-09-20"].map((d) => ({ relPath: `beehiiv-backup/${d}`, sizeBytes: 1 }));
    const r = planBeehiivSnapshotReport(snaps, 1);
    assert.deepEqual(
      r.wouldRemove.map((s) => s.relPath),
      ["beehiiv-backup/2026-09-13"],
    );
  });
});

describe("#10710 — findMonthsWithoutSnapshot (cobertura mensal)", () => {
  it("#11067: perda reconhecida de agosto/setembro não alarma; outubro ausente continua alarmando", () => {
    assert.deepEqual(findMonthsWithoutSnapshot(["2026-10-04"], "2026-10-26"), []);
    assert.deepEqual(findMonthsWithoutSnapshot([], "2026-11-01"), ["2026-10"]);
  });

  it("estado real de 21/10/2026: só restam 04, 11 e 18/10 → acusa agosto e setembro", () => {
    const missing = findMonthsWithoutSnapshot(["2026-10-04", "2026-10-11", "2026-10-18"], "2026-10-21", "2026-08", []);
    assert.deepEqual(missing, ["2026-08", "2026-09"]);
  });

  it("começa no 1º mês da task semanal (default) e ignora meses anteriores", () => {
    assert.equal(BEEHIIV_BACKUP_COVERAGE_START_MONTH, "2026-08");
    assert.deepEqual(findMonthsWithoutSnapshot(["2026-08-16", "2026-09-06"], "2026-10-02", undefined, []), []);
  });

  it("mês corrente nunca alarma (ainda pode receber o snapshot de domingo)", () => {
    assert.deepEqual(findMonthsWithoutSnapshot(["2026-08-16", "2026-09-06"], "2026-10-01", "2026-08", []), []);
  });

  it("vira o ano corretamente", () => {
    const missing = findMonthsWithoutSnapshot(["2026-11-01"], "2027-02-10", "2026-11", []);
    assert.deepEqual(missing, ["2026-12", "2027-01"]);
  });

  it("mês reconhecido como perdido sai do alarme", () => {
    assert.deepEqual(findMonthsWithoutSnapshot(["2026-10-04"], "2026-10-21", "2026-08", ["2026-08"]), ["2026-09"]);
  });

  it("fingerprint estável por conjunto e e-mail cita a Lixeira do OneDrive", () => {
    assert.equal(computeCoverageFingerprint(["2026-09", "2026-08"]), computeCoverageFingerprint(["2026-08", "2026-09"]));
    assert.notEqual(computeCoverageFingerprint(["2026-08"]), computeCoverageFingerprint(["2026-08", "2026-09"]));
    const { subject, body } = buildCoverageAlarmEmail(["2026-08", "2026-09"]);
    assert.match(subject, /2026-08, 2026-09/);
    assert.match(body, /Lixeira online do OneDrive/);
  });
});

describe("#10710 — exitHistoryDrainStatus", () => {
  it("ausente / incompleto / ilegível / completo", () => {
    assert.equal(exitHistoryDrainStatus(null), "missing");
    assert.equal(exitHistoryDrainStatus(JSON.stringify({ complete: false, pages_fetched: 3 })), "incomplete");
    assert.equal(exitHistoryDrainStatus("{não é json"), "unreadable");
    assert.equal(exitHistoryDrainStatus(JSON.stringify({ pages_fetched: 3 })), "unreadable");
    assert.equal(exitHistoryDrainStatus(""), "unreadable");
    assert.equal(exitHistoryDrainStatus(JSON.stringify({ complete: true })), "complete");
  });
});

describe("#10710 — Stage 0 pede o dispatch do beehiiv-exit-history-drain (0h.4)", () => {
  function fsDeps(files: Record<string, string>, dirs: string[]) {
    return {
      rootDir: "/repo",
      existsSync: (p: string) => p in files || dirs.includes(p),
      readFile: (p: string) => {
        if (p in files) return files[p];
        throw new Error(`ENOENT ${p}`);
      },
    };
  }

  it("manifest ausente com data/beehiiv-backup/ presente → dispatch 0h.4 (o estado encontrado em 21/10)", () => {
    const d = planExitHistoryDispatch(fsDeps({}, ["/repo/data/beehiiv-backup"]));
    assert.ok(d);
    assert.equal(d!.step, "0h.4");
    assert.equal(d!.agent, "beehiiv-exit-history-drain");
    assert.equal(d!.manifestPath, "data/beehiiv-backup/exit-history/manifest.json");
    assert.match(d!.detail, /missing/);
  });

  it("manifest incompleto → dispatch; completo → nada", () => {
    const path = "/repo/data/beehiiv-backup/exit-history/manifest.json";
    const incompleto = planExitHistoryDispatch(fsDeps({ [path]: JSON.stringify({ complete: false }) }, ["/repo/data/beehiiv-backup"]));
    assert.match(incompleto!.detail, /incomplete/);
    assert.equal(planExitHistoryDispatch(fsDeps({ [path]: JSON.stringify({ complete: true }) }, ["/repo/data/beehiiv-backup"])), null);
  });

  it("sem data/beehiiv-backup/ (sessão cloud, clone fresco) → nunca despacha", () => {
    assert.equal(planExitHistoryDispatch(fsDeps({}, [])), null);
  });
});

describe("#10710 — beehiiv-backup-staleness-alarm.ts --dry-run cobre os 2 checks novos", () => {
  it("snapshot do mês corrente + exit-history ausente → respeita perdas reconhecidas, sem gravar estado", async () => {
    const root = mkdtempSync(join(tmpdir(), "bh-10710-"));
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      const today = new Date();
      const cur = today.toISOString().slice(0, 7);
      mkdirSync(join(root, `${cur}-01`), { recursive: true });
      writeFileSync(join(root, `${cur}-01`, "subscribers.jsonl"), "");
      const statePath = join(root, "state.json");
      await alarmMain(["--dry-run", "--root", root, "--state", statePath]);
      const out = logs.join("\n");
      assert.match(out, /exit-history: missing/);
      assert.match(out, /registraria alarme \(beehiiv-exit-history\)/);
      const missing = findMonthsWithoutSnapshot([`${cur}-01`], today.toISOString());
      assert.ok(!missing.includes("2026-08") && !missing.includes("2026-09"));
      assert.ok(out.includes(`cobertura mensal: ${missing.length ? `faltando ${missing.join(", ")}` : "ok"}`));
      assert.equal(out.includes("registraria alarme (beehiiv-backup-monthly-coverage)"), missing.length > 0);
      assert.match(out, /estado NÃO gravado/);
    } finally {
      console.log = origLog;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
