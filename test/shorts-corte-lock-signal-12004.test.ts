import { it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

// #12022 (renovação do lock na rodada manual): o sinal para a renovação junto com a liberação,
// e nenhuma batida tardia recria o lock; na saída normal a renovação não segura o processo.
function spawnWithHeartbeat(path: string, body: string) {
  return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { registerCorteLockCleanup } from './scripts/publish-shorts.ts';
    import { acquireTimerLock } from './scripts/lib/diaria/timer-lock.ts';
    const release = registerCorteLockCleanup(acquireTimerLock(${JSON.stringify(path)}, Date.now(), { heartbeatMs: 40 }));
    ${body}
  `], { stdio: ["ignore", "pipe", "pipe"] });
}

it("#12004 SIGTERM com renovação ativa libera o lock e nenhuma renovação o recria", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "corte-signal-beat-"));
  const path = join(dir, ".shorts-corte-timer.lock");
  const child = spawnWithHeartbeat(path, `
    setInterval(() => {}, 1000);
    setTimeout(() => console.log('ready'), 200); // algumas renovações antes do sinal
  `);
  try {
    await once(child.stdout, "data");
    assert.ok(JSON.parse(readFileSync(path, "utf8")).beat_at, "renovação rodou antes do sinal");
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    assert.deepEqual(await exited, [null, "SIGTERM"]);
    assert.equal(existsSync(path), false);
    await new Promise((r) => setTimeout(r, 300)); // > 7 intervalos de renovação
    assert.equal(existsSync(path), false, "renovação tardia não recriou o lock");
  } finally {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

// #12157: a renovação truncava e reescrevia o arquivo no lugar; quem lia o lock nessa janela
// (o teste acima, ou outro processo conferindo o dono) via o arquivo vazio e o JSON.parse
// estourava "Unexpected end of JSON input". Renovando a cada 1 ms em outro processo, nenhuma
// leitura pode ver o lock vazio ou truncado, e nenhum temporário sobra no diretório.
it("#12157 leitura concorrente nunca vê o lock vazio durante a renovação", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "corte-beat-read-"));
  const path = join(dir, ".shorts-corte-timer.lock");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { acquireTimerLock } from './scripts/lib/diaria/timer-lock.ts';
    const release = acquireTimerLock(${JSON.stringify(path)}, Date.now(), { heartbeatMs: 1 });
    setInterval(() => {}, 1000);
    setTimeout(() => console.log('ready'), 50);
    process.on('SIGTERM', () => { release(); process.exit(0); });
  `], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await once(child.stdout, "data");
    let reads = 0;
    let beats = 0;
    const bad: string[] = [];
    const end = Date.now() + 1500;
    while (Date.now() < end) {
      const raw = readFileSync(path, "utf8");
      reads++;
      try {
        if (JSON.parse(raw).beat_at) beats++;
      } catch {
        bad.push(JSON.stringify(raw));
      }
      // Cede o processador ao filho de vez em quando (em CI com pouco núcleo o loop o sufocaria).
      if (reads % 200 === 0) await new Promise((r) => setImmediate(r));
    }
    assert.deepEqual(bad.slice(0, 3), [], `${bad.length} de ${reads} leituras viram o lock vazio/truncado`);
    assert.ok(beats > 0, "a renovação rodou durante as leituras");
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    assert.deepEqual(readdirSync(dir), [], "release apagou o lock e nenhum temporário sobrou");
  } finally {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

it("#12004 conclusão normal com renovação ativa: lock liberado e o processo sai sozinho", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "corte-normal-beat-"));
  const path = join(dir, ".shorts-corte-timer.lock");
  const child = spawnWithHeartbeat(path, `setTimeout(() => { release(); console.log('released'); }, 200);`);
  try {
    // Sem handle pendurado: sai com 0 sem precisar de sinal.
    assert.deepEqual(await once(child, "exit"), [0, null]);
    assert.equal(existsSync(path), false);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(existsSync(path), false);
  } finally {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

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
