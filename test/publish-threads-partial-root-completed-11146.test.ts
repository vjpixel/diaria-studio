import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { completePartialThread, decideThreadsDispatch, partialThreadRecoveryHint } from "../scripts/publish-threads.ts";
import type { PostEntry } from "../scripts/lib/social-published-store.ts";

const partial: PostEntry = {
  platform: "threads", destaque: "d2", status: "failed", url: "https://threads.net/root",
  scheduled_at: null, threads_partial_root_media_id: "root-123", reason: "chunk 2 failed",
};

describe("conclusão manual da thread parcial (#11146)", () => {
  it("preserva a raiz e permalink, limpa falha e passa a ser pulada no resume", () => {
    for (const status of ["failed", "send_unknown"] as const) {
      const result = completePartialThread({ ...partial, status });
      assert.equal(result.status, "published");
      assert.equal(result.threads_media_id, "root-123");
      assert.equal(result.url, partial.url);
      assert.equal(result.threads_partial_root_media_id, undefined);
      assert.equal(result.reason, undefined);
      assert.equal(decideThreadsDispatch("d2", result, { skipExisting: true, retryIds: null }).action, "skip-existing");
      assert.equal(decideThreadsDispatch("d2", result, { skipExisting: true, retryIds: new Set(["d2"]) }).action, "retry-refused");
    }
    assert.equal(partial.status, "failed");
  });

  it("recusa estados sem uma raiz parcial válida", () => {
    for (const entry of [undefined, { ...partial, status: "published" }, { ...partial, platform: "facebook" },
      { ...partial, subtype: "comment_diaria" }, { ...partial, threads_partial_root_media_id: " " },
      { ...partial, threads_partial_root_media_id: 123 }, { ...partial, threads_partial_root_media_id: undefined }]) {
      assert.throws(() => completePartialThread(entry as PostEntry | undefined));
    }
  });

  it("CLI grava só o post escolhido e rejeita entradas inválidas sem alterar o arquivo", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "threads-completed-"));
    try {
      mkdirSync(resolve(dir, "_internal"));
      const path = resolve(dir, "_internal/06-social-published.json");
      const other = { ...partial, platform: "facebook" };
      writeFileSync(path, JSON.stringify({ posts: [partial, other], metadata: "preservar" }));
      const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/publish-threads.ts", "--edition-dir", dir, ...args], { encoding: "utf8" });
      for (const args of [[], ["d4"], ["d1,d2"], [""], ["d1"], ["d2", "--retry", "d2"], ["d2", "--dry-run"], ["d2", "--schedule"]]) {
        const before = readFileSync(path, "utf8");
        assert.equal(run("--partial-root-completed", ...args).status, 1);
        assert.equal(readFileSync(path, "utf8"), before);
      }
      const result = run("--partial-root-completed", "d2");
      assert.equal(result.status, 0, result.stderr);
      const saved = JSON.parse(readFileSync(path, "utf8"));
      assert.deepEqual(saved.posts, [completePartialThread(partial), other]);
      assert.equal(saved.metadata, "preservar");
      assert.equal(run("--partial-root-completed", "d2").status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hint ensina registrar conclusão e alerta para respostas órfãs", () => {
    const hint = partialThreadRecoveryHint("d2", { rootMediaId: "root", chunksPublished: 2 }, 3);
    assert.match(hint, /--partial-root-completed d2/);
    assert.match(hint, /apagar também as respostas/);
    assert.match(hint, /pode deixar respostas órfãs e visíveis/);
  });
});
