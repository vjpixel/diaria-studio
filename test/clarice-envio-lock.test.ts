import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireEnvioLock,
  releaseEnvioLock,
  isLockStale,
  lockPathForCycle,
  LockHeldError,
  STALE_LOCK_MS,
  breakEnvioLock,
  isPidAlive,
  main,
} from "../scripts/lib/clarice-envio-lock.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clarice-envio-lock-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("acquireEnvioLock / releaseEnvioLock", () => {
  it("adquire quando não há lock, e o arquivo carrega pid/host/startedAt/label", () => {
    const now = new Date("2026-08-11T22:00:00Z");
    const lockPath = acquireEnvioLock(root, "2607-08", "run-19h", now);
    assert.ok(existsSync(lockPath));
    const info = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(info.pid, process.pid);
    assert.equal(info.label, "run-19h");
    assert.equal(info.startedAt, now.toISOString());
  });

  it("2ª aquisição com lock FRESCO lança LockHeldError, sem tocar o lock existente", () => {
    const now = new Date("2026-08-11T22:00:00Z");
    acquireEnvioLock(root, "2607-08", "run-19h", now);
    assert.throws(
      () => acquireEnvioLock(root, "2607-08", "guard-05h", new Date(now.getTime() + 60_000)),
      LockHeldError,
    );
    // o lock original continua intacto (não foi sobrescrito pela 2ª tentativa)
    const info = JSON.parse(readFileSync(lockPathForCycle(root, "2607-08"), "utf8"));
    assert.equal(info.label, "run-19h");
  });

  it("lock STALE (mais velho que STALE_LOCK_MS) é removido e a nova aquisição funciona", () => {
    const started = new Date("2026-08-11T00:00:00Z");
    acquireEnvioLock(root, "2607-08", "run-abandonado", started);
    const later = new Date(started.getTime() + STALE_LOCK_MS + 1);
    const lockPath = acquireEnvioLock(root, "2607-08", "run-novo", later);
    const info = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(info.label, "run-novo", "o lock stale devia ter sido substituído");
  });

  it("release + reacquire no mesmo instante funciona (fluxo normal fim-de-rodada)", () => {
    const now = new Date("2026-08-11T22:00:00Z");
    const lockPath = acquireEnvioLock(root, "2607-08", "run-19h", now);
    releaseEnvioLock(lockPath);
    assert.ok(!existsSync(lockPath));
    const lockPath2 = acquireEnvioLock(root, "2607-08", "run-19h-retry", now);
    assert.ok(existsSync(lockPath2));
  });

  it("release em lock já ausente é fail-soft (nunca lança)", () => {
    const lockPath = lockPathForCycle(root, "2607-08");
    assert.doesNotThrow(() => releaseEnvioLock(lockPath));
  });

  it("locks são por CICLO — ciclos diferentes nunca colidem", () => {
    const now = new Date("2026-08-11T22:00:00Z");
    acquireEnvioLock(root, "2607-08", "run-ciclo-A", now);
    assert.doesNotThrow(() => acquireEnvioLock(root, "2608-09", "run-ciclo-B", now));
  });
});

describe("isLockStale", () => {
  it("lock inexistente é tratado como stale (abandonado)", () => {
    assert.equal(isLockStale(join(root, "nao-existe.lock"), new Date()), true);
  });

  it("lock corrompido (JSON inválido) é tratado como stale", () => {
    const p = join(root, "corrompido.lock");
    mkdirSync(root, { recursive: true });
    writeFileSync(p, "{ isto nao e json valido", "utf8");
    assert.equal(isLockStale(p, new Date()), true);
  });

  it("lock com startedAt inválido é tratado como stale", () => {
    const p = join(root, "data-invalida.lock");
    writeFileSync(p, JSON.stringify({ pid: 1, host: "x", startedAt: "não é data", label: "x" }), "utf8");
    assert.equal(isLockStale(p, new Date()), true);
  });

  it("lock recém-criado NÃO é stale", () => {
    const now = new Date("2026-08-11T22:00:00Z");
    const p = join(root, "fresco.lock");
    writeFileSync(p, JSON.stringify({ pid: 1, host: "x", startedAt: now.toISOString(), label: "x" }), "utf8");
    assert.equal(isLockStale(p, new Date(now.getTime() + 1000)), false);
  });

  it("boundary: exatamente STALE_LOCK_MS ainda não é stale; STALE_LOCK_MS+1 já é", () => {
    const started = new Date("2026-08-11T00:00:00Z");
    const p = join(root, "boundary.lock");
    writeFileSync(p, JSON.stringify({ pid: 1, host: "x", startedAt: started.toISOString(), label: "x" }), "utf8");
    assert.equal(isLockStale(p, new Date(started.getTime() + STALE_LOCK_MS)), false);
    assert.equal(isLockStale(p, new Date(started.getTime() + STALE_LOCK_MS + 1)), true);
  });
});

