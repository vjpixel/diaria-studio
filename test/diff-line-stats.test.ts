/**
 * test/diff-line-stats.test.ts (#7112, helper comum de #7113/#7115)
 *
 * Dado sintético — sem tocar `git` real (`getDiffLineStats`, o único ponto
 * de I/O, é injetável via `spawnFn` e não coberto aqui além do smoke abaixo).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  diffNet,
  diffRatio,
  formatRatio,
  getDiffLineStats,
  parseNumstat,
} from "../scripts/lib/diff-line-stats.ts";

describe("parseNumstat", () => {
  it("soma added/removed/files de múltiplas linhas", () => {
    const out = "10\t3\tfoo.ts\n5\t0\tbar.ts\n0\t7\tbaz.ts\n";
    assert.deepEqual(parseNumstat(out), { files: 3, added: 15, removed: 10 });
  });

  it("trata arquivo binário (-\\t-\\tpath) como 0/0 mas conta o arquivo", () => {
    const out = "10\t3\tfoo.ts\n-\t-\tlogo.png\n";
    assert.deepEqual(parseNumstat(out), { files: 2, added: 10, removed: 3 });
  });

  it("ignora linhas vazias e output vazio", () => {
    assert.deepEqual(parseNumstat(""), { files: 0, added: 0, removed: 0 });
    assert.deepEqual(parseNumstat("\n\n"), { files: 0, added: 0, removed: 0 });
  });
});

describe("diffRatio", () => {
  it("calcula added/removed", () => {
    assert.equal(diffRatio(180, 10), 18);
  });

  it("retorna null quando removed é 0 (razão indefinida, não Infinity)", () => {
    assert.equal(diffRatio(100, 0), null);
  });

  it("retorna null quando removed é negativo (defensivo)", () => {
    assert.equal(diffRatio(100, -1), null);
  });
});

describe("diffNet", () => {
  it("added - removed, pode ser negativo", () => {
    assert.equal(diffNet(100, 30), 70);
    assert.equal(diffNet(10, 50), -40);
  });
});

describe("formatRatio", () => {
  it("formata razão numérica com 1 casa decimal", () => {
    assert.equal(formatRatio(18, 180), "18.0:1");
    assert.equal(formatRatio(7.333, 100), "7.3:1");
  });

  it("null com added>0 vira 'sem remoções'", () => {
    assert.equal(formatRatio(null, 50), "sem remoções");
  });

  it("null com added===0 vira '0:0' (diff vazio)", () => {
    assert.equal(formatRatio(null, 0), "0:0");
  });
});

describe("getDiffLineStats", () => {
  it("chama git diff --numstat com os refs certos e parseia o stdout", () => {
    let capturedArgs: string[] | null = null;
    const fakeSpawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return { status: 0, stdout: "4\t2\tfoo.ts\n", stderr: "" } as ReturnType<typeof import("node:child_process").spawnSync>;
    }) as typeof import("node:child_process").spawnSync;

    const stats = getDiffLineStats("abc123", "def456", { spawnFn: fakeSpawn });
    assert.deepEqual(stats, { files: 1, added: 4, removed: 2 });
    assert.deepEqual(capturedArgs, ["diff", "--numstat", "abc123..def456"]);
  });

  it("lança quando git falha (status !== 0)", () => {
    const fakeSpawn = (() => ({ status: 1, stdout: "", stderr: "fatal: bad revision" })) as unknown as typeof import("node:child_process").spawnSync;
    assert.throws(() => getDiffLineStats("bad", "HEAD", { spawnFn: fakeSpawn }), /git diff --numstat/);
  });
});
