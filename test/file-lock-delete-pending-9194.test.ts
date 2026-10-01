/**
 * test/file-lock-delete-pending-9194.test.ts (#9194)
 *
 * Regressão: no Windows, o `unlinkSync` do dono enquanto um waiter está com o
 * `.lock` aberto pra leitura (checagem de órfão do #9185) deixa o nome em
 * delete-pending, e o `open(wx)` seguinte falha com EPERM/EACCES em vez de
 * EEXIST. O ramo do #6952 propagava isso como falha dura. Reproduzido no neo:
 * 211 EPERM em 87.488 aquisições (8 processos) e 490 em 3.406 (16 processos).
 *
 * Determinístico: injeta o erro no `open(wx)` via `acquireLockWithDeps` —
 * não depende de corrida nem de rodar no Windows.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, openSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLockWithDeps,
  releaseLock,
  isDeletePendingWxError,
  DELETE_PENDING_MAX_STREAK,
} from "../scripts/lib/file-lock.ts";

const dir = mkdtempSync(join(tmpdir(), "file-lock-9194-"));
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

describe("file-lock — delete-pending no Windows (#9194)", () => {
  it("win32: EPERM transitório no wx é contenção — adquire depois", () => {
    const lock = join(dir, "a.lock");
    const fake = failingThenReal(["EPERM", "EPERM", "EACCES"]);
    acquireLockWithDeps(lock, 5_000, { platform: "win32", openWx: fake.openWx });
    assert.equal(fake.calls, 4);
    assert.ok(existsSync(lock));
    releaseLock(lock);
  });

  it("win32: EPERM persistente propaga rápido (não gira até o timeout, #6952)", () => {
    const lock = join(dir, "b.lock");
    const fake = failingThenReal(Array(1000).fill("EPERM"));
    const t0 = Date.now();
    assert.throws(
      () => acquireLockWithDeps(lock, 60_000, { platform: "win32", openWx: fake.openWx }),
      (e: NodeJS.ErrnoException) =>
        e.code === "EPERM" &&
        /EPERM persistiu por \d+ tentativas seguidas em .*b\.lock — não é delete-pending \(#9194\)/.test(e.message) &&
        (e.cause as NodeJS.ErrnoException)?.code === "EPERM",
    );
    assert.equal(fake.calls, DELETE_PENDING_MAX_STREAK + 1);
    assert.ok(Date.now() - t0 < 3_000, "não pode esperar o timeout de 60s");
  });

  it("win32: exatamente DELETE_PENDING_MAX_STREAK EPERMs seguidos ainda adquire (limite inclusivo)", () => {
    const lock = join(dir, "e.lock");
    const fake = failingThenReal(Array(DELETE_PENDING_MAX_STREAK).fill("EPERM"));
    acquireLockWithDeps(lock, 5_000, { platform: "win32", openWx: fake.openWx });
    assert.equal(fake.calls, DELETE_PENDING_MAX_STREAK + 1);
    releaseLock(lock);
  });

  it("win32: EEXIST zera a sequência — só EPERMs CONSECUTIVOS contam", () => {
    const lock = join(dir, "f.lock");
    const n = DELETE_PENDING_MAX_STREAK;
    const fake = failingThenReal([...Array(n).fill("EPERM"), "EEXIST", ...Array(n).fill("EPERM")]);
    acquireLockWithDeps(lock, 5_000, { platform: "win32", openWx: fake.openWx });
    assert.equal(fake.calls, 2 * n + 2);
    releaseLock(lock);
  });

  it("win32: deadline vencido não retenta o EPERM", () => {
    const fake = failingThenReal(["EPERM"]);
    assert.throws(
      () => acquireLockWithDeps(join(dir, "g.lock"), -1, { platform: "win32", openWx: fake.openWx }),
      (e: NodeJS.ErrnoException) => e.code === "EPERM",
    );
    assert.equal(fake.calls, 1);
  });

  it("não-win32: EPERM/EACCES seguem falha dura imediata (#6952 intacto)", () => {
    for (const code of ["EPERM", "EACCES"]) {
      const fake = failingThenReal([code]);
      assert.throws(
        () => acquireLockWithDeps(join(dir, "c.lock"), 5_000, { platform: "linux", openWx: fake.openWx }),
        (e: NodeJS.ErrnoException) => e.code === code,
      );
      assert.equal(fake.calls, 1);
    }
  });

  it("win32: outros erros (ENOENT, ENOSPC) continuam falha dura imediata", () => {
    for (const code of ["ENOENT", "ENOSPC"]) {
      const fake = failingThenReal([code]);
      assert.throws(
        () => acquireLockWithDeps(join(dir, "d.lock"), 5_000, { platform: "win32", openWx: fake.openWx }),
        (e: NodeJS.ErrnoException) => e.code === code,
      );
      assert.equal(fake.calls, 1);
    }
  });

  it("isDeletePendingWxError — matriz", () => {
    assert.equal(isDeletePendingWxError("EPERM", "win32"), true);
    assert.equal(isDeletePendingWxError("EACCES", "win32"), true);
    assert.equal(isDeletePendingWxError("EEXIST", "win32"), false);
    assert.equal(isDeletePendingWxError("ENOENT", "win32"), false);
    assert.equal(isDeletePendingWxError(undefined, "win32"), false);
    assert.equal(isDeletePendingWxError("EPERM", "linux"), false);
    assert.equal(isDeletePendingWxError("EACCES", "darwin"), false);
  });
});
