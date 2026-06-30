import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  correctTextViaREST,
  extractSuggestions,
  withClariceRetry,
  ClariceHttpError,
  correctTextChunked,
  withClariceRetryChunked,
  type RetryPolicy,
  type ChunkedResult,
  type ChunkedRetryResult,
} from "../scripts/clarice-correct.ts";
import { CLARICE_CHUNK_THRESHOLD } from "../scripts/lib/clarice-chunk.ts";

function mockFetch(response: {
  status: number;
  body: unknown;
}): typeof fetch {
  return async () => {
    return new Response(
      typeof response.body === "string"
        ? response.body
        : JSON.stringify(response.body),
      { status: response.status, headers: { "Content-Type": "application/json" } },
    );
  };
}

describe("correctTextViaREST", () => {
  it("retorna lista de sugestões quando API responde com array top-level", async () => {
    const fetchImpl = mockFetch({
      status: 200,
      body: [{ from: "x", to: "y", rule: "test" }],
    });
    const result = await correctTextViaREST({
      apiKey: "k",
      text: "texto",
      fetchImpl,
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].from, "x");
    assert.equal(result[0].to, "y");
  });

  it("extrai paragraphs[].suggestions[] quando API responde envelopado", async () => {
    const fetchImpl = mockFetch({
      status: 200,
      body: {
        paragraphs: [
          { suggestions: [{ from: "a", to: "b" }, { from: "c", to: "d" }] },
          { suggestions: [{ from: "e", to: "f" }] },
        ],
      },
    });
    const result = await correctTextViaREST({
      apiKey: "k",
      text: "texto",
      fetchImpl,
    });
    assert.equal(result.length, 3);
    assert.deepEqual(
      result.map((s) => s.from),
      ["a", "c", "e"],
    );
  });

  it("retorna [] quando endpoint responde objeto sem suggestions/paragraphs/results", async () => {
    const fetchImpl = mockFetch({ status: 200, body: { ok: true } });
    const result = await correctTextViaREST({
      apiKey: "k",
      text: "texto",
      fetchImpl,
    });
    assert.equal(result.length, 0);
  });

  it("lança erro com HTTP status em non-2xx", async () => {
    const fetchImpl = mockFetch({ status: 401, body: "unauthorized" });
    await assert.rejects(
      () =>
        correctTextViaREST({
          apiKey: "k",
          text: "texto",
          fetchImpl,
        }),
      /HTTP 401/,
    );
  });

  it("passa X-API-Key no header", async () => {
    let captured: Headers | null = null;
    const fetchImpl: typeof fetch = async (_url, init) => {
      captured = new Headers(init?.headers);
      return new Response("[]", { status: 200 });
    };
    await correctTextViaREST({ apiKey: "secret123", text: "x", fetchImpl });
    assert.equal(captured!.get("x-api-key"), "secret123");
  });

  it("envia body com paragraphs[0].description = text", async () => {
    let captured: string | null = null;
    const fetchImpl: typeof fetch = async (_url, init) => {
      captured = typeof init?.body === "string" ? init.body : null;
      return new Response("[]", { status: 200 });
    };
    await correctTextViaREST({ apiKey: "k", text: "olá mundo", fetchImpl });
    const parsed = JSON.parse(captured!) as { paragraphs: Array<{ description: string }> };
    assert.equal(parsed.paragraphs[0].description, "olá mundo");
  });
});

describe("extractSuggestions", () => {
  it("aceita array direto", () => {
    assert.equal(extractSuggestions([{ from: "x", to: "y" }]).length, 1);
  });

  it("aceita { suggestions: [...] }", () => {
    assert.equal(
      extractSuggestions({ suggestions: [{ from: "x", to: "y" }] }).length,
      1,
    );
  });

  it("aceita { results: [...] }", () => {
    assert.equal(
      extractSuggestions({ results: [{ from: "x", to: "y" }] }).length,
      1,
    );
  });

  it("rejeita shapes inválidos (sem from/to)", () => {
    assert.throws(() => extractSuggestions([{ rule: "x" }]));
  });
});

// ---------------------------------------------------------------------------
// #2338 fix 3 — ClariceHttpError structural detection
// ---------------------------------------------------------------------------

