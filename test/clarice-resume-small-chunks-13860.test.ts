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

import {
  skipClarice,
  readClaricePending,
  resumeClarice,
  resumeClariceSpaced,
  RESUME_SMALL_CHUNK_CHARS,
} from "../scripts/lib/diaria/clarice-pending.ts";
import { parseCliArgs } from "../scripts/clarice-correct.ts";
import { splitIntoChunks } from "../scripts/lib/diaria/clarice-chunk.ts";

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
      // Sem a flag, Number(undefined) = NaN e splitIntoChunks não termina.
      assert.ok(args.includes("--chunk-chars"), "2ª rodada deve passar --chunk-chars");
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
    assert.equal(calls[0].includes("--timeout-ms"), false);
    // #13888: pequeno não implica rápido; permitir passar de 60s sem
    // triplicar o orçamento por chunk nem remover o deadline da rodada.
    assert.equal(calls[1][calls[1].indexOf("--timeout-ms") + 1], "120000");
    assert.equal(calls[1][calls[1].indexOf("--max-attempts") + 1], "1");
    assert.ok(calls[1].includes("--deadline-ms"));
    assert.equal(calls[1][calls[1].indexOf("--chunk-chars") + 1], String(RESUME_SMALL_CHUNK_CHARS));
    assert.ok(calls[1].includes("--no-paragraph-fallback"));
    assert.equal(rounds[1].chunkChars, RESUME_SMALL_CHUNK_CHARS);
    assert.equal(outcome.status, "resumed");
  });

  it("marcador já com falha de API: a 1ª rodada desta invocação já usa chunk menor", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarice-13860-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "texto humanizado\n");
    skipClarice(dir, "clarice_unavailable", { edition: "261123" });
    // Invocação anterior (fora do cooldown): falhou com timeout, grava failed:3.
    resumeClarice(dir, () => ({ exitCode: 3, stdout: TIMEOUT_STDOUT }), {
      edition: "261123",
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    assert.equal(readClaricePending(dir)?.last_outcome, "failed:3");

    const calls: string[][] = [];
    const { rounds } = resumeClariceSpaced(dir, (args) => {
      calls.push(args);
      return { exitCode: 3, stdout: TIMEOUT_STDOUT };
    }, { edition: "261123", rounds: 1, sleep: () => {} });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][calls[0].indexOf("--timeout-ms") + 1], "120000");
    assert.equal(calls[0][calls[0].indexOf("--max-attempts") + 1], "1");
    assert.equal(calls[0][calls[0].indexOf("--chunk-chars") + 1], String(RESUME_SMALL_CHUNK_CHARS));
    assert.equal(rounds[0].chunkChars, RESUME_SMALL_CHUNK_CHARS);
  });

  it("fact-check presente + sugestão protegida fora do 1º chunk: filtered-chunks retém só ela", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarice-13860-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    const paras = [
      `O texto tem um erro de concordancia. ${"alfa ".repeat(90)}`,
      ...Array.from({ length: 4 }, (_, i) => `Bloco ${i} ${"beta ".repeat(90)}`),
      `A empresa faturou 40 milhões em 2026. ${"gama ".repeat(90)}`,
    ];
    const text = paras.join("\n\n") + "\n";
    writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), text);
    skipClarice(dir, "clarice_unavailable", { edition: "261123" });
    writeFileSync(
      join(dir, "_internal", "fact-check-autofix.json"),
      JSON.stringify({ entries: [{ status: "applied", suggested_fix: "A empresa faturou 40 milhões em 2026." }] }),
    );
    const typo = { from: "concordancia", to: "concordância" };
    const fact = { from: "40 milhões", to: "40 bilhões" };

    let t = 0;
    let chunkCount = 0;
    const runner = (args: string[]) => {
      t += 195_000;
      if (!args.includes("--chunk-chars")) return { exitCode: 3, stdout: TIMEOUT_STDOUT };
      const input = readFileSync(args[args.indexOf("--in") + 1], "utf8");
      const chunks = splitIntoChunks(input, Number(args[args.indexOf("--chunk-chars") + 1]));
      chunkCount = chunks.length;
      const typoIdx = chunks.findIndex((c) => c.text.includes(typo.from));
      const factIdx = chunks.findIndex((c) => c.text.includes(fact.from));
      assert.equal(typoIdx, 0, "erro de digitação no 1º chunk");
      assert.ok(factIdx > 0, "sugestão protegida em chunk diferente do 1º");
      const perChunk = chunks.map((c, i) => ({
        startOffset: c.startOffset,
        length: c.text.length,
        suggestions: i === typoIdx ? [typo] : i === factIdx ? [fact] : [],
      }));
      writeFileSync(args[args.indexOf("--chunks-out") + 1], JSON.stringify(perChunk));
      writeFileSync(args[args.indexOf("--out") + 1], JSON.stringify([typo, fact]));
      writeFileSync(
        args[args.indexOf("--corrected-out") + 1],
        input.replace(typo.from, typo.to).replace(fact.from, fact.to),
      );
      return {
        exitCode: 0,
        stdout: JSON.stringify({ suggestions_count: 2, chunks: chunks.length, chunks_used_paragraph_fallback: 0, paragraphs_failed: 0 }) + "\n",
      };
    };
    const { outcome } = resumeClariceSpaced(dir, runner, { edition: "261123", sleep: () => {}, clock: () => t });
    assert.ok(chunkCount > 1);
    assert.equal(outcome.status, "resumed");
    assert.equal(outcome.status === "resumed" && outcome.applyMode, "filtered-chunks");
    assert.deepEqual(outcome.status === "resumed" && outcome.protectedSuggestions, [fact]);
    assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), text.replace(typo.from, typo.to));
  });

  it("parseCliArgs aceita --chunk-chars", () => {
    const a = parseCliArgs(["--in", "a", "--out", "b", "--chunk-chars", "1800"]);
    assert.equal(a?.chunkChars, 1800);
  });
});
