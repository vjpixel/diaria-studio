import { it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { registerCorteLockCleanup, corteTimerLockBusyError } from "../scripts/publish-shorts.ts";
import { acquireTimerLock } from "../scripts/lib/diaria/timer-lock.ts";

for (const [signal, expected] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  it(`#12004 ${signal} libera imediatamente o lock para outra rodada`, { timeout: 15000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "corte-signal-"));
    const path = join(dir, ".shorts-corte-timer.lock");
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { registerCorteLockCleanup } from './scripts/publish-shorts.ts';
      import { acquireTimerLock } from './scripts/lib/diaria/timer-lock.ts';
      registerCorteLockCleanup(acquireTimerLock(${JSON.stringify(path)}));
      setInterval(() => {}, 1000);
      console.log('ready');
    `], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await once(child.stdout, "data");
      assert.ok(existsSync(path));
      assert.equal(acquireTimerLock(path), null);
      const exited = once(child, "exit");
      child.kill(signal);
      // Re-emite o sinal com o handler removido (#9911: sem process.exit): morre pelo
      // próprio sinal, status de shell 128+n = 130 (SIGINT) / 143 (SIGTERM).
      assert.deepEqual(await exited, [null, signal]);
      assert.equal(128 + constants.signals[signal], expected);
      assert.equal(existsSync(path), false);
      const release = acquireTimerLock(path);
      assert.ok(release);
      release();
    } finally {
      child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

it("#12004 conclusão normal remove handlers e libera uma única vez", () => {
  const events = ["exit", "SIGINT", "SIGTERM"] as const;
  const before = events.map((e) => process.listenerCount(e));
  let calls = 0;
  const release = registerCorteLockCleanup(() => { calls++; });
  release();
  release();
  assert.equal(calls, 1);
  assert.deepEqual(events.map((e) => process.listenerCount(e)), before);
  const src = readFileSync(new URL("../scripts/publish-shorts.ts", import.meta.url), "utf8");
  assert.match(src, /releaseCorteLock = registerCorteLockCleanup\(rel\)/);
  assert.match(corteTimerLockBusyError("teste"), /manual ou timer/);
  assert.doesNotMatch(corteTimerLockBusyError("teste"), /o timer do 300 .*está publicando/);
});
