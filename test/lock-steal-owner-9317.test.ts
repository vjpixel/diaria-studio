/**
 * test/lock-steal-owner-9317.test.ts (#9317)
 *
 * Regressão: o `.steal` (lock auxiliar que serializa removedores de `.lock`
 * órfão) era quebrado SÓ por idade (mtime > STEAL_STALE_MS). Um removedor A
 * que travasse >30s entre a releitura e o `unlink` perdia o `.steal` pra B,
 * que roubava o órfão e adquiria um lock novo; ao voltar, A apagava o lock
 * VIVO de B. Agora o `.steal` carrega `{pid, host, ts, token}` e só é quebrado
 * pela mesma regra do `.lock` (dono deste host com PID morto, ou conteúdo
 * legado/vazio / outro host após o prazo), e o `unlink` exige que o `.steal`
 * ainda seja do removedor. Cobre `scripts/lib/file-lock.ts` e o espelho
 * `.claude/hooks/lib/registry-lock.mjs`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  tryStealOrphan,
  isStealAbandoned,
  lockHostId,
  STEAL_STALE_MS,
} from "../scripts/lib/file-lock.ts";
import {
  breakStaleLock,
  isStealAbandoned as isStealAbandonedMjs,
  STEAL_STALE_MS as STEAL_STALE_MS_MJS,
} from "../.claude/hooks/lib/registry-lock.mjs";

function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "0"]);
  assert.ok(r.pid && r.pid > 0);
  return r.pid!;
}

function withTmp(fn: (lock: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "lock-steal-9317-"));
  try { fn(join(dir, "s.json.lock")); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function age(path: string, ms: number) {
  const t = (Date.now() - ms) / 1000;
  utimesSync(path, t, t);
}

const owner = (pid: number, host = lockHostId(), token = "t") => JSON.stringify({ pid, host, ts: 0, token });

/** Os dois quebradores sob teste: lado TS e espelho dos hooks. */
const BREAKERS: Array<[string, (lock: string) => boolean]> = [
  ["file-lock.ts tryStealOrphan", (lock) => tryStealOrphan(lock)],
  ["registry-lock.mjs breakStaleLock", (lock) => breakStaleLock(lock)],
];

describe("#9317 — .steal com dono vivo nunca é quebrado por idade", () => {
  for (const [name, breakLock] of BREAKERS) {
    it(`${name}: .steal de removedor VIVO e velho (>STEAL_STALE_MS) é respeitado — o órfão não é roubado`, () => {
      withTmp((lock) => {
        writeFileSync(lock, owner(deadPid(), lockHostId(), "orfao"));
        const stealPath = `${lock}.steal`;
        // Removedor A: este processo (vivo), travado há 2 min segurando o .steal.
        const aContent = owner(process.pid, lockHostId(), "removedor-A");
        writeFileSync(stealPath, aContent);
        age(stealPath, 2 * 60_000);
        // Antes do fix, a 1ª chamada apagava o .steal de A e a 2ª roubava o órfão.
        assert.equal(breakLock(lock), false);
        assert.equal(breakLock(lock), false);
        assert.ok(existsSync(stealPath), ".steal do removedor vivo foi apagado");
        assert.equal(readFileSync(stealPath, "utf8"), aContent);
        assert.ok(existsSync(lock), "órfão roubado enquanto outro removedor vivo segurava o .steal");
      });
    });

    it(`${name}: .steal de removedor MORTO é quebrado (sem esperar o prazo) e o órfão é removido na volta seguinte`, () => {
      withTmp((lock) => {
        writeFileSync(lock, owner(deadPid(), lockHostId(), "orfao"));
        const stealPath = `${lock}.steal`;
        writeFileSync(stealPath, owner(deadPid(), lockHostId(), "removedor-morto"));
        assert.equal(breakLock(lock), false, "1ª volta só descarta o .steal abandonado");
        assert.ok(!existsSync(stealPath));
        assert.equal(breakLock(lock), true);
        assert.ok(!existsSync(lock) && !existsSync(stealPath));
      });
    });

    it(`${name}: .steal legado/vazio só é quebrado após STEAL_STALE_MS`, () => {
      withTmp((lock) => {
        writeFileSync(lock, owner(deadPid(), lockHostId(), "orfao"));
        const stealPath = `${lock}.steal`;
        writeFileSync(stealPath, "");
        age(stealPath, 1_000);
        assert.equal(breakLock(lock), false);
        assert.ok(existsSync(stealPath), ".steal legado recente não pode ser quebrado");
        age(stealPath, STEAL_STALE_MS + 5_000);
        assert.equal(breakLock(lock), false, "1ª volta descarta o .steal legado vencido");
        assert.equal(breakLock(lock), true);
        assert.ok(!existsSync(lock) && !existsSync(stealPath));
      });
    });

    it(`${name}: remoção bem-sucedida não deixa .steal pra trás`, () => {
      withTmp((lock) => {
        writeFileSync(lock, owner(deadPid(), lockHostId(), "orfao"));
        assert.equal(breakLock(lock), true);
        assert.ok(!existsSync(lock) && !existsSync(`${lock}.steal`));
      });
    });
  }
});

describe("#9317 — paridade isStealAbandoned TS × mjs", () => {
  it("constante igual", () => {
    assert.equal(STEAL_STALE_MS_MJS, STEAL_STALE_MS);
  });

  it("mesma decisão numa matriz de casos", () => {
    const now = 10_000_000;
    const host = "h#ns";
    const cases: Array<[string, number]> = [
      [owner(123, host, "vivo"), now - 10 * 60_000],
      [owner(456, host, "morto"), now - 1_000],
      [owner(789, "outro", "x"), now - 1_000],
      [owner(789, "outro", "x"), now - 2 * STEAL_STALE_MS],
      ["", now - 1_000],
      ["", now - 2 * STEAL_STALE_MS],
      ["{lixo", now - 2 * STEAL_STALE_MS],
    ];
    const alive = (pid: number) => pid === 123;
    for (const [raw, mtime] of cases) {
      const ts = isStealAbandoned(raw, mtime, now, host, alive);
      assert.equal(isStealAbandonedMjs(raw, mtime, now, host, alive), ts, `raw=${raw} mtime=${mtime}`);
    }
    // Âncoras: vivo velho NUNCA; morto recente SIM.
    assert.equal(isStealAbandoned(cases[0]![0], cases[0]![1], now, host, alive), false);
    assert.equal(isStealAbandoned(cases[1]![0], cases[1]![1], now, host, alive), true);
  });
});
