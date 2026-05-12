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

import { writeFileAtomic, writeFileAtomicAsync } from "../scripts/lib/atomic-write.ts";

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