describe("isPidAlive", () => {
  it("o próprio processo de teste está vivo", () => {
    assert.equal(isPidAlive(process.pid), true);
  });

  it("um pid que não existe é reportado como morto", () => {
    // PID absurdamente alto — Linux/macOS/Windows não chegam nem perto disso
    // em condições normais; se falhar por coincidência, o teste é flaky por
    // natureza do mecanismo (mesmo risco de qualquer checagem de PID real).
    assert.equal(isPidAlive(2_147_483_000), false);
  });
});

describe("breakEnvioLock", () => {
  const now = new Date("2026-08-20T22:00:00Z");

  it("sem lock — nada a destravar, broken: false", () => {
    const result = breakEnvioLock(root, "2607-08", now);
    assert.equal(result.broken, false);
    assert.equal(result.lockInfo, null);
    assert.match(result.reason, /não existe/);
  });

  it("lock ilegível/corrompido — recusa (não assume morto sem dados do lock)", () => {
    const lockPath = lockPathForCycle(root, "2607-08");
    mkdirSync(join(root, "data", "clarice-subscribers", "2607-08"), { recursive: true });
    writeFileSync(lockPath, "{ isto nao e json", "utf8");
    const result = breakEnvioLock(root, "2607-08", now);
    assert.equal(result.broken, false);
    assert.ok(existsSync(lockPath), "arquivo ilegível não deve ser removido sem confirmação");
    assert.match(result.reason, /ilegível/);
  });

  it("processo VIVO no mesmo host — recusa, lock permanece", () => {
    acquireEnvioLock(root, "2607-08", "run-em-andamento", now);
    const result = breakEnvioLock(root, "2607-08", now, {
      checkPidAlive: () => true,
      currentHost: "helios",
    });
    assert.equal(result.broken, false);
    assert.match(result.reason, /ainda está rodando/);
    assert.ok(existsSync(lockPathForCycle(root, "2607-08")), "lock de rodada viva não pode ser removido");
  });

  it("processo MORTO no mesmo host — destrava e loga quem/quando", () => {
    acquireEnvioLock(root, "2607-08", "run-abandonado", now);
    const result = breakEnvioLock(root, "2607-08", now, {
      checkPidAlive: () => false,
      currentHost: "helios",
    });
    assert.equal(result.broken, true);
    assert.match(result.reason, /destravado em/);
    assert.match(result.reason, /run-abandonado/);
    assert.ok(!existsSync(lockPathForCycle(root, "2607-08")), "lock deve ter sido removido");
  });

  it("host DIFERENTE — nunca destrava, mesmo com checkPidAlive dizendo morto", () => {
    acquireEnvioLock(root, "2607-08", "run-noutra-maquina", now);
    const result = breakEnvioLock(root, "2607-08", now, {
      checkPidAlive: () => false, // mesmo "confirmando morto", host diferente vence — não confiável
      currentHost: "outro-host",
    });
    assert.equal(result.broken, false);
    assert.match(result.reason, /MESMO host/);
    assert.ok(existsSync(lockPathForCycle(root, "2607-08")), "lock de outro host nunca é removido sem confirmação local");
  });
});

describe("main (CLI --break)", () => {
  const now = new Date("2026-08-20T22:00:00Z");
  const origLog = console.log;
  const origErr = process.stderr.write;
  let stdout: string[];

  beforeEach(() => {
    stdout = [];
    console.log = (...args: unknown[]) => { stdout.push(args.join(" ")); };
    process.stderr.write = (() => true) as typeof process.stderr.write;
  });

  afterEach(() => {
    console.log = origLog;
    process.stderr.write = origErr;
  });

  it("sem --break: uso + exit 2", () => {
    assert.equal(main([]), 2);
  });

  it("--break sem --cycle: exit 2", () => {
    assert.equal(main(["--break"]), 2);
  });

  it("--break --cycle com ciclo inexistente (sem lock em disco): broken false, exit 1", () => {
    // `main()` roda contra o ROOT real do projeto (não é injetável) — por
    // isso este teste usa um slug de ciclo que nunca existiu, garantindo
    // que `breakEnvioLock` só faz um `existsSync` que dá `false` e não toca
    // `data/clarice-subscribers/` real em nenhum outro caminho (nunca cria
    // nem apaga arquivo). Cobertura do fluxo "processo morto → destrava" e
    // "host diferente → recusa" já está em `breakEnvioLock` acima, com
    // fixtures isoladas em `root` (tmpdir), nunca contra dado real.
    const result = main(["--break", "--cycle", "nao-existe-cycle-de-teste-5832"]);
    assert.equal(result, 1);
    assert.ok(stdout.some((l) => l.includes('"broken": false')));
  });
});