describe("ClariceHttpError (#2338)", () => {
  it("correctTextViaREST lança ClariceHttpError com .status em non-2xx", async () => {
    const fetchImpl = mockFetch({ status: 401, body: "unauthorized" });
    let caught: unknown;
    try {
      await correctTextViaREST({ apiKey: "k", text: "texto", fetchImpl });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof ClariceHttpError, "deve ser ClariceHttpError");
    assert.equal((caught as ClariceHttpError).status, 401);
    assert.match((caught as ClariceHttpError).message, /HTTP 401/);
  });

  it("correctTextViaREST lança ClariceHttpError com .status 403", async () => {
    const fetchImpl = mockFetch({ status: 403, body: "forbidden" });
    let caught: unknown;
    try {
      await correctTextViaREST({ apiKey: "k", text: "texto", fetchImpl });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof ClariceHttpError, "deve ser ClariceHttpError");
    assert.equal((caught as ClariceHttpError).status, 403);
  });
});

describe("withClariceRetry (#2338) — 4xx fast-fail, 5xx retries", () => {
  const noSleep = async (_ms: number): Promise<void> => {};
  const fastPolicy: RetryPolicy = {
    maxAttempts: 3,
    timeoutMs: 5_000,
    baseBackoffMs: 0,
  };

  it("401 → fast-fail sem retry (attempts = 1)", async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = async () => {
      callCount++;
      return new Response("unauthorized", { status: 401 });
    };
    await assert.rejects(
      () =>
        withClariceRetry({ apiKey: "k", text: "x", fetchImpl }, fastPolicy, noSleep),
      ClariceHttpError,
      "deve rejeitar com ClariceHttpError",
    );
    assert.equal(callCount, 1, "401 não deve ser retentado — deve chamar fetch apenas 1×");
  });

  it("403 → fast-fail sem retry (attempts = 1)", async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = async () => {
      callCount++;
      return new Response("forbidden", { status: 403 });
    };
    await assert.rejects(
      () =>
        withClariceRetry({ apiKey: "k", text: "x", fetchImpl }, fastPolicy, noSleep),
      ClariceHttpError,
    );
    assert.equal(callCount, 1, "403 não deve ser retentado");
  });

  it("503 → retried até maxAttempts (3 chamadas)", async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = async () => {
      callCount++;
      return new Response("service unavailable", { status: 503 });
    };
    await assert.rejects(
      () =>
        withClariceRetry({ apiKey: "k", text: "x", fetchImpl }, fastPolicy, noSleep),
    );
    assert.equal(callCount, fastPolicy.maxAttempts, `5xx deve tentar ${fastPolicy.maxAttempts}×`);
  });

  it("sucesso na 2ª tentativa após 503 → retorna resultado", async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = async () => {
      callCount++;
      if (callCount === 1) return new Response("service unavailable", { status: 503 });
      return new Response(JSON.stringify([{ from: "a", to: "b" }]), { status: 200 });
    };
    const result = await withClariceRetry({ apiKey: "k", text: "x", fetchImpl }, fastPolicy, noSleep);
    assert.equal(result.attempts, 2, "deve ter usado 2 tentativas");
    assert.equal(result.suggestions.length, 1);
  });
});

// ---------------------------------------------------------------------------
// #2626 — correctTextChunked: REST fallback com chunking para texto >10k
// ---------------------------------------------------------------------------

/**
 * Constrói um fetchImpl que captura as requests e retorna sugestões para cada chunk.
 * Cada call à REST recebe o texto de UM chunk — o mock responde com a sugestão
 * configurada para aquele call (0-indexed).
 */
function makeFetchWithCapture(responsesPerCall: Array<Array<{ from: string; to: string }>>) {
  const capturedBodies: Array<{ text: string }> = [];
  let callIndex = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    const bodyStr = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyStr) as { paragraphs: Array<{ description: string }> };
    capturedBodies.push({ text: parsed.paragraphs[0].description });
    const resp = responsesPerCall[callIndex] ?? [];
    callIndex++;
    return new Response(JSON.stringify(resp), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchImpl, capturedBodies, callCount: () => callIndex };
}

/** Gera texto sintético com >10k chars usando parágrafos separados por \n\n. */
function makeLongText(minLength = CLARICE_CHUNK_THRESHOLD + 5_000): string {
  const paragraph = "Texto editorial de teste com conteúdo suficiente para chunking. ".repeat(5) + "\n\n";
  let text = "ERRO_CHUNK1 aparece aqui no início.\n\n";
  while (text.length < minLength) text += paragraph;
  // Garantir que ERRO_CHUNK2 apareça perto do final (segundo chunk)
  text += "ERRO_CHUNK2 aparece aqui no final.\n\n";
  return text;
}

