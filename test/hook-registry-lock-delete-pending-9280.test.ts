/**
 * test/hook-registry-lock-delete-pending-9280.test.ts (#9280)
 *
 * Regressão: `tryAcquireOwnedLock` (`.claude/hooks/lib/registry-lock.mjs`)
 * disputa o MESMO `.lock` que `scripts/lib/file-lock.ts`, mas só tratava
 * EEXIST como contenção. No Windows, o unlink do dono com outro processo
 * segurando o arquivo aberto deixa o nome em delete-pending e o `open(wx)`
 * lança EPERM/EACCES — o hook tratava como falha dura. O lado TS foi corrigido
 * no #9194; este teste trava a mesma política no hook e a paridade das
 * constantes/predicado com a fonte canônica.
 *
 * Determinístico: injeta plataforma e `open(wx)` — não depende de corrida.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  tryAcquireOwnedLock,
  isDeletePendingWxError as isDeletePendingMjs,
  DELETE_PENDING_MAX_STREAK as STREAK_MJS,
} from "../.claude/hooks/lib/registry-lock.mjs";
import { isDeletePendingWxError, DELETE_PENDING_MAX_STREAK } from "../scripts/lib/file-lock.ts";

const dir = mkdtempSync(join(tmpdir(), "reglock-9280-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated, open`), { code });
}

/** `open(wx)` que falha com `codes` em sequência e depois abre de verdade. */
function failingThenReal(codes: string[]) {
  let calls = 0;
  return {
    get calls() { return calls; },
    openWx: (p: string) => {
      const c = codes[calls++];
      if (c) throw errno(c);
      return openSync(p, "wx");
    },
  };
}

describe("registry-lock.mjs — delete-pending no Windows (#9280)", () => {
  it("paridade com file-lock.ts: mesmo teto de sequência e mesmo predicado", () => {
    assert.equal(STREAK_MJS, DELETE_PENDING_MAX_STREAK);
    for (const platform of ["win32", "linux", "darwin"] as NodeJS.Platform[]) {
      for (const code of ["EPERM", "EACCES", "EEXIST", "ENOENT", "ENOSPC", undefined]) {
        assert.equal(isDeletePendingMjs(code, platform), isDeletePendingWxError(code, platform), `${platform}/${code}`);
      }
    }
  });

  it("win32: EPERM/EACCES transitório é contenção — adquire e grava o dono", () => {
    const lock = join(dir, "a.lock");
    const fake = failingThenReal(["EPERM", "EACCES", "EPERM"]);
    assert.equal(tryAcquireOwnedLock(lock, { platform: "win32", openWx: fake.openWx }), true);
    assert.equal(fake.calls, 4);
    const owner = JSON.parse(readFileSync(lock, "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.equal(typeof owner.token, "string");
    unlinkSync(lock);
  });

  it("win32: exatamente DELETE_PENDING_MAX_STREAK EPERMs seguidos ainda adquire (limite inclusivo)", () => {
    const lock = join(dir, "b.lock");
    const fake = failingThenReal(Array(DELETE_PENDING_MAX_STREAK).fill("EPERM"));
    assert.equal(tryAcquireOwnedLock(lock, { platform: "win32", openWx: fake.openWx }), true);
    assert.equal(fake.calls, DELETE_PENDING_MAX_STREAK + 1);
    unlinkSync(lock);
  });

  it("win32: EPERM persistente propaga rápido com code e cause", () => {
    const lock = join(dir, "c.lock");
    const fake = failingThenReal(Array(1000).fill("EPERM"));
    const t0 = Date.now();
    assert.throws(
      () => tryAcquireOwnedLock(lock, { platform: "win32", openWx: fake.openWx }),
      (e: NodeJS.ErrnoException) =>
        e.code === "EPERM" &&
        /EPERM persistiu por \d+ tentativas seguidas em .*c\.lock — não é delete-pending \(#9194\)/.test(e.message) &&
        (e.cause as NodeJS.ErrnoException)?.code === "EPERM",
    );
    assert.equal(fake.calls, DELETE_PENDING_MAX_STREAK + 1);
    assert.ok(Date.now() - t0 < 3_000);
    assert.ok(!existsSync(lock));
  });

  it("win32: EEXIST no meio da sequência devolve false (contenção normal)", () => {
    const lock = join(dir, "d.lock");
    const fake = failingThenReal(["EPERM", "EPERM", "EEXIST"]);
    assert.equal(tryAcquireOwnedLock(lock, { platform: "win32", openWx: fake.openWx }), false);
    assert.equal(fake.calls, 3);
    assert.ok(!existsSync(lock));
  });

  it("fora do win32: EPERM/EACCES propaga na hora (#6952 inalterado)", () => {
    for (const code of ["EPERM", "EACCES"]) {
      const fake = failingThenReal([code]);
      assert.throws(
        () => tryAcquireOwnedLock(join(dir, "e.lock"), { platform: "linux", openWx: fake.openWx }),
        (e: NodeJS.ErrnoException) => e.code === code && !/persistiu/.test(e.message),
      );
      assert.equal(fake.calls, 1);
    }
  });

  it("win32: erro que não é delete-pending (ENOENT) propaga na hora", () => {
    const fake = failingThenReal(["ENOENT"]);
    assert.throws(
      () => tryAcquireOwnedLock(join(dir, "f.lock"), { platform: "win32", openWx: fake.openWx }),
      (e: NodeJS.ErrnoException) => e.code === "ENOENT",
    );
    assert.equal(fake.calls, 1);
  });

  it("sem deps (produção): EEXIST real devolve false", () => {
    const lock = join(dir, "g.lock");
    assert.equal(tryAcquireOwnedLock(lock), true);
    assert.equal(tryAcquireOwnedLock(lock), false);
    unlinkSync(lock);
  });
});
