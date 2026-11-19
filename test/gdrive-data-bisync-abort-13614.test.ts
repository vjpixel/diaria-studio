/**
 * test/gdrive-data-bisync-abort-13614.test.ts (#13614)
 *
 * Duas frentes do mesmo achado (investigação da #13545): o bisync de `data/`
 * abortava com "corrupted on transfer: md5 hashes differ" num log do
 * overnight que crescia durante a cópia, e um aborto no meio de uma rodada
 * arma o `.conflictN` da rodada seguinte.
 *
 *   1. Os logs escritos continuamente saem do filtro do bisync de `data/`
 *      (a semântica real do rclone está em data-sync-exclusions-12357).
 *   2. `gdrive-bisync.sh` carimba `last-abort.json` quando o log traz
 *      `Bisync aborted`, e o `Diaria-GDrive-Sync-Alarm` cruza o carimbo com
 *      edição em curso (achado P1, issue + e-mail).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  evaluateGdriveSync,
  evaluateDataBisyncAbort,
  describeDataBisyncAbort,
  DATA_ABORT_WINDOW_MS,
  DATA_BISYNC_TARGET,
  DATA_GDRIVE_SYNC_TOLERANCES,
} from "../scripts/lib/gdrive-sync-alarm.ts";
import { evaluateGdriveQuota } from "../scripts/lib/gdrive-quota.ts";
import {
  collectGdriveAlarmFindings,
  buildGdriveAlarmEmail,
  listEditionsInProgress,
  ABORT_EDITION_STAGES,
  DATA_ABORT_CHECK,
  DATA_ABORT_DURING_EDITION,
} from "../scripts/gdrive-sync-alarm.ts";
import { alarmIssueStateKey, type AlarmFindingOutcome } from "../scripts/lib/alarm-issues.ts";

const ROOT = join(import.meta.dirname, "..");
const DATA_FILTERS = join(ROOT, "scripts", "systemd", "gdrive-data-bisync-filters.txt");
const SCRIPT = join(ROOT, "scripts", "systemd", "gdrive-bisync.sh");

describe("filtro do bisync de data/: logs escritos continuamente (#13614)", () => {
  const rules = readFileSync(DATA_FILTERS, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  it("exclui *.stderr.log em qualquer profundidade e os logs de overnight/ e continuo/ na raiz", () => {
    for (const r of ["- *.stderr.log", "- *.stderr.log.*", "- /overnight/*.log", "- /overnight/*.log.*", "- /continuo/*.log", "- /continuo/*.log.*"]) {
      assert.ok(rules.includes(r), `falta '${r}' no gdrive-data-bisync-filters.txt`);
    }
  });

  it("nunca exclui *.log global (logs curtos das tasks seguem sincronizando) nem inclui log", () => {
    assert.ok(!rules.includes("- *.log"));
    assert.ok(!rules.some((r) => r.startsWith("+") && r.includes(".log")));
  });
});

describe("evaluateDataBisyncAbort (#13614)", () => {
  const now = new Date("2026-11-18T04:00:00Z");
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();

  it("sem carimbo → no-abort", () => {
    assert.equal(evaluateDataBisyncAbort({ kind: "absent" }, ["261119"], now).verdict, "no-abort");
    assert.equal(evaluateDataBisyncAbort(null, ["261119"], now).verdict, "no-abort");
  });

  it("aborto recente com edição em curso → alarma (o cenário de 18/11 03:22 UTC com a 261118 aberta)", () => {
    const ev = evaluateDataBisyncAbort({ at: "2026-11-18T03:22:00Z", exit: 7 }, ["261118"], now);
    assert.equal(ev.verdict, "alarm-abort-during-edition");
    assert.equal(ev.abort?.exit, 7);
    assert.equal(ev.ageMs, 38 * 60_000);
  });

  it("aborto recente sem edição em curso → abort-no-edition (o caso real de 18/11, sem edição no Neo)", () => {
    assert.equal(evaluateDataBisyncAbort({ at: ago(10), exit: 7 }, [], now).verdict, "abort-no-edition");
  });

  it("edições ilegíveis (null) com aborto recente → alarma assim mesmo", () => {
    assert.equal(evaluateDataBisyncAbort({ at: ago(10), exit: 7 }, null, now).verdict, "alarm-abort-during-edition");
  });

  it("janela estrita: exatamente 2h ainda conta, 1 ms além não", () => {
    const at = (ms: number) => new Date(now.getTime() - ms).toISOString();
    assert.equal(evaluateDataBisyncAbort({ at: at(DATA_ABORT_WINDOW_MS), exit: 7 }, ["x"], now).verdict, "alarm-abort-during-edition");
    assert.equal(evaluateDataBisyncAbort({ at: at(DATA_ABORT_WINDOW_MS + 1000), exit: 7 }, ["x"], now).verdict, "no-abort");
  });

  it("carimbo ilegível ou no futuro → unmeasured, com motivo", () => {
    const bad = evaluateDataBisyncAbort({ kind: "unreadable", reason: "JSON inválido" }, ["x"], now);
    assert.equal(bad.verdict, "unmeasured");
    assert.match(bad.reason ?? "", /last-abort\.json: JSON inválido/);
    const fut = evaluateDataBisyncAbort({ at: new Date(now.getTime() + 60 * 60_000).toISOString(), exit: 7 }, ["x"], now);
    assert.equal(fut.verdict, "unmeasured");
  });

  it("texto aponta a invariante, o procedimento de restauração e o journal da unit", () => {
    const t = describeDataBisyncAbort(evaluateDataBisyncAbort({ at: ago(5), exit: 7 }, ["261118", "261119"], now));
    assert.match(t, /261118, 261119/);
    assert.match(t, /edition-sync-conflicts/);
    assert.match(t, /docs\/sync-conflict-restore\.md/);
    assert.match(t, /journalctl --user -u diaria-gdrive-data-bisync/);
  });
});

describe("Diaria-GDrive-Sync-Alarm: sinal de aborto (#13614)", () => {
  const now = new Date("2026-11-18T04:00:00Z");
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  const ok = evaluateGdriveSync({ at: ago(1), exit: 0 }, { at: ago(1), exit: 0 }, now, DATA_GDRIVE_SYNC_TOLERANCES);
  const notInstalled = evaluateGdriveSync({ kind: "absent" }, { kind: "absent" }, now, DATA_GDRIVE_SYNC_TOLERANCES);
  const QUOTA_OK = evaluateGdriveQuota({ total: 100, used: 10, free: 90, trashed: 0, other: 0 }, 90);
  const base = {
    sync: ok,
    quota: QUOTA_OK,
    quotaError: null,
    backend: "gdrive" as const,
    dataCfg: { errors: [] as string[], envFile: "/h/.config/diaria/gdrive-data-bisync.env", local: "/mnt/x", remoteName: "gdrive-diaria:" },
    dataSync: ok,
    dataTarget: DATA_BISYNC_TARGET,
    dataDirReal: null as string | null,
    dataDirResolved: true,
    platform: "linux" as NodeJS.Platform,
    dataQuota: QUOTA_OK,
    dataQuotaError: null,
  };
  const key = alarmIssueStateKey(DATA_ABORT_CHECK, DATA_ABORT_DURING_EDITION);
  const abortDuring = evaluateDataBisyncAbort({ at: ago(20), exit: 7 }, ["261118"], now);

  it("aborto com edição em curso → achado P1 com label de ação", () => {
    const r = collectGdriveAlarmFindings({ ...base, dataAbort: abortDuring });
    const f = r.findings.find((x) => x.check === DATA_ABORT_CHECK);
    assert.ok(f, "achado de aborto ausente");
    assert.equal(f.fingerprint, DATA_ABORT_DURING_EDITION);
    assert.equal(f.priority, "P1");
    assert.ok((f.labels ?? []).length >= 2, "label de ação ausente");
    assert.match(f.body, /261118/);
  });

  it("aborto sem edição, ou sem aborto → nenhum achado, e a ausência conta como medida (a issue pode fechar)", () => {
    for (const ev of [evaluateDataBisyncAbort({ at: ago(20), exit: 7 }, [], now), evaluateDataBisyncAbort({ kind: "absent" }, ["261118"], now)]) {
      const r = collectGdriveAlarmFindings({ ...base, dataAbort: ev });
      assert.equal(r.findings.some((x) => x.check === DATA_ABORT_CHECK), false);
      assert.equal(r.isAbsenceUnmeasured(key), false);
    }
  });

  it("sem medida (não avaliado, carimbo ilegível, bisync de data/ não instalado, Windows) → issue aberta congela", () => {
    assert.equal(collectGdriveAlarmFindings(base).isAbsenceUnmeasured(key), true);
    const bad = evaluateDataBisyncAbort({ kind: "unreadable", reason: "x" }, [], now);
    assert.equal(collectGdriveAlarmFindings({ ...base, dataAbort: bad }).isAbsenceUnmeasured(key), true);
    const noAbort = evaluateDataBisyncAbort({ kind: "absent" }, [], now);
    assert.equal(collectGdriveAlarmFindings({ ...base, dataSync: notInstalled, dataAbort: noAbort }).isAbsenceUnmeasured(key), true);
    const win = collectGdriveAlarmFindings({ ...base, platform: "win32", dataAbort: abortDuring });
    assert.equal(win.findings.some((x) => x.check === DATA_ABORT_CHECK), false);
    assert.equal(win.isAbsenceUnmeasured(key), true);
  });

  it("e-mail traz o aborto primeiro, com a issue", () => {
    const outcomes = [{ check: DATA_ABORT_CHECK, fingerprint: DATA_ABORT_DURING_EDITION, action: "created", issueNumber: 9, url: "u9" }] as unknown as AlarmFindingOutcome[];
    const e = buildGdriveAlarmEmail(outcomes, ok, QUOTA_OK, null, {
      sync: ok,
      target: DATA_BISYNC_TARGET,
      missingText: null,
      configErrors: [],
      envFile: "/h/.config/diaria/gdrive-data-bisync.env",
      quota: null,
      quotaUnmeasuredReason: null,
      remoteName: "gdrive-diaria:",
      abort: abortDuring,
    });
    assert.equal(e.subject, "⚠️ Google Drive: data/ bisync abortou com edição em curso");
    assert.match(e.body, /ABORTOU/);
    assert.match(e.body, /Issue: #9 \(u9\)/);
  });

  it("listEditionsInProgress: une os Stages 2-6 sem repetir; falha de leitura → null", () => {
    assert.deepEqual([...ABORT_EDITION_STAGES], [2, 3, 4, 5, 6]);
    const seen: number[] = [];
    const got = listEditionsInProgress("/r", (stage) => {
      seen.push(stage);
      return stage === 4 ? ["261119", "261118"] : stage === 5 ? ["261118"] : [];
    });
    assert.deepEqual(got, ["261118", "261119"]);
    assert.deepEqual(seen, [2, 3, 4, 5, 6]);
    const origError = console.error;
    console.error = () => {};
    try {
      assert.equal(
        listEditionsInProgress("/r", () => {
          throw new Error("EACCES");
        }),
        null,
      );
    } finally {
      console.error = origError;
    }
  });
});

/** Roda o `gdrive-bisync.sh` real com um rclone falso. `seq`: `"{exit}"` ou
 * `"{exit}:abort"` (imprime a linha de aborto do rclone antes de sair). */
