/**
 * atomic-write.test.ts (#1132 P2.3)
 *
 * Tests do helper `writeFileAtomic`. Cobre: write básico, encoding,
 * Buffer, cleanup em falha, idempotência (re-write substitui).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFileAtomic, writeFileAtomicAsync, renameWithRetry } from "../scripts/lib/atomic-write.ts";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "diaria-atomic-test-"));
}

describe("writeFileAtomic (#1132 P2.3)", () => {
  it("escreve string corretamente", () => {
    const dir = makeDir();
    try {
      const target = join(dir, "out.txt");
      writeFileAtomic(target, "hello world");
      assert.equal(readFileSync(target, "utf8"), "hello world");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escreve Buffer corretamente", () => {
    const dir = makeDir();
    try {
      const target = join(dir, "out.bin");
      writeFileAtomic(target, Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]));
      const got = readFileSync(target);
      assert.deepEqual([...got], [0xDE, 0xAD, 0xBE, 0xEF]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("substitui arquivo existente atomicamente", () => {
    const dir = makeDir();
    try {
      const target = join(dir, "out.txt");
      writeFileSync(target, "original");
      writeFileAtomic(target, "replaced");
      assert.equal(readFileSync(target, "utf8"), "replaced");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("encoding override funciona", () => {
    const dir = makeDir();
    try {
      const target = join(dir, "out.txt");
      writeFileAtomic(target, "café\n", { encoding: "utf8" });
      const got = readFileSync(target, "utf8");
      assert.equal(got, "café\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("não deixa tmp file órfão após sucesso", () => {
    const dir = makeDir();
    try {
      writeFileAtomic(join(dir, "out.txt"), "content");
      const entries = readdirSync(dir);
      assert.deepEqual(entries, ["out.txt"], "apenas o target, sem tmp files");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propaga erro quando target dir não existe", () => {
    const dir = makeDir();
    try {
      const target = join(dir, "nonexistent-dir", "out.txt");
      assert.throws(() => writeFileAtomic(target, "fail"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("limpa tmp file quando rename falha (target dir removido entre write e rename)", () => {
    const dir = makeDir();
    try {
      const subdir = join(dir, "sub");
      mkdirSync(subdir);
      const target = join(subdir, "out.txt");
      // Pré-escreve pra criar contexto
      writeFileAtomic(target, "initial");

      // Remove subdir antes de chamar atomic write — força falha no rename
      rmSync(subdir, { recursive: true });

      assert.throws(() => writeFileAtomic(target, "should-fail"));

      // Verifica que NÃO ficou tmp file órfão no dir pai (cleanup OK)
      const entriesParent = readdirSync(dir);
      assert.equal(entriesParent.length, 0, "sem tmp files órfãos");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fsync=false ainda escreve corretamente (skip durability check)", () => {
    const dir = makeDir();
    try {
      const target = join(dir, "out.txt");
      writeFileAtomic(target, "no-fsync", { fsync: false });
      assert.equal(readFileSync(target, "utf8"), "no-fsync");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserva tamanho exato (sem trailing chars)", () => {
    const dir = makeDir();
    try {
      const target = join(dir, "out.txt");
      const content = "exact-content-no-trailing";
      writeFileAtomic(target, content);
      assert.equal(statSync(target).size, content.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeFileAtomicAsync (#1132 P2.3)", () => {
  it("retorna promise que resolve em sucesso", async () => {
    const dir = makeDir();
    try {
      const target = join(dir, "out.txt");
      await writeFileAtomicAsync(target, "async-content");
      assert.equal(readFileSync(target, "utf8"), "async-content");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejeita promise quando target dir não existe", async () => {
    const dir = makeDir();
    try {
      const target = join(dir, "missing", "out.txt");
      await assert.rejects(() => writeFileAtomicAsync(target, "fail"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// #1269: retry em EPERM/EBUSY/EACCES (Windows + OneDrive race)
import { renameSync as realRenameSync } from "node:fs";

describe("renameWithRetry (#1269)", () => {
  it("retry quando primeira tentativa falha EPERM e segunda passa", () => {
    const dir = makeDir();
    try {
      const src = join(dir, "src.txt");
      const dst = join(dir, "dst.txt");
      writeFileSync(src, "test", "utf8");

      let calls = 0;
      const fakeRename = (s: string, d: string) => {
        calls++;
        if (calls === 1) {
          const e = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
          e.code = "EPERM";
          throw e;
        }
        realRenameSync(s, d);
      };

      renameWithRetry(src, dst, [0, 10], fakeRename);

      assert.equal(calls, 2, "deveria ter tentado 2x");
      assert.equal(readFileSync(dst, "utf8"), "test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propaga imediato erros não-transientes (ENOENT)", () => {
    const fakeRename = () => {
      const e = new Error("ENOENT") as NodeJS.ErrnoException;
      e.code = "ENOENT";
      throw e;
    };
    assert.throws(
      () => renameWithRetry("x", "y", [0, 10], fakeRename),
      (err: NodeJS.ErrnoException) => err.code === "ENOENT",
    );
  });

  it("propaga última falha após esgotar tentativas", () => {
    let calls = 0;
    const fakeRename = () => {
      calls++;
      const e = new Error("EPERM persistent") as NodeJS.ErrnoException;
      e.code = "EPERM";
      throw e;
    };
    assert.throws(
      () => renameWithRetry("x", "y", [0, 5, 10], fakeRename),
      /EPERM/,
    );
    assert.equal(calls, 3, "deveria ter tentado todas as N=3 attempts");
  });

  it("aceita EBUSY como retryable também", () => {
    let calls = 0;
    const fakeRename = () => {
      calls++;
      if (calls === 1) {
        const e = new Error("EBUSY") as NodeJS.ErrnoException;
        e.code = "EBUSY";
        throw e;
      }
      // 2ª passa
    };
    renameWithRetry("x", "y", [0, 5], fakeRename);
    assert.equal(calls, 2);
  });
});
