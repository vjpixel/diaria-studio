/**
 * test/studio-review-file-watch.test.ts (#8123 Fatia 1) — cobertura de
 * scripts/studio-ui/review-file-watch.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { computeReviewVersion, watchReviewFiles } from "../scripts/studio-ui/review-file-watch.ts";

function setupRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "studio-review-file-watch-"));
  mkdirSync(join(root, "data", "editions"), { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function editionDir(root: string, aammdd: string): string {
  const dir = join(root, "data", "editions", aammdd.slice(0, 4), aammdd);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("computeReviewVersion (#8123)", () => {
  it("AAMMDD inválido: hash null, não lança", () => {
    const { root, cleanup } = setupRoot();
    try {
      const stamp = computeReviewVersion(root, "abc");
      assert.equal(stamp.hash, null);
      assert.equal(stamp.aammdd, "abc");
    } finally {
      cleanup();
    }
  });

  it("edição sem 02-reviewed.md/03-social.md: hash null", () => {
    const { root, cleanup } = setupRoot();
    try {
      editionDir(root, "260916");
      const stamp = computeReviewVersion(root, "260916");
      assert.equal(stamp.hash, null);
    } finally {
      cleanup();
    }
  });

  it("com 02-reviewed.md presente: hash não-null, estável pro mesmo conteúdo", () => {
    const { root, cleanup } = setupRoot();
    try {
      const dir = editionDir(root, "260916");
      writeFileSync(join(dir, "02-reviewed.md"), "conteúdo v1");
      const a = computeReviewVersion(root, "260916");
      const b = computeReviewVersion(root, "260916");
      assert.ok(a.hash);
      assert.equal(a.hash, b.hash);
    } finally {
      cleanup();
    }
  });

  it("conteúdo diferente produz hash diferente", () => {
    const { root, cleanup } = setupRoot();
    try {
      const dir = editionDir(root, "260916");
      writeFileSync(join(dir, "02-reviewed.md"), "conteúdo v1");
      const a = computeReviewVersion(root, "260916");
      writeFileSync(join(dir, "02-reviewed.md"), "conteúdo v2");
      const b = computeReviewVersion(root, "260916");
      assert.notEqual(a.hash, b.hash);
    } finally {
      cleanup();
    }
  });
});

describe("watchReviewFiles (#8123)", () => {
  it("dispara onChange quando 02-reviewed.md muda", async () => {
    const { root, cleanup } = setupRoot();
    const dir = editionDir(root, "260916");
    writeFileSync(join(dir, "02-reviewed.md"), "v1");

    const changes: unknown[] = [];
    const handle = watchReviewFiles(root, "260916", (stamp) => changes.push(stamp), {
      pollIntervalMs: 20,
      debounceMs: 20,
    });
    try {
      await delay(60); // estabiliza antes de reescrever
      writeFileSync(join(dir, "02-reviewed.md"), "v2 — bem diferente");

      const deadline = Date.now() + 800;
      while (changes.length === 0 && Date.now() < deadline) {
        await delay(20);
      }
      assert.ok(changes.length >= 1, "esperava ao menos 1 mudança detectada");
      assert.equal((changes[0] as { aammdd: string }).aammdd, "260916");
      assert.ok((changes[0] as { hash: string | null }).hash);
    } finally {
      handle.close();
      cleanup();
    }
  });

  it("burst de writes coalesce num único onChange (debounce)", async () => {
    const { root, cleanup } = setupRoot();
    const dir = editionDir(root, "260916");
    writeFileSync(join(dir, "02-reviewed.md"), "v0");

    const changes: unknown[] = [];
    const handle = watchReviewFiles(root, "260916", (stamp) => changes.push(stamp), {
      pollIntervalMs: 15,
      debounceMs: 150,
    });
    try {
      await delay(60);
      for (let i = 1; i <= 5; i++) {
        writeFileSync(join(dir, "02-reviewed.md"), `v${i}`);
        await delay(20); // menor que o debounce — todo o burst deve coalescer
      }

      const deadline = Date.now() + 800;
      while (changes.length === 0 && Date.now() < deadline) {
        await delay(20);
      }
      await delay(250); // garante que nenhum 2º evento chegue atrasado
      assert.equal(changes.length, 1, "burst inteiro deveria virar 1 única mudança");
    } finally {
      handle.close();
      cleanup();
    }
  });

  it("close() é idempotente", () => {
    const { root, cleanup } = setupRoot();
    editionDir(root, "260916");
    const handle = watchReviewFiles(root, "260916", () => {}, { pollIntervalMs: 20 });
    handle.close();
    assert.doesNotThrow(() => handle.close());
    cleanup();
  });
});
