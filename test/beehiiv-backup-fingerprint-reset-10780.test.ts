/**
 * test/beehiiv-backup-fingerprint-reset-10780.test.ts (#10780)
 *
 * Os 2 checks extras do alarme de backup Beehiiv (cobertura mensal e
 * exit-history, #10710) gravavam o fingerprint quando alarmavam e nunca o
 * zeravam no ok. A sequência incompleto → completo → incompleto terminava com
 * o mesmo fingerprint gravado e a recorrência passava calada.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planFingerprintedAlarm,
  computeExitHistoryFingerprint,
  computeCoverageFingerprint,
  BEEHIIV_BACKUP_COVERAGE_START_MONTH,
} from "../scripts/lib/beehiiv-backup-staleness-alarm.ts";
import { main as alarmMain } from "../scripts/beehiiv-backup-staleness-alarm.ts";

/** Simula N rodadas do alarme sobre um único campo de fingerprint. */
function simulate(sequence: Array<string | null>): string[] {
  let last: string | null = null;
  const sent: string[] = [];
  for (const fp of sequence) {
    const action = planFingerprintedAlarm(fp, last);
    if (action === "send" && fp) {
      sent.push(fp);
      last = fp;
    } else if (action === "reset") {
      last = null;
    }
  }
  return sent;
}

describe("#10780 — planFingerprintedAlarm", () => {
  it("exit-history incompleto → completo → incompleto alarma de novo", () => {
    const inc = computeExitHistoryFingerprint("incomplete");
    assert.deepEqual(simulate([inc, null, inc]), [inc, inc]);
  });

  it("cobertura: mês restaurado que some de novo com o mesmo conjunto alarma de novo", () => {
    const fp = computeCoverageFingerprint(["2026-08"]);
    assert.deepEqual(simulate([fp, null, fp]), [fp, fp]);
  });

  it("mesmo estado em rodadas seguidas não reenvia", () => {
    const inc = computeExitHistoryFingerprint("incomplete");
    assert.deepEqual(simulate([inc, inc, inc]), [inc]);
  });

  it("ações: send / skip / reset / noop", () => {
    assert.equal(planFingerprintedAlarm("a", null), "send");
    assert.equal(planFingerprintedAlarm("a", undefined), "send");
    assert.equal(planFingerprintedAlarm("b", "a"), "send");
    assert.equal(planFingerprintedAlarm("a", "a"), "skip");
    assert.equal(planFingerprintedAlarm(null, "a"), "reset");
    assert.equal(planFingerprintedAlarm(null, null), "noop");
    assert.equal(planFingerprintedAlarm(null, undefined), "noop");
  });
});

function monthsBetween(start: string, endExclusive: string): string[] {
  const out: string[] = [];
  let [y, m] = start.split("-").map(Number);
  for (;;) {
    const cur = `${y}-${String(m).padStart(2, "0")}`;
    if (cur >= endExclusive) break;
    out.push(cur);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

describe("#10780 — main() zera os fingerprints quando os checks voltam ao ok", () => {
  it("estado gravado com os 2 fingerprints + tudo ok → ambos viram null no state", async () => {
    const root = mkdtempSync(join(tmpdir(), "bh-10780-"));
    const origLog = console.log;
    console.log = () => {};
    try {
      const todayIso = new Date().toISOString().slice(0, 10);
      const cur = todayIso.slice(0, 7);
      // Snapshot de hoje, utilizável → alarme 1 fica em ok e não chama notify.
      mkdirSync(join(root, todayIso), { recursive: true });
      writeFileSync(join(root, todayIso, "subscribers.jsonl"), JSON.stringify({ email: "a@b.c" }) + "\n");
      // Um snapshot em cada mês fechado desde o início da cobertura.
      for (const month of monthsBetween(BEEHIIV_BACKUP_COVERAGE_START_MONTH, cur)) {
        mkdirSync(join(root, `${month}-01`), { recursive: true });
        writeFileSync(join(root, `${month}-01`, "subscribers.jsonl"), JSON.stringify({ email: "a@b.c" }) + "\n");
      }
      mkdirSync(join(root, "exit-history"), { recursive: true });
      writeFileSync(join(root, "exit-history", "manifest.json"), JSON.stringify({ complete: true }));

      const statePath = join(root, "state.json");
      writeFileSync(
        statePath,
        JSON.stringify({
          lastAlarmedFingerprint: null,
          lastCoverageFingerprint: computeCoverageFingerprint(["2026-08"]),
          lastExitHistoryFingerprint: computeExitHistoryFingerprint("incomplete"),
        }),
      );

      await alarmMain(["--root", root, "--state", statePath]);

      const state = JSON.parse(readFileSync(statePath, "utf8"));
      assert.equal(state.lastCoverageFingerprint, null);
      assert.equal(state.lastExitHistoryFingerprint, null);
    } finally {
      console.log = origLog;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--dry-run não grava o reset", async () => {
    const root = mkdtempSync(join(tmpdir(), "bh-10780-dry-"));
    const origLog = console.log;
    console.log = () => {};
    try {
      const todayIso = new Date().toISOString().slice(0, 10);
      const cur = todayIso.slice(0, 7);
      mkdirSync(join(root, todayIso), { recursive: true });
      writeFileSync(join(root, todayIso, "subscribers.jsonl"), JSON.stringify({ email: "a@b.c" }) + "\n");
      for (const month of monthsBetween(BEEHIIV_BACKUP_COVERAGE_START_MONTH, cur)) {
        mkdirSync(join(root, `${month}-01`), { recursive: true });
      }
      mkdirSync(join(root, "exit-history"), { recursive: true });
      writeFileSync(join(root, "exit-history", "manifest.json"), JSON.stringify({ complete: true }));
      const statePath = join(root, "state.json");
      const seeded = JSON.stringify({
        lastAlarmedFingerprint: null,
        lastCoverageFingerprint: null,
        lastExitHistoryFingerprint: computeExitHistoryFingerprint("incomplete"),
      });
      writeFileSync(statePath, seeded);

      await alarmMain(["--dry-run", "--root", root, "--state", statePath]);

      assert.equal(readFileSync(statePath, "utf8"), seeded);
    } finally {
      console.log = origLog;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
