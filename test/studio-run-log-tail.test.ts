/**
 * test/studio-run-log-tail.test.ts (#3555) — cobertura de
 * scripts/studio-ui/run-log-tail.ts (tail inicial + watch incremental do SSE).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  tailJsonl,
  readNewRunLogEvents,
  watchRunLogAppends,
} from "../scripts/studio-ui/run-log-tail.ts";

function setupRoot(): { dir: string; logPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "studio-run-log-tail-"));
  const logPath = join(dir, "run-log.jsonl");
  return { dir, logPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function line(msg: string): string {
  return JSON.stringify({ timestamp: "2026-07-16T00:00:00.000Z", level: "info", message: msg }) + "\n";
}

describe("tailJsonl (#3555)", () => {
  it("arquivo inexistente: []", () => {
    const { dir, cleanup } = setupRoot();
    try {
      assert.deepEqual(tailJsonl(join(dir, "nope.jsonl"), 10), []);
    } finally {
      cleanup();
    }
  });

  it("retorna as últimas N linhas válidas, ignorando malformadas", () => {
    const { logPath, cleanup } = setupRoot();
    try {
      writeFileSync(logPath, line("a") + "not json\n" + line("b") + line("c"));
      const tail = tailJsonl(logPath, 2) as Array<{ message: string }>;
      assert.deepEqual(
        tail.map((e) => e.message),
        ["b", "c"],
      );
    } finally {
      cleanup();
    }
  });
});

describe("readNewRunLogEvents (#3555)", () => {
  it("sem crescimento: events=[], newSize inalterado", () => {
    const { logPath, cleanup } = setupRoot();
    try {
      writeFileSync(logPath, line("a"));
      const size1 = readNewRunLogEvents(logPath, 0).newSize;
      const { events, newSize } = readNewRunLogEvents(logPath, size1);
      assert.deepEqual(events, []);
      assert.equal(newSize, size1);
    } finally {
      cleanup();
    }
  });

  it("lê só o que foi appendado desde lastSize", () => {
    const { logPath, cleanup } = setupRoot();
    try {
      writeFileSync(logPath, line("a"));
      const { newSize: size1 } = readNewRunLogEvents(logPath, 0);
      appendFileSync(logPath, line("b"));
      const { events, newSize: size2 } = readNewRunLogEvents(logPath, size1);
      assert.equal((events[0] as { message: string }).message, "b");
      assert.ok(size2 > size1);
    } finally {
      cleanup();
    }
  });

  it("arquivo encolheu (rotação/truncamento): relê do zero em vez de lançar", () => {
    const { logPath, cleanup } = setupRoot();
    try {
      writeFileSync(logPath, line("a") + line("b") + line("c"));
      const bigSize = readNewRunLogEvents(logPath, 0).newSize;
      writeFileSync(logPath, line("novo")); // truncado + reescrito, menor
      const { events } = readNewRunLogEvents(logPath, bigSize);
      assert.equal((events[0] as { message: string }).message, "novo");
    } finally {
      cleanup();
    }
  });

  it("arquivo inexistente: newSize=0, sem lançar", () => {
    const { dir, cleanup } = setupRoot();
    try {
      const { events, newSize } = readNewRunLogEvents(join(dir, "nope.jsonl"), 100);
      assert.deepEqual(events, []);
      assert.equal(newSize, 0);
    } finally {
      cleanup();
    }
  });
});

describe("watchRunLogAppends (#3555)", () => {
  it("emite eventos novos após append, via polling curto", async () => {
    const { dir, logPath, cleanup } = setupRoot();
    mkdirSync(dir, { recursive: true });
    writeFileSync(logPath, line("inicial"));

    const received: unknown[] = [];
    const handle = watchRunLogAppends(logPath, (events) => received.push(...events), {
      pollIntervalMs: 20,
    });
    try {
      appendFileSync(logPath, line("novo-evento"));
      // Poll roda a cada 20ms — 500ms dá margem generosa mesmo em CI lento,
      // sem depender só do fs.watch (que pode não disparar em todo ambiente).
      const deadline = Date.now() + 500;
      while (received.length === 0 && Date.now() < deadline) {
        await delay(20);
      }
      assert.ok(received.length >= 1, "esperava ao menos 1 evento novo");
      assert.equal((received[0] as { message: string }).message, "novo-evento");
    } finally {
      handle.close();
      cleanup();
    }
  });

  it("startSize=0 inclui o conteúdo já existente no primeiro poll", async () => {
    const { dir, logPath, cleanup } = setupRoot();
    mkdirSync(dir, { recursive: true });
    writeFileSync(logPath, line("já-existia"));

    const received: unknown[] = [];
    const handle = watchRunLogAppends(logPath, (events) => received.push(...events), {
      pollIntervalMs: 20,
      startSize: 0,
    });
    try {
      const deadline = Date.now() + 500;
      while (received.length === 0 && Date.now() < deadline) {
        await delay(20);
      }
      assert.equal((received[0] as { message: string }).message, "já-existia");
    } finally {
      handle.close();
      cleanup();
    }
  });

  it("close() é idempotente e para os timers", async () => {
    const { dir, logPath, cleanup } = setupRoot();
    mkdirSync(dir, { recursive: true });
    writeFileSync(logPath, line("a"));
    const handle = watchRunLogAppends(logPath, () => {}, { pollIntervalMs: 20 });
    handle.close();
    assert.doesNotThrow(() => handle.close());
    cleanup();
  });
});
