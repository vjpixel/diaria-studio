/**
 * clarice-4952-concurrency.test.ts (#4952)
 *
 * Regression coverage for "Clarice trava recorrentemente no Stage 2 — causa
 * provável é CLARICE_CHUNK_CONCURRENCY=3, não tamanho de payload":
 *
 *   1. `CLARICE_CHUNK_CONCURRENCY` default is serial (1), not the old 3 —
 *      locks the value so a future edit can't silently reintroduce burst
 *      concurrency against cortex.clarice.ai.
 *   2. `resolveChunkConcurrency()` (the env-override resolver) falls back to 1
 *      for unset/invalid values and honors a valid positive integer override —
 *      per the issue's requirement to preserve configurability via env while
 *      changing the DEFAULT to 1.
 *   3. `withClariceRetryChunked` with the default concurrency never has more
 *      than 1 chunk in flight at a time (peak `chunksInFlight` observed via
 *      `onAttempt` logging stays at 0 — i.e., no OTHER chunk was ever
 *      concurrent with the one being attempted).
 *   4. `AttemptLogEntry.chunksInFlight` correctly reports concurrent chunks
 *      when concurrency is explicitly raised above 1 — proves the new
 *      observability field (item 3 of the #4952 fix) is wired end-to-end,
 *      not just present in the type.
 *
 * All tests are deterministic — no real network (mocked fetchImpl), no real
 * sleep (baseBackoffMs: 0 / noSleep).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CLARICE_CHUNK_CONCURRENCY,
  resolveChunkConcurrency,
  withClariceRetryChunked,
  type AttemptLogEntry,
  type RetryPolicy,
} from "../scripts/clarice-correct.ts";
import { splitIntoChunks } from "../scripts/lib/clarice-chunk.ts";

const noSleep = async (_ms: number): Promise<void> => {};

const FAST_POLICY: RetryPolicy = {
  maxAttempts: 1,
  timeoutMs: 5_000,
  baseBackoffMs: 0,
};

/** Gera texto com `nSections` seções separadas por `---`, cada uma grande o
 * bastante para virar 1 chunk próprio sob um `chunkThreshold` moderado. */
function makeManyChunkText(nSections: number): string {
  const filler =
    "Conteudo de preenchimento editorial para forcar o chunking em multiplas secoes distintas. ".repeat(6);
  return Array.from({ length: nSections }, (_, i) => `SECAO_${i}\n${filler}`).join("\n---\n");
}

// ---------------------------------------------------------------------------
// 1. Default é serial (1), não o antigo 3 (#4952)
// ---------------------------------------------------------------------------

describe("#4952 — CLARICE_CHUNK_CONCURRENCY default é serial", () => {
  it("CLARICE_CHUNK_CONCURRENCY exportada é 1 quando CLARICE_CHUNK_CONCURRENCY não está setada no env", () => {
    // A constante é resolvida no module-load; este processo de teste não seta
    // a env var em nenhum outro lugar, então o valor de module-load deve
    // refletir o default. Se este assert falhar por causa de env poluído por
    // outro teste, é sinal de vazamento — não deveria acontecer (nenhum outro
    // teste no repo seta CLARICE_CHUNK_CONCURRENCY no processo).
    assert.equal(
      process.env.CLARICE_CHUNK_CONCURRENCY,
      undefined,
      "precondição: CLARICE_CHUNK_CONCURRENCY não deve estar setada no env do test runner",
    );
    assert.equal(CLARICE_CHUNK_CONCURRENCY, 1, "default deve ser 1 (serial) — não mais 3 (#4952)");
  });
});

// ---------------------------------------------------------------------------
// 2. resolveChunkConcurrency() — resolver puro do override via env
// ---------------------------------------------------------------------------

