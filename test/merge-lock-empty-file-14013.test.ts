/**
 * test/merge-lock-empty-file-14013.test.ts
 *
 * #14013: a criação do merge lock com `writeFileSync(path, data, { flag: "wx" })`
 * expunha o arquivo com 0 bytes entre o `open` (O_CREAT|O_EXCL) e o `write`. Uma
 * 2ª sessão que chegava nesse intervalo recebia EEXIST, lia `null` e contestava o
 * hold como corrompido: as duas devolviam `true` e dois merges corriam juntos.
 *
 * Correção em duas partes, as duas cobertas aqui:
 *   1. leitor: arquivo ilegível (vazio ou JSON parcial) e recente é hold em
 *      criação e a aquisição é recusada (vale também contra writer antigo);
 *   2. criador: `createLockFileExclusive` grava num temporário e cria o lock por
 *      `link`, então o arquivo nunca aparece vazio.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireMergeLock,
  acquireMergeLockShared,
  createLockFileExclusive,
  MERGE_LOCK_CREATE_GRACE_MS,
  MERGE_LOCK_TTL_MS,
  mergeLockPath,
  sessionsDir,
  type MergeLockIo,
} from "../scripts/lib/session-registry.ts";
import { d1ReadLock, mergeLockD1Name } from "../scripts/lib/d1-locks.ts";
import { createFakeD1 } from "./_helpers/fake-d1.ts";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "merge-lock-14013-"));
  roots.push(root);
  mkdirSync(sessionsDir(root), { recursive: true });
  return root;
}

const REPO = "vjpixel/diaria-studio";

describe("#14013 merge lock: arquivo vazio/parcial recente é hold em criação", () => {
  it("io fake: EEXIST + readCurrent null + mtime recente → recusa, sem sobrescrever", () => {
    const root = freshRoot();
    let overwrites = 0;
    const io: MergeLockIo = {
      tryCreateExclusive: () => false,
      readCurrent: () => null,
      overwrite: () => {
        overwrites++;
      },
      isRecentlyModified: () => true,
    };
    assert.equal(acquireMergeLock(root, "sess-b", Date.now(), MERGE_LOCK_TTL_MS, io), false);
    assert.equal(overwrites, 0, "hold em criação nunca é contestado");
  });

  it("io fake: arquivo ilegível ANTIGO segue contestado como corrompido (comportamento anterior)", () => {
    const root = freshRoot();
    const disk = new Map<string, string>();
    const io: MergeLockIo = {
      tryCreateExclusive: () => false,
      readCurrent: (p) => {
        try {
          return disk.has(p) ? JSON.parse(disk.get(p)!) : null;
        } catch {
          return null;
        }
      },
      overwrite: (p, data) => disk.set(p, data),
      isRecentlyModified: () => false,
    };
    disk.set(mergeLockPath(root), "{\"heldBy\":");
    assert.equal(acquireMergeLock(root, "sess-b", Date.now(), MERGE_LOCK_TTL_MS, io), true);
  });

  it("disco real: lock vazio recém-criado (fd aberto, sem write) → a 2ª sessão é recusada e o arquivo fica intacto", () => {
    const root = freshRoot();
    const path = mergeLockPath(root);
    writeFileSync(path, "", { flag: "wx" });
    assert.equal(acquireMergeLock(root, "sess-b"), false);
    assert.equal(readFileSync(path, "utf8"), "", "a 2ª sessão não sobrescreveu o hold em criação");
  });

  it("disco real: JSON parcial recente também conta como em criação", () => {
    const root = freshRoot();
    const path = mergeLockPath(root);
    writeFileSync(path, "{\"heldBy\":\"sess-a\",\"acq", "utf8");
    assert.equal(acquireMergeLock(root, "sess-b"), false);
  });

  it("disco real: arquivo ilegível com mtime além da janela é contestado e adquirido", () => {
    const root = freshRoot();
    const path = mergeLockPath(root);
    writeFileSync(path, "", "utf8");
    const old = (Date.now() - MERGE_LOCK_CREATE_GRACE_MS - 60_000) / 1000;
    utimesSync(path, old, old);
    assert.equal(acquireMergeLock(root, "sess-b"), true);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).heldBy, "sess-b");
  });

  it("corrida reproduzida: processo filho abre com wx e grava 300ms depois; a sessão principal no intervalo é recusada", async () => {
    const root = freshRoot();
    const path = mergeLockPath(root);
    const dataA = JSON.stringify({ heldBy: "sess-a", acquiredAt: new Date().toISOString() });
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const fs=require('fs');const [p,d]=process.argv.slice(1);const fd=fs.openSync(p,'wx');" +
          "process.stdout.write('open\\n');setTimeout(()=>{fs.writeSync(fd,d);fs.closeSync(fd);},300);",
        path,
        dataA,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (b: Buffer) => {
        if (b.toString().includes("open")) resolve();
      });
      child.on("error", reject);
      child.on("exit", (code) => reject(new Error(`filho saiu antes de abrir o lock (code ${code})`)));
    });
    const resultB = acquireMergeLock(root, "sess-b");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    assert.equal(resultB, false, "B leu o arquivo vazio e não pode virar 2º detentor");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).heldBy, "sess-a", "o hold de A sobrevive inteiro");
  });

  it("acquireMergeLockShared: D1 concede mas o arquivo é hold em criação → recusa e devolve o D1", async () => {
    const d1 = createFakeD1();
    const root = freshRoot();
    writeFileSync(join(sessionsDir(root), "overnight-261126-coord-1.json"), "{}");
    writeFileSync(mergeLockPath(root), "", { flag: "wx" });
    const now = Date.now();
    const warnings: string[] = [];
    const r = await acquireMergeLockShared(root, "coord-1", REPO, { d1, now, d1Now: now, warn: (m) => warnings.push(m) });
    assert.equal(r.ok, false, "o D1 não autoriza sobrescrever um hold em criação de quem só usa o arquivo");
    assert.equal(readFileSync(mergeLockPath(root), "utf8"), "", "o arquivo não foi regravado");
    const row = await d1ReadLock(d1, mergeLockD1Name(REPO), { now: now + 1 });
    assert.ok(row.ok);
    assert.equal(row.value, null, "o lock tomado no D1 foi devolvido");
  });
});

describe("#14013 createLockFileExclusive: o lock nasce com o conteúdo completo", () => {
  it("cria com o JSON inteiro, recusa a 2ª criação e não deixa temporário para trás", () => {
    const root = freshRoot();
    const path = mergeLockPath(root);
    const a = JSON.stringify({ heldBy: "sess-a", acquiredAt: new Date().toISOString() });
    const b = JSON.stringify({ heldBy: "sess-b", acquiredAt: new Date().toISOString() });
    assert.equal(createLockFileExclusive(path, a), true);
    assert.equal(readFileSync(path, "utf8"), a);
    assert.equal(createLockFileExclusive(path, b), false, "EEXIST como o O_EXCL");
    assert.equal(readFileSync(path, "utf8"), a, "a 2ª criação não tocou o lock");
    const leftovers = readdirSync(sessionsDir(root)).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "temporários removidos nos dois caminhos");
  });

  it("acquireMergeLock pelo disco real: 1ª sessão adquire, 2ª é recusada pelo TTL", () => {
    const root = freshRoot();
    assert.equal(acquireMergeLock(root, "sess-a"), true);
    assert.equal(acquireMergeLock(root, "sess-b"), false);
    assert.equal(JSON.parse(readFileSync(mergeLockPath(root), "utf8")).heldBy, "sess-a");
  });
});