function runScript(seq: string[], args: string[] = []) {
  const sb = mkdtempSync(join(tmpdir(), "gdrive-bisync-13614-"));
  try {
    const local = join(sb, "GoogleDrive");
    mkdirSync(local);
    writeFileSync(join(local, ".diaria-bisync-sentinel"), "");
    const stateDir = join(sb, "state");
    const counter = join(sb, "counter");
    const fakeRclone = join(sb, "rclone");
    writeFileSync(
      fakeRclone,
      [
        "#!/bin/sh",
        `n=$(cat "${counter}" 2>/dev/null || echo 0)`,
        "n=$((n + 1))",
        `echo "$n" > "${counter}"`,
        `spec=$(echo "${seq.join(",")}" | cut -d, -f"$n")`,
        '[ -n "$spec" ] || spec=0',
        'case "$spec" in *:abort) echo "ERROR : Bisync critical error: overnight/x.stderr.log: corrupted on transfer: md5 hashes differ" >&2; echo "ERROR : Bisync aborted. Must run --resync to recover." >&2 ;; esac',
        'exit "${spec%%:*}"',
        "",
      ].join("\n"),
    );
    chmodSync(fakeRclone, 0o755);
    const r = spawnSync("/bin/sh", [SCRIPT, ...args], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: sb,
        GDRIVE_MOUNT: sb,
        GDRIVE_LOCAL: local,
        RCLONE_BIN: fakeRclone,
        GDRIVE_MOUNTPOINT_CMD: "true",
        GDRIVE_STATE_DIR: stateDir,
        GDRIVE_AUTH_RETRY_DELAY: "0",
      },
    });
    const readJson = (f: string) => (existsSync(join(stateDir, f)) ? JSON.parse(readFileSync(join(stateDir, f), "utf8")) : null);
    return { status: r.status, stderr: r.stderr, lastRun: readJson("last-run.json"), lastAbort: readJson("last-abort.json") };
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
}

describe("gdrive-bisync.sh — carimbo do aborto (#13614)", { skip: process.platform === "win32" ? "script POSIX-only" : false }, () => {
  it("'Bisync aborted' no log → last-abort.json com o exit da tentativa", () => {
    const r = runScript(["7:abort"]);
    assert.equal(r.status, 7);
    assert.equal(r.lastAbort?.exit, 7);
    assert.ok(!Number.isNaN(Date.parse(r.lastAbort?.at)));
    assert.equal(r.lastRun?.exit, 7);
  });

  it("falha sem aborto, ou sucesso → nenhum carimbo de aborto", () => {
    assert.equal(runScript(["7"]).lastAbort, null);
    assert.equal(runScript(["0"]).lastAbort, null);
  });

  it("--dry-run nunca carimba o aborto", () => {
    assert.equal(runScript(["7:abort"], ["--dry-run"]).lastAbort, null);
  });
});