describe("#4952 — resolveChunkConcurrency() (env override, default 1)", () => {
  function withEnv(value: string | undefined, fn: () => void): void {
    const original = process.env.CLARICE_CHUNK_CONCURRENCY;
    if (value === undefined) delete process.env.CLARICE_CHUNK_CONCURRENCY;
    else process.env.CLARICE_CHUNK_CONCURRENCY = value;
    try {
      fn();
    } finally {
      if (original === undefined) delete process.env.CLARICE_CHUNK_CONCURRENCY;
      else process.env.CLARICE_CHUNK_CONCURRENCY = original;
    }
  }

  it("sem env var → 1", () => {
    withEnv(undefined, () => {
      assert.equal(resolveChunkConcurrency(), 1);
    });
  });

  it("env var inteiro positivo válido → honra o valor (preserva override, #4952 item 2)", () => {
    withEnv("3", () => {
      assert.equal(resolveChunkConcurrency(), 3);
    });
    withEnv("5", () => {
      assert.equal(resolveChunkConcurrency(), 5);
    });
  });

  it("env var inválida (0, negativa, não-numérica, decimal) → cai no default 1", () => {
    for (const invalid of ["0", "-1", "abc", "1.5", ""]) {
      withEnv(invalid, () => {
        assert.equal(resolveChunkConcurrency(), 1, `valor inválido "${invalid}" deve cair no default 1`);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Concorrência default (1) nunca sobrepõe chunks
// ---------------------------------------------------------------------------

describe("#4952 — withClariceRetryChunked com concorrência default nunca sobrepõe chunks", () => {
  it("peak de chunksInFlight observado via onAttempt é sempre 0 (nenhum outro chunk concorrente)", async () => {
    const CHUNK_THRESHOLD = 700;
    const text = makeManyChunkText(4);
    const chunks = splitIntoChunks(text, CHUNK_THRESHOLD);
    assert.ok(chunks.length >= 3, `fixture deve gerar ≥3 chunks; gerou ${chunks.length}`);

    let inFlight = 0;
    let peakInFlight = 0;
    const fetchImpl: typeof fetch = async () => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const attempts: AttemptLogEntry[] = [];
    await withClariceRetryChunked(
      { apiKey: "k", text, fetchImpl, onAttempt: (e) => attempts.push(e) },
      FAST_POLICY,
      noSleep,
      CHUNK_THRESHOLD,
      1, // concorrência explícita = 1, o novo default (#4952)
    );

    assert.equal(peakInFlight, 1, "nunca deve haver mais de 1 request REST simultânea com concorrência 1");
    assert.equal(attempts.length, chunks.length, "1 tentativa logada por chunk (sem retry)");
    for (const a of attempts) {
      assert.equal(
        a.chunksInFlight,
        0,
        "com concorrência 1, chunksInFlight (OUTROS chunks) deve ser sempre 0",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 4. chunksInFlight reflete concorrência real quando > 1 (override explícito)
// ---------------------------------------------------------------------------

describe("#4952 — AttemptLogEntry.chunksInFlight reflete concorrência real (override > 1)", () => {
  it("com concorrência 3, ao menos uma tentativa loga chunksInFlight > 0", async () => {
    const CHUNK_THRESHOLD = 700;
    const text = makeManyChunkText(6);
    const chunks = splitIntoChunks(text, CHUNK_THRESHOLD);
    assert.ok(chunks.length >= 4, `fixture deve gerar ≥4 chunks; gerou ${chunks.length}`);

    const fetchImpl: typeof fetch = async () => {
      // Delay real o bastante para garantir sobreposição entre workers.
      await new Promise((r) => setTimeout(r, 15));
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const attempts: AttemptLogEntry[] = [];
    await withClariceRetryChunked(
      { apiKey: "k", text, fetchImpl, onAttempt: (e) => attempts.push(e) },
      FAST_POLICY,
      noSleep,
      CHUNK_THRESHOLD,
      3, // override explícito — reproduz o teto antigo, agora só sob demanda
    );

    assert.equal(attempts.length, chunks.length, "1 tentativa logada por chunk (sem retry)");
    assert.ok(
      attempts.some((a) => (a.chunksInFlight ?? 0) > 0),
      "com concorrência 3 e fetch com delay, pelo menos 1 tentativa deve ver outro chunk em voo",
    );
    // Nunca deve exceder concurrency-1 outros chunks (teto de 3 → no máx. 2 outros).
    for (const a of attempts) {
      assert.ok(
        (a.chunksInFlight ?? 0) <= 2,
        `chunksInFlight (${a.chunksInFlight}) não deve exceder concurrency-1 (2)`,
      );
    }
  });
});