describe("correctTextChunked (#2626) — REST fallback com chunking", () => {
  it("texto < threshold → 1 request REST (sem overhead de chunking)", async () => {
    const shortText = "Texto curto que não precisa de chunking.";
    assert.ok(shortText.length < CLARICE_CHUNK_THRESHOLD, "fixture deve ser menor que o threshold");

    const { fetchImpl, callCount } = makeFetchWithCapture([
      [{ from: "curto", to: "breve" }],
    ]);

    const result = await correctTextChunked({ apiKey: "k", text: shortText, fetchImpl });

    assert.equal(callCount(), 1, "texto curto deve fazer exatamente 1 request REST");
    assert.equal(result.chunkCount, 1, "chunkCount deve ser 1 para texto curto");
    assert.ok(result.correctedText.includes("breve"), "sugestão do único chunk deve ser aplicada");
    assert.equal(result.rawSuggestions.length, 1, "rawSuggestions deve conter a sugestão do chunk");
  });

  it("texto > threshold → ≥2 requests REST (chunking ativo)", async () => {
    const longText = makeLongText();
    assert.ok(longText.length > CLARICE_CHUNK_THRESHOLD, "fixture deve exceder o threshold");

    // Cada chunk recebe uma sugestão diferente para verificar merge
    const { fetchImpl, callCount } = makeFetchWithCapture([
      [{ from: "ERRO_CHUNK1", to: "CORRIGIDO_CHUNK1" }],
      [{ from: "ERRO_CHUNK2", to: "CORRIGIDO_CHUNK2" }],
      [], // chunks adicionais retornam []
      [],
    ]);

    const result = await correctTextChunked({ apiKey: "k", text: longText, fetchImpl });

    assert.ok(callCount() >= 2, `texto longo deve fazer ≥2 requests REST; fez ${callCount()}`);
    assert.ok(result.chunkCount >= 2, `chunkCount deve ser ≥2; foi ${result.chunkCount}`);
  });

  it("texto > threshold → sugestões de cada chunk remapeadas corretamente no texto corrigido", async () => {
    const longText = makeLongText();

    const { fetchImpl } = makeFetchWithCapture([
      [{ from: "ERRO_CHUNK1", to: "CORRIGIDO_CHUNK1" }],
      [{ from: "ERRO_CHUNK2", to: "CORRIGIDO_CHUNK2" }],
      [],
      [],
    ]);

    const result: ChunkedResult = await correctTextChunked({ apiKey: "k", text: longText, fetchImpl });

    // Ambas as correções devem aparecer no texto final (cada uma aplicada no seu chunk)
    assert.ok(
      result.correctedText.includes("CORRIGIDO_CHUNK1"),
      "sugestão do chunk 1 (início do texto) deve estar aplicada no correctedText",
    );
    assert.ok(
      result.correctedText.includes("CORRIGIDO_CHUNK2"),
      "sugestão do chunk 2 (final do texto) deve estar aplicada no correctedText",
    );
    // Originais não devem mais existir no texto corrigido
    assert.ok(
      !result.correctedText.includes("ERRO_CHUNK1"),
      "ERRO_CHUNK1 deve ter sido substituído",
    );
    assert.ok(
      !result.correctedText.includes("ERRO_CHUNK2"),
      "ERRO_CHUNK2 deve ter sido substituído",
    );
  });

  it("texto > threshold → rawSuggestions contém todas as sugestões de todos os chunks", async () => {
    const longText = makeLongText();

    const { fetchImpl } = makeFetchWithCapture([
      [{ from: "ERRO_CHUNK1", to: "CORRIGIDO_CHUNK1" }],
      [{ from: "ERRO_CHUNK2", to: "CORRIGIDO_CHUNK2" }],
      [],
      [],
    ]);

    const result = await correctTextChunked({ apiKey: "k", text: longText, fetchImpl });

    // rawSuggestions deve conter as sugestões de ambos os chunks
    assert.ok(result.rawSuggestions.length >= 2, "rawSuggestions deve acumular sugestões de todos os chunks");
    const froms = result.rawSuggestions.map((s) => s.from);
    assert.ok(froms.includes("ERRO_CHUNK1"), "rawSuggestions deve incluir sugestão do chunk 1");
    assert.ok(froms.includes("ERRO_CHUNK2"), "rawSuggestions deve incluir sugestão do chunk 2");
  });

  it("texto > threshold → correctedText tem mesmo comprimento aproximado ao original (com substituições)", async () => {
    const longText = makeLongText();
    const { fetchImpl } = makeFetchWithCapture([
      [{ from: "ERRO_CHUNK1", to: "CORRIGIDO_CHUNK1" }],
      [],
      [],
    ]);

    const result = await correctTextChunked({ apiKey: "k", text: longText, fetchImpl });

    // Texto corrigido deve ser similar ao original (só 1 correção de tamanho diferente)
    const expectedLengthDiff = "CORRIGIDO_CHUNK1".length - "ERRO_CHUNK1".length;
    assert.equal(
      result.correctedText.length,
      longText.length + expectedLengthDiff,
      "comprimento do correctedText deve refletir exatamente as substituições aplicadas",
    );
  });

  it("chunks reconstruem o texto original (invariante splitIntoChunks)", async () => {
    const longText = makeLongText();
    const { fetchImpl } = makeFetchWithCapture([[], [], [], []]);

    // Sem sugestões → correctedText deve ser idêntico ao input
    const result = await correctTextChunked({ apiKey: "k", text: longText, fetchImpl });

    assert.equal(
      result.correctedText,
      longText,
      "sem sugestões, correctedText deve ser byte-idêntico ao texto original",
    );
  });
});

