/**
 * #13860 — edição 261123: chunk de ~4 KB estourou 60 s em todas as tentativas
 * do resume enquanto payloads pequenos respondiam em segundos. Depois de falha
 * de API, a rodada seguinte manda `--chunk-chars` menor; a remontagem por chunk
 * (`--chunks-out` + applyChunkSuggestions) cobre vários chunks.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skipClarice, resumeClariceSpaced, RESUME_SMALL_CHUNK_CHARS } from "../scripts/lib/clarice-pending.ts";
import { parseCliArgs } from "../scripts/clarice-correct.ts";
import { splitIntoChunks } from "../scripts/lib/clarice-chunk.ts";

const TIMEOUT_STDOUT = '{"failure":{"kind":"timeout","message":"não respondeu em 60s"}}\n';

describe("resume com chunk menor depois de timeout (#13860)", () => {
  it("1ª rodada usa chunk default, 2ª passa --chunk-chars e aplica com vários chunks", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarice-13860-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    const text = Array.from({ length: 6 }, (_, i) => `Parágrafo ${i} ${"palavra ".repeat(60)}`).join("\n\n") + "\n";
    writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), text);
    skipClarice(dir, "clarice_unavailable", { edition: "261123" });

    const calls: string[][] = [];
    let t = 0;
    const runner = (args: string[]) => {
      calls.push(args);
      t += 195_000;
      if (calls.length === 1) return { exitCode: 3, stdout: TIMEOUT_STDOUT };
      const input = readFileSync(args[args.indexOf("--in") + 1], "utf8");
      const size = Number(args[args.indexOf("--chunk-chars") + 1]);
      const chunks = splitIntoChunks(input, size);
      assert.ok(chunks.length > 1, "texto deve virar vários chunks");
      writeFileSync(args[args.indexOf("--corrected-out") + 1], input);
      writeFileSync(args[args.indexOf("--out") + 1], "[]");
      writeFileSync(
        args[args.indexOf("--chunks-out") + 1],
        JSON.stringify(chunks.map((c) => ({ startOffset: c.startOffset, length: c.text.length, suggestions: [] }))),
      );
      return {
        exitCode: 0,
        stdout: JSON.stringify({ suggestions_count: 0, chunks: chunks.length, chunks_used_paragraph_fallback: 0, paragraphs_failed: 0 }) + "\n",
      };
    };
    const { outcome, rounds } = resumeClariceSpaced(dir, runner, {
      edition: "261123", sleep: () => {}, clock: () => t,
    });
    assert.equal(calls[0].includes("--chunk-chars"), false);
    assert.equal(calls[1][calls[1].indexOf("--chunk-chars") + 1], String(RESUME_SMALL_CHUNK_CHARS));
    assert.ok(calls[1].includes("--no-paragraph-fallback"));
    assert.equal(rounds[1].chunkChars, RESUME_SMALL_CHUNK_CHARS);
    assert.equal(outcome.status, "resumed");
  });

  it("parseCliArgs aceita --chunk-chars", () => {
    const a = parseCliArgs(["--in", "a", "--out", "b", "--chunk-chars", "1800"]);
    assert.equal(a?.chunkChars, 1800);
  });
});
