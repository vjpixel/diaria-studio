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
import { join } from "node:path";
import { acquireLock, releaseLock, withFileLock, isLockOrphan, LEGACY_STALE_MS } from "../scripts/lib/file-lock.ts";

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
      writeFileSync(lock, JSON.stringify({ pid: deadPid(), host: hostname(), ts: Date.now(), token: "morto" }));
      const t0 = Date.now();
      const out = withFileLock(lock, () => {
        const owner = JSON.parse(readFileSync(lock, "utf8"));
        assert.equal(owner.pid, process.pid);
        assert.equal(owner.host, hostname());
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
      writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), ts: 0, token: "vivo" }));
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
});