// ---------------------------------------------------------------------------
// #2626 — withClariceRetryChunked: chunking + retry por chunk
// ---------------------------------------------------------------------------

describe("withClariceRetryChunked (#2626) — chunking + retry", () => {
  const noSleep = async (_ms: number): Promise<void> => {};
  const fastPolicy: RetryPolicy = {
    maxAttempts: 2,
    timeoutMs: 5_000,
    baseBackoffMs: 0,
  };

  it("texto < threshold → 1 request, totalAttempts = 1", async () => {
    const shortText = "Texto curto para teste de retry chunked.";
    const { fetchImpl, callCount } = makeFetchWithCapture([
      [{ from: "curto", to: "breve" }],
    ]);

    const result: ChunkedRetryResult = await withClariceRetryChunked(
      { apiKey: "k", text: shortText, fetchImpl },
      fastPolicy,
      noSleep,
    );

    assert.equal(callCount(), 1, "texto curto: 1 request REST");
    assert.equal(result.chunkCount, 1);
    assert.equal(result.totalAttempts, 1);
    assert.ok(result.correctedText.includes("breve"), "sugestão aplicada");
  });

  it("texto > threshold → ≥2 requests, totalAttempts ≥ chunkCount", async () => {
    const longText = makeLongText();

    const { fetchImpl, callCount } = makeFetchWithCapture([
      [{ from: "ERRO_CHUNK1", to: "CORRIGIDO_CHUNK1" }],
      [{ from: "ERRO_CHUNK2", to: "CORRIGIDO_CHUNK2" }],
      [],
      [],
    ]);

    const result: ChunkedRetryResult = await withClariceRetryChunked(
      { apiKey: "k", text: longText, fetchImpl },
      fastPolicy,
      noSleep,
    );

    assert.ok(callCount() >= 2, `≥2 requests REST esperados; fez ${callCount()}`);
    assert.ok(result.chunkCount >= 2, `chunkCount ≥2; foi ${result.chunkCount}`);
    assert.ok(
      result.totalAttempts >= result.chunkCount,
      "totalAttempts deve ser ≥ chunkCount (1 tentativa por chunk no mínimo)",
    );
    assert.ok(result.correctedText.includes("CORRIGIDO_CHUNK1"), "sugestão chunk 1 aplicada");
    assert.ok(result.correctedText.includes("CORRIGIDO_CHUNK2"), "sugestão chunk 2 aplicada");
  });

  it("retry por chunk: 503 no primeiro chunk → retry e sucesso na 2ª tentativa", async () => {
    const shortText = "Texto de teste para retry por chunk.";
    let callCount = 0;
    const fetchImpl: typeof fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("service unavailable", { status: 503 });
      }
      return new Response(JSON.stringify([{ from: "teste", to: "ensaio" }]), { status: 200 });
    };

    const result = await withClariceRetryChunked(
      { apiKey: "k", text: shortText, fetchImpl },
      fastPolicy,
      noSleep,
    );

    assert.equal(callCount, 2, "deve ter feito 2 requests (1 falha + 1 sucesso)");
    assert.equal(result.totalAttempts, 2, "totalAttempts deve refletir os 2 attempts do chunk");
    assert.ok(result.correctedText.includes("ensaio"), "sugestão aplicada após retry");
  });
});
