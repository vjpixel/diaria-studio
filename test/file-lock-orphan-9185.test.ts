/**
 * test/file-lock-orphan-9185.test.ts (#9185)
 *
 * Regressão: um processo que morria segurando o lock deixava o `.lock` no
 * disco pra sempre, e toda chamada seguinte a `acquireLock`/`withFileLock`
 * girava até o timeout (no onboarding, travava as escadas Brevo e Kit até
 * remoção manual). Agora o lock carrega `{pid, host, ts, token}` e é tratado
 * como órfão quando o dono é desta máquina e o PID não existe mais — ou,
 * pra lock legado sem conteúdo, quando o mtime passou de LEGACY_STALE_MS.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, utimesSync, existsSync, readdirSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { acquireLock, releaseLock, withFileLock, isLockOrphan, lockHostId, LEGACY_STALE_MS } from "../scripts/lib/file-lock.ts";

const execFileAsync = promisify(execFile);
const FILE_LOCK_URL = pathToFileURL(join(import.meta.dirname, "..", "scripts", "lib", "file-lock.ts")).href;

/** PID de um processo que já terminou (spawnSync só retorna após o exit). */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "0"]);
  assert.ok(r.pid && r.pid > 0);
  return r.pid!;
}

function tmp(): { dir: string; lock: string } {
  const dir = mkdtempSync(join(tmpdir(), "file-lock-9185-"));
  return { dir, lock: join(dir, "store.json.lock") };
}

describe("file-lock — lock órfão (#9185)", () => {
  it("lock de PID morto nesta máquina é removido e o lock é adquirido sem esperar o timeout", () => {
    const { dir, lock } = tmp();
    try {
      writeFileSync(lock, JSON.stringify({ pid: deadPid(), host: lockHostId(), ts: Date.now(), token: "morto" }));
      const t0 = Date.now();
      const out = withFileLock(lock, () => {
        const owner = JSON.parse(readFileSync(lock, "utf8"));
        assert.equal(owner.pid, process.pid);
        assert.equal(owner.host, lockHostId());
        assert.notEqual(owner.token, "morto");
        return "ok";
      }, 2_000);
      assert.equal(out, "ok");
      assert.ok(Date.now() - t0 < 1_500, "não deveria girar até o timeout");
      assert.equal(existsSync(lock), false);
      assert.deepEqual(readdirSync(dir), [], "não deixa arquivo .orphan-* pra trás");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lock de PID VIVO nesta máquina continua bloqueando (timeout)", () => {
    const { dir, lock } = tmp();
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, host: lockHostId(), ts: 0, token: "vivo" }));
      assert.throws(() => acquireLock(lock, 200), /lock timeout/);
      assert.match(readFileSync(lock, "utf8"), /"vivo"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lock de OUTRA máquina nunca é roubado por PID, mesmo antigo", () => {
    const { dir, lock } = tmp();
    try {
      writeFileSync(lock, JSON.stringify({ pid: deadPid(), host: `${hostname()}-outra`, ts: 0, token: "remoto" }));
      const old = (Date.now() - 2 * LEGACY_STALE_MS) / 1000;
      utimesSync(lock, old, old);
      assert.throws(() => acquireLock(lock, 200), /lock timeout/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lock legado vazio: recente bloqueia, antigo (> LEGACY_STALE_MS) é removido", () => {
    const { dir, lock } = tmp();
    try {
      writeFileSync(lock, "");
      assert.throws(() => acquireLock(lock, 200), /lock timeout/);
      const old = (Date.now() - LEGACY_STALE_MS - 60_000) / 1000;
      utimesSync(lock, old, old);
      acquireLock(lock, 2_000);
      assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, process.pid);
      releaseLock(lock);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isLockOrphan — matriz de decisão", () => {
    const now = 1_000_000_000;
    const own = (pid: number, host = "h") => JSON.stringify({ pid, host, ts: 0, token: "t" });
    const alive = (pid: number) => pid === 1;
    assert.equal(isLockOrphan(own(2), now, now, "h", alive), true);
    assert.equal(isLockOrphan(own(1), 0, now, "h", alive), false, "vivo nunca expira por idade");
    assert.equal(isLockOrphan(own(2, "x"), 0, now, "h", alive), false, "outra máquina");
    assert.equal(isLockOrphan("", now - LEGACY_STALE_MS - 1, now, "h", alive), true);
    assert.equal(isLockOrphan("", now - 1_000, now, "h", alive), false);
    assert.equal(isLockOrphan("{lixo", now - LEGACY_STALE_MS - 1, now, "h", alive), true);
  });

  it("mesmo hostname mas outro namespace de PID não é roubado (sandbox/container)", () => {
    const { dir, lock } = tmp();
    try {
      writeFileSync(lock, JSON.stringify({ pid: deadPid(), host: `${hostname()}#pid:[1]`, ts: 0, token: "ns" }));
      if (lockHostId() === `${hostname()}#pid:[1]`) return; // improvável; nada a provar
      assert.throws(() => acquireLock(lock, 200), /lock timeout/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PID de outro usuário (EPERM, ex.: pid 1 sem root) conta como vivo", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const raw = JSON.stringify({ pid: 1, host: lockHostId(), ts: 0, token: "t" });
    assert.equal(isLockOrphan(raw, 0), false);
  });

  it("PID inválido (0, negativo, fracionário) cai na regra de lock legado, não é roubado na hora", () => {
    const now = 1_000_000_000;
    for (const pid of [0, -1, 1.5]) {
      const raw = JSON.stringify({ pid, host: "h", ts: 0, token: "t" });
      assert.equal(isLockOrphan(raw, now - 1_000, now, "h", () => false), false, `pid=${pid}`);
    }
  });

  it(".steal abandonado (removedor morto) é descartado após o prazo e o órfão é removido", () => {
    const { dir, lock } = tmp();
    try {
      writeFileSync(lock, JSON.stringify({ pid: deadPid(), host: lockHostId(), ts: 0, token: "morto" }));
      writeFileSync(`${lock}.steal`, "");
      const old = (Date.now() - 60_000) / 1000;
      utimesSync(`${lock}.steal`, old, old);
      withFileLock(lock, () => undefined, 2_000);
      assert.deepEqual(readdirSync(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("N processos concorrentes disputando o MESMO órfão: exclusão mútua preservada (nenhum update perdido)", async () => {
    const { dir, lock } = tmp();
    try {
      const counter = join(dir, "counter.txt");
      const inside = join(dir, "inside.txt");
      writeFileSync(counter, "0");
      writeFileSync(lock, JSON.stringify({ pid: deadPid(), host: lockHostId(), ts: 0, token: "morto" }));
      const child = join(dir, "child.mjs");
      writeFileSync(child, `
import { withFileLock } from ${JSON.stringify(FILE_LOCK_URL)};
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
const [lock, counter, inside] = process.argv.slice(2);
withFileLock(lock, () => {
  if (existsSync(inside)) { console.error("OVERLAP"); process.exit(3); }
  writeFileSync(inside, String(process.pid));
  const n = Number(readFileSync(counter, "utf8"));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
  writeFileSync(counter, String(n + 1));
  unlinkSync(inside);
}, 20_000);
`);
      const N = 6;
      await Promise.all(
        Array.from({ length: N }, () =>
          execFileAsync(process.execPath, ["--import", "tsx", child, lock, counter, inside], { timeout: 60_000 }),
        ),
      );
      assert.equal(readFileSync(counter, "utf8"), String(N));
      assert.equal(existsSync(lock), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
