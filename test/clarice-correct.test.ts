import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  correctTextViaREST,
  extractSuggestions,
  withClariceRetry,
  ClariceHttpError,
  correctTextChunked,
  withClariceRetryChunked,
  correctChunkViaParagraphs,
  correctTextViaParagraphs,
  isFatalHttpError,
  PARAGRAPH_FALLBACK_TIMEOUT_MS,
  type RetryPolicy,
  type ChunkedResult,
  type ChunkedRetryResult,
  type AttemptLogEntry,
} from "../scripts/clarice-correct.ts";
import { CLARICE_CHUNK_THRESHOLD, splitIntoChunks, type TextChunk } from "../scripts/lib/clarice-chunk.ts";
import { applyClariceSuggestions, countOccurrences } from "../scripts/clarice-apply.ts";

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
// #2852 — onAttempt callback que lança não pode mudar o resultado do retry
// (observabilidade é sempre best-effort, nunca deve afetar o resultado real).
// ---------------------------------------------------------------------------

describe("withClariceRetry (#2852) — onAttempt que lança não afeta o resultado", () => {
  const noSleep = async (_ms: number): Promise<void> => {};
  const fastPolicy: RetryPolicy = {
    maxAttempts: 3,
    timeoutMs: 5_000,
    baseBackoffMs: 0,
  };

  it("onAttempt lança no caminho de SUCESSO → resultado é preservado, sem retry extra", async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = async () => {
      callCount++;
      return new Response(JSON.stringify([{ from: "a", to: "b" }]), { status: 200 });
    };
    const onAttempt = () => {
      throw new Error("callback boom (success path)");
    };

    const result = await withClariceRetry(
      { apiKey: "k", text: "x", fetchImpl, onAttempt },
      fastPolicy,
      noSleep,
    );

    assert.equal(callCount, 1, "callback que lança no sucesso não deve gerar retry extra");
    assert.equal(result.attempts, 1, "attempts deve refletir sucesso na 1ª tentativa");
    assert.equal(result.suggestions.length, 1, "resultado BEM-SUCEDIDO deve ser preservado, não descartado");
    assert.equal(result.suggestions[0].from, "a");
  });

  it("onAttempt lança no caminho de FALHA (4xx) → erro REAL preservado, is4xx break respeitado", async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = async () => {
      callCount++;
      return new Response("unauthorized", { status: 401 });
    };
    const onAttempt = () => {
      throw new Error("callback boom (failure path)");
    };

    let caught: unknown;
    try {
      await withClariceRetry(
        { apiKey: "k", text: "x", fetchImpl, onAttempt },
        fastPolicy,
        noSleep,
      );
    } catch (e) {
      caught = e;
    }

    assert.ok(
      caught instanceof ClariceHttpError,
      `erro propagado deve ser o ClariceHttpError REAL (401), não o erro do callback; got: ${(caught as Error)?.constructor?.name} — ${(caught as Error)?.message}`,
    );
    assert.equal((caught as ClariceHttpError).status, 401);
    assert.equal(callCount, 1, "4xx deve continuar fast-failing (is4xx break) mesmo com callback que lança");
  });

  it("onAttempt lança no caminho de FALHA (5xx retryable) → retry continua normalmente até maxAttempts", async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = async () => {
      callCount++;
      return new Response("service unavailable", { status: 503 });
    };
    const onAttempt = () => {
      throw new Error("callback boom (retryable failure path)");
    };

    await assert.rejects(
      () =>
        withClariceRetry(
          { apiKey: "k", text: "x", fetchImpl, onAttempt },
          fastPolicy,
          noSleep,
        ),
      ClariceHttpError,
    );
    assert.equal(
      callCount,
      fastPolicy.maxAttempts,
      "5xx retryable deve continuar tentando maxAttempts× mesmo com callback que lança a cada tentativa",
    );
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
    const parsed = JSON.parse(bodyStr) as { paragraphs?: Array<{ description: string }> };
    // Guard (#2701 item 5 do self-review #2700): sem isso, um shape inesperado de
    // `init.body` (ex: `paragraphs` ausente) faria `parsed.paragraphs[0]` lançar um
    // TypeError críptico ("Cannot read properties of undefined") em vez de uma
    // assertion legível apontando pro fixture/chamador errado.
    assert.ok(
      Array.isArray(parsed.paragraphs) && parsed.paragraphs.length > 0 && typeof parsed.paragraphs[0]?.description === "string",
      `makeFetchWithCapture: body não tem o shape esperado { paragraphs: [{ description }] }. Recebido: ${bodyStr}`,
    );
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

/**
 * Gera texto sintético que divide em EXATAMENTE 2 chunks no threshold corrente.
 * #2798: sizing RELATIVO ao threshold (×1.5), não `+5_000` fixo — com o threshold
 * baixado pra 4.5k, `+5_000` (=9.5k) virava 3 chunks e o ERRO_CHUNK2 (no fim) caía
 * no chunk 3, mas o mock só alimenta a sugestão dele pro chunk 2. 1.5× garante 2
 * chunks em qualquer threshold (chunk1 ~T com ERRO_CHUNK1; chunk2 ~0.5T com ERRO_CHUNK2).
 */
function makeLongText(minLength = Math.ceil(CLARICE_CHUNK_THRESHOLD * 1.5)): string {
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
    // #2701 item 4 do self-review #2700: este teste checava só call-count/chunkCount,
    // não o output merged — uma regressão que chunka mas descarta o merge do chunk 2
    // passaria aqui. Espelha as assertions de conteúdo do teste equivalente de
    // `withClariceRetryChunked` (linha ~510) pra tornar essa regressão observável
    // diretamente no corpo deste teste (não só no teste de merge separado).
    assert.ok(
      result.correctedText.includes("CORRIGIDO_CHUNK1"),
      "sugestão do chunk 1 deve estar aplicada no correctedText",
    );
    assert.ok(
      result.correctedText.includes("CORRIGIDO_CHUNK2"),
      "sugestão do chunk 2 deve estar aplicada no correctedText",
    );
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
// #2626 (regressão) — o caminho de fallback DEVE consumir --corrected-out.
// Re-aplicar a lista plana --out (rawSuggestions) ao texto INTEIRO via
// clarice-apply.ts sub-corrige textos multi-chunk: uma âncora única dentro de
// um chunk pode aparecer 2+× no texto completo e é pulada como "ambígua".
// Este teste fixa o motivo do fix nos playbooks (orchestrator + SKILL).
// ---------------------------------------------------------------------------

describe("correctTextChunked (#2626) — corrected-out vs re-aplicar --out (regressão)", () => {
  /**
   * Texto > threshold com a MESMA âncora "ZEBRA" aparecendo 1× em cada chunk
   * (1× perto do início, 1× perto do fim) — única dentro do chunk, mas 2× no
   * texto inteiro. `to: "GIRAFA"` não contém a âncora (evita match parcial).
   */
  function makeMultiChunkTextWithRepeatedAnchor(): string {
    const filler = "Conteudo de preenchimento sem ancora para empurrar o tamanho do chunk. ".repeat(8).trimEnd() + "\n\n";
    let text = "Paragrafo inicial contendo ZEBRA como ancora.\n\n";
    while (text.length < CLARICE_CHUNK_THRESHOLD + 2_000) text += filler;
    text += "Paragrafo final contendo ZEBRA novamente como ancora.\n\n";
    return text;
  }

  it("corrected-out (chunk-local) corrige a âncora repetida; re-aplicar --out ao texto inteiro NÃO corrige (ambígua)", async () => {
    const text = makeMultiChunkTextWithRepeatedAnchor();
    assert.ok(text.length > CLARICE_CHUNK_THRESHOLD, "fixture deve exceder o threshold");
    assert.equal(countOccurrences(text, "ZEBRA"), 2, "âncora deve aparecer 2× no texto inteiro (1× por chunk)");

    // Mock content-aware: cada chunk que contém ZEBRA recebe a mesma sugestão
    // (espelha o Clarice vendo cada chunk isoladamente) — robusto a chunkCount.
    let callCount = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      callCount++;
      const bodyStr = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyStr) as { paragraphs: Array<{ description: string }> };
      const chunkText = parsed.paragraphs[0].description;
      const resp = chunkText.includes("ZEBRA") ? [{ from: "ZEBRA", to: "GIRAFA" }] : [];
      return new Response(JSON.stringify(resp), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const result = await correctTextChunked({ apiKey: "k", text, fetchImpl });

    assert.ok(result.chunkCount >= 2, `deve dividir em ≥2 chunks; foi ${result.chunkCount}`);
    assert.ok(callCount >= 2, `deve fazer ≥2 requests REST; fez ${callCount}`);
    // 1 sugestão por chunk com âncora → 2 sugestões idênticas acumuladas em --out
    assert.equal(result.rawSuggestions.length, 2, "rawSuggestions deve ter 1 sugestão por chunk (2 no total)");

    // correctedText (--corrected-out) aplica AMBAS as ocorrências chunk-localmente
    assert.equal(countOccurrences(result.correctedText, "GIRAFA"), 2, "corrected-out corrige ambas as ocorrências");
    assert.equal(countOccurrences(result.correctedText, "ZEBRA"), 0, "corrected-out não deixa âncora crua");

    // Re-aplicar a lista plana --out ao texto INTEIRO (o que o passo 3 fazia ANTES do fix #2626):
    const reapply = applyClariceSuggestions(text, result.rawSuggestions);
    assert.ok(
      countOccurrences(reapply.patched, "ZEBRA") > 0,
      "re-aplicar --out ao texto inteiro deixa âncora não corrigida (sub-correção)",
    );
    assert.ok(
      reapply.skipped.some((s) => s.reason === "ambiguous"),
      "clarice-apply.ts pula a âncora como ambígua no texto inteiro",
    );

    // A divergência é o motivo do fix: o fallback DEVE consumir corrected-out.
    assert.notEqual(
      result.correctedText,
      reapply.patched,
      "corrected-out (chunk-local) deve divergir de re-aplicar --out ao texto inteiro",
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

// ---------------------------------------------------------------------------
// #2701 item 1 (self-review #2700) — dispatch de chunks com teto de concorrência
// ---------------------------------------------------------------------------

/** Gera texto com `nSections` seções `SECAO_{i}` separadas por `---`, cada uma
 * grande o bastante para virar 1 chunk próprio sob um `chunkThreshold` moderado. */
function makeManyChunkText(nSections: number): string {
  const filler =
    "Conteudo de preenchimento editorial para forcar o chunking em multiplas secoes distintas. ".repeat(6);
  return Array.from({ length: nSections }, (_, i) => `SECAO_${i}\n${filler}`).join("\n---\n");
}

describe("correctTextChunked (#2701 item 1) — teto de concorrência no dispatch de chunks", () => {
  const CHUNK_THRESHOLD = 700;

  it("nunca excede o teto de concorrência em requests simultâneas", async () => {
    const text = makeManyChunkText(8);
    const concurrency = 2;
    let inFlight = 0;
    let peakInFlight = 0;

    const fetchImpl: typeof fetch = async () => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const result = await correctTextChunked({ apiKey: "k", text, fetchImpl }, CHUNK_THRESHOLD, concurrency);

    assert.ok(
      result.chunkCount >= 4,
      `fixture deve gerar ≥4 chunks pro teste do teto ser significativo; gerou ${result.chunkCount}`,
    );
    assert.ok(
      peakInFlight <= concurrency,
      `peak de requests simultâneas (${peakInFlight}) excedeu o teto de concorrência (${concurrency})`,
    );
    assert.equal(
      peakInFlight,
      Math.min(concurrency, result.chunkCount),
      `com chunkCount ≥ concurrency, o teto deve ser efetivamente atingido (peak observado=${peakInFlight})`,
    );
  });

  it("preserva a ordem dos chunks no correctedText mesmo quando completam fora de ordem", async () => {
    const text = makeManyChunkText(4);
    const chunks = splitIntoChunks(text, CHUNK_THRESHOLD);
    assert.ok(chunks.length >= 3, `fixture deve gerar ≥3 chunks; gerou ${chunks.length}`);

    // Delay inversamente proporcional ao índice do chunk: os ÚLTIMOS chunks
    // respondem PRIMEIRO. Se o merge dependesse da ordem de CONCLUSÃO (ex: um
    // `results.push` ingênuo em vez de escrita indexada por posição), o texto
    // final sairia com as seções fora de ordem.
    const fetchImpl: typeof fetch = async (_url, init) => {
      const bodyStr = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyStr) as { paragraphs?: Array<{ description: string }> };
      const chunkIdx = chunks.findIndex((c) => c.text === parsed.paragraphs?.[0]?.description);
      assert.ok(chunkIdx >= 0, "body do fetch deve corresponder a um chunk conhecido do fixture");
      const delay = (chunks.length - chunkIdx) * 10;
      await new Promise((r) => setTimeout(r, delay));
      return new Response(JSON.stringify([{ from: `SECAO_${chunkIdx}`, to: `MARCADA_${chunkIdx}` }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await correctTextChunked(
      { apiKey: "k", text, fetchImpl },
      CHUNK_THRESHOLD,
      chunks.length, // concorrência total — todos os chunks em voo ao mesmo tempo
    );

    for (let i = 0; i < chunks.length; i++) {
      assert.ok(result.correctedText.includes(`MARCADA_${i}`), `chunk ${i} deve estar corrigido no correctedText`);
    }
    // Reverter as correções deve reproduzir o texto original byte-a-byte — isso só
    // é verdade se cada correção foi aplicada NA POSIÇÃO do seu chunk de origem
    // (ordem de chunk), não na ordem em que os requests retornaram.
    let reconstructed = result.correctedText;
    for (let i = 0; i < chunks.length; i++) {
      reconstructed = reconstructed.replace(`MARCADA_${i}`, `SECAO_${i}`);
    }
    assert.equal(
      reconstructed,
      text,
      "ordem dos chunks no correctedText deve corresponder à ordem original, mesmo com conclusão fora de ordem",
    );
  });

  it("chunk que falha (4xx) propaga o erro mesmo com outros chunks concorrentes bem-sucedidos (fail-clean)", async () => {
    const text = makeManyChunkText(4);
    const chunks = splitIntoChunks(text, CHUNK_THRESHOLD);
    assert.ok(chunks.length >= 3, `fixture deve gerar ≥3 chunks; gerou ${chunks.length}`);

    const fetchImpl: typeof fetch = async (_url, init) => {
      const bodyStr = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyStr) as { paragraphs?: Array<{ description: string }> };
      const chunkIdx = chunks.findIndex((c) => c.text === parsed.paragraphs?.[0]?.description);
      if (chunkIdx === 1) {
        return new Response("forbidden", { status: 403 });
      }
      await new Promise((r) => setTimeout(r, 5));
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    };

    await assert.rejects(
      () => correctTextChunked({ apiKey: "k", text, fetchImpl }, CHUNK_THRESHOLD, chunks.length),
      /HTTP 403/,
      "erro de um chunk deve propagar mesmo com outros chunks em voo bem-sucedidos — sem resultado parcial (fail-clean)",
    );
  });
});

// ---------------------------------------------------------------------------
// #5082 — isFatalHttpError (extraído do is4xx inline de withClariceRetry)
// ---------------------------------------------------------------------------

describe("isFatalHttpError (#5082)", () => {
  it("ClariceHttpError com status 4xx → true", () => {
    assert.equal(isFatalHttpError(new ClariceHttpError(401, "unauthorized")), true);
    assert.equal(isFatalHttpError(new ClariceHttpError(403, "forbidden")), true);
    assert.equal(isFatalHttpError(new ClariceHttpError(499, "x")), true);
  });

  it("ClariceHttpError com status 5xx → false", () => {
    assert.equal(isFatalHttpError(new ClariceHttpError(503, "service unavailable")), false);
    assert.equal(isFatalHttpError(new ClariceHttpError(500, "internal error")), false);
  });

  it("erro genérico com mensagem 'HTTP 4xx' → true (fallback de regex)", () => {
    assert.equal(isFatalHttpError(new Error("HTTP 400: bad request")), true);
  });

  it("erro de rede/timeout (AbortError, sem status) → false", () => {
    assert.equal(isFatalHttpError(new Error("The operation was aborted")), false);
    const abortError = new Error("This operation was aborted");
    abortError.name = "AbortError";
    assert.equal(isFatalHttpError(abortError), false);
  });
});

// ---------------------------------------------------------------------------
// #5082 — correctChunkViaParagraphs: fallback de 2º nível por-parágrafo
// ---------------------------------------------------------------------------

describe("correctChunkViaParagraphs (#5082) — granularidade por-parágrafo", () => {
  it("1 request REST isolado por parágrafo substantivo, separador `---` pulado sem request", () => {
    const chunk: TextChunk = {
      text: "Primeiro paragrafo com ERRO_1.\n\n---\n\nSegundo paragrafo com ERRO_2.",
      startOffset: 0,
    };
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const bodyStr = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyStr) as { paragraphs: Array<{ description: string }> };
      const body = parsed.paragraphs[0].description;
      calls.push(body);
      const resp = body.includes("ERRO_1")
        ? [{ from: "ERRO_1", to: "CORRIGIDO_1" }]
        : body.includes("ERRO_2")
          ? [{ from: "ERRO_2", to: "CORRIGIDO_2" }]
          : [];
      return new Response(JSON.stringify(resp), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    return correctChunkViaParagraphs(chunk, { apiKey: "k", fetchImpl }).then((result) => {
      // 2 parágrafos substantivos (o separador --- não deve gerar request).
      assert.equal(calls.length, 2, `esperado 2 requests (só parágrafos substantivos); feito ${calls.length}`);
      assert.ok(!calls.some((c) => c.trim() === "---"), "separador --- não deve ser enviado ao Clarice");
      assert.equal(result.stats.paragraphsSubstantive, 2);
      assert.equal(result.stats.paragraphsSucceeded, 2);
      assert.equal(result.stats.paragraphsFailed, 0);
      assert.ok(result.correctedText.includes("CORRIGIDO_1"));
      assert.ok(result.correctedText.includes("CORRIGIDO_2"));
      assert.ok(!result.correctedText.includes("ERRO_1"));
      assert.ok(!result.correctedText.includes("ERRO_2"));
      assert.equal(result.rawSuggestions.length, 2);
    });
  });

  it("1 parágrafo falhando isolado NÃO aborta os demais — recupera parte das sugestões", async () => {
    const chunk: TextChunk = {
      text: "Paragrafo A com ERRO_A.\n\nParagrafo B problematico.\n\nParagrafo C com ERRO_C.",
      startOffset: 0,
    };
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const bodyStr = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyStr) as { paragraphs: Array<{ description: string }> };
      const body = parsed.paragraphs[0].description;
      calls.push(body);
      if (body.includes("problematico")) {
        return new Response("service unavailable", { status: 503 });
      }
      const resp = body.includes("ERRO_A")
        ? [{ from: "ERRO_A", to: "CORRIGIDO_A" }]
        : body.includes("ERRO_C")
          ? [{ from: "ERRO_C", to: "CORRIGIDO_C" }]
          : [];
      return new Response(JSON.stringify(resp), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const result = await correctChunkViaParagraphs(chunk, { apiKey: "k", fetchImpl });

    assert.equal(result.stats.paragraphsSubstantive, 3);
    assert.equal(result.stats.paragraphsSucceeded, 2, "2 dos 3 parágrafos devem ter sucesso");
    assert.equal(result.stats.paragraphsFailed, 1, "1 parágrafo deve falhar");
    assert.equal(result.stats.failedParagraphs.length, 1);
    assert.match(result.stats.failedParagraphs[0].errorMessage, /503/);

    // Parágrafos A e C recuperados; B (falho) preservado sem correção — não
    // aborta a corrida inteira por causa de 1 parágrafo problemático.
    assert.ok(result.correctedText.includes("CORRIGIDO_A"));
    assert.ok(result.correctedText.includes("CORRIGIDO_C"));
    assert.ok(result.correctedText.includes("Paragrafo B problematico."), "parágrafo falho preserva texto original");

    // Fail-fast: o parágrafo problemático deve ter sido chamado exatamente 1×
    // (SEM retry) — reintroduzir retry aqui reproduziria o acúmulo de
    // 40-60s+ que a issue #5082 investigou.
    const failedCalls = calls.filter((c) => c.includes("problematico"));
    assert.equal(failedCalls.length, 1, "parágrafo que falha deve ser chamado exatamente 1× (sem retry)");
  });

  it("onAttempt recebe viaParagraphFallback: true em cada tentativa (sucesso e falha)", async () => {
    const chunk: TextChunk = { text: "Paragrafo unico com ERRO_X.", startOffset: 0 };
    const fetchImplOk: typeof fetch = async () =>
      new Response(JSON.stringify([{ from: "ERRO_X", to: "CORRIGIDO_X" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const entriesOk: AttemptLogEntry[] = [];
    await correctChunkViaParagraphs(chunk, {
      apiKey: "k",
      fetchImpl: fetchImplOk,
      onAttempt: (e) => entriesOk.push(e),
    });
    assert.equal(entriesOk.length, 1);
    assert.equal(entriesOk[0].viaParagraphFallback, true);
    assert.equal(entriesOk[0].outcome, "success");
    assert.equal(entriesOk[0].attempt, 1);
    assert.equal(entriesOk[0].maxAttempts, 1, "modo por-parágrafo é sempre 1 tentativa (fail-fast)");

    const fetchImplFail: typeof fetch = async () => new Response("timeout", { status: 504 });
    const entriesFail: AttemptLogEntry[] = [];
    await correctChunkViaParagraphs(chunk, {
      apiKey: "k",
      fetchImpl: fetchImplFail,
      onAttempt: (e) => entriesFail.push(e),
    });
    assert.equal(entriesFail.length, 1);
    assert.equal(entriesFail[0].viaParagraphFallback, true);
    assert.equal(entriesFail[0].outcome, "fatal_failure");
  });

  it("timeoutMs default é PARAGRAPH_FALLBACK_TIMEOUT_MS (20s) quando não especificado", async () => {
    // Não testamos o timeout real disparando (levaria 20s) — só que o valor
    // exportado bate com o documentado, e que passar timeoutMs custom é honrado
    // (request aborta bem antes de 20s se o mock nunca resolve).
    assert.equal(PARAGRAPH_FALLBACK_TIMEOUT_MS, 20_000);

    const chunk: TextChunk = { text: "Paragrafo que nunca responde.", startOffset: 0 };
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = (init as { signal?: AbortSignal })?.signal;
        signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      });

    const start = Date.now();
    const result = await correctChunkViaParagraphs(chunk, { apiKey: "k", fetchImpl, timeoutMs: 50 });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 2_000, `timeoutMs custom (50ms) deve ser honrado, não o default de 20s; elapsed=${elapsed}ms`);
    assert.equal(result.stats.paragraphsFailed, 1);
  });
});

// ---------------------------------------------------------------------------
// #5082 — correctTextViaParagraphs: --granularity paragraph forçado
// ---------------------------------------------------------------------------

describe("correctTextViaParagraphs (#5082) — granularidade forçada, bypass do chunking normal", () => {
  it("texto inteiro tratado como 1 chunk único — 1 request por parágrafo substantivo, sem retry", async () => {
    // Texto pequeno o bastante pra caber em 1 chunk normal (bem abaixo do
    // threshold) — mesmo assim, --granularity paragraph deve dividir em
    // parágrafos em vez de mandar como 1 request só.
    const text = "Abertura da newsletter.\n\nDESTAQUE 1 com ERRO_D1.\n\nDESTAQUE 2 com ERRO_D2.";
    assert.ok(text.length < CLARICE_CHUNK_THRESHOLD, "fixture deve caber em 1 chunk normal");

    let callCount = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      callCount++;
      const bodyStr = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyStr) as { paragraphs: Array<{ description: string }> };
      const body = parsed.paragraphs[0].description;
      const resp = body.includes("ERRO_D1")
        ? [{ from: "ERRO_D1", to: "CORRIGIDO_D1" }]
        : body.includes("ERRO_D2")
          ? [{ from: "ERRO_D2", to: "CORRIGIDO_D2" }]
          : [];
      return new Response(JSON.stringify(resp), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const result = await correctTextViaParagraphs({ apiKey: "k", text, fetchImpl });

    assert.equal(callCount, 3, "3 parágrafos substantivos (abertura + 2 destaques) → 3 requests isolados");
    assert.equal(result.stats.paragraphsSubstantive, 3);
    assert.ok(result.correctedText.includes("CORRIGIDO_D1"));
    assert.ok(result.correctedText.includes("CORRIGIDO_D2"));
    assert.equal(result.correctedText.length - text.length, "CORRIGIDO_D1".length - "ERRO_D1".length + "CORRIGIDO_D2".length - "ERRO_D2".length);
  });

  it("falha em 1 dos N parágrafos não impede sucesso dos outros (sem retry em nenhum)", async () => {
    const text = "Paragrafo 1 OK.\n\nParagrafo 2 falha.\n\nParagrafo 3 OK.";
    let callCount = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      callCount++;
      const bodyStr = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyStr) as { paragraphs: Array<{ description: string }> };
      if (parsed.paragraphs[0].description.includes("falha")) {
        throw new Error("fetch failed");
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const result = await correctTextViaParagraphs({ apiKey: "k", text, fetchImpl });

    assert.equal(callCount, 3, "3 parágrafos → 3 requests, cada 1× (sem retry mesmo no que falha)");
    assert.equal(result.stats.paragraphsSucceeded, 2);
    assert.equal(result.stats.paragraphsFailed, 1);
  });
});

// ---------------------------------------------------------------------------
// #5082 — withClariceRetryChunked: fallback automático de 2º nível
// ---------------------------------------------------------------------------

describe("withClariceRetryChunked (#5082) — fallback automático de 2º nível por-parágrafo", () => {
  const noSleep = async (_ms: number): Promise<void> => {};
  const fastPolicy: RetryPolicy = {
    maxAttempts: 2,
    timeoutMs: 5_000,
    baseBackoffMs: 0,
  };

  it("chunk esgota os retries normais → cai no fallback por-parágrafo e recupera as sugestões", async () => {
    const fullText = "Paragrafo A com ERRO_A.\n\nParagrafo B com ERRO_B.";
    let chunkLevelCalls = 0;
    const paragraphCalls: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const bodyStr = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyStr) as { paragraphs: Array<{ description: string }> };
      const body = parsed.paragraphs[0].description;
      if (body === fullText) {
        chunkLevelCalls++;
        return new Response("service unavailable", { status: 503 });
      }
      paragraphCalls.push(body);
      const resp = body.includes("ERRO_A")
        ? [{ from: "ERRO_A", to: "CORRIGIDO_A" }]
        : body.includes("ERRO_B")
          ? [{ from: "ERRO_B", to: "CORRIGIDO_B" }]
          : [];
      return new Response(JSON.stringify(resp), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const result = await withClariceRetryChunked({ apiKey: "k", text: fullText, fetchImpl }, fastPolicy, noSleep);

    assert.equal(chunkLevelCalls, fastPolicy.maxAttempts, "chunk normal deve esgotar maxAttempts antes de cair no fallback");
    assert.equal(paragraphCalls.length, 2, "fallback deve fazer 1 request isolado por parágrafo substantivo");
    assert.equal(result.usedParagraphFallbackChunks, 1, "1 chunk deve ter usado o fallback");
    assert.equal(result.paragraphFallbackStats.length, 1);
    assert.equal(result.paragraphFallbackStats[0].paragraphsSucceeded, 2);
    assert.equal(result.paragraphFallbackStats[0].paragraphsFailed, 0);
    assert.ok(result.correctedText.includes("CORRIGIDO_A"), "sugestão do parágrafo A recuperada via fallback");
    assert.ok(result.correctedText.includes("CORRIGIDO_B"), "sugestão do parágrafo B recuperada via fallback");
  });

  it("1 parágrafo falhando no fallback não aborta a pipeline — recupera parte, chunk retorna sucesso parcial", async () => {
    const fullText = "Paragrafo A com ERRO_A.\n\nParagrafo B problematico.";
    const paragraphCalls: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const bodyStr = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyStr) as { paragraphs: Array<{ description: string }> };
      const body = parsed.paragraphs[0].description;
      if (body === fullText) {
        return new Response("service unavailable", { status: 503 }); // chunk-level sempre falha
      }
      paragraphCalls.push(body);
      if (body.includes("problematico")) {
        return new Response("service unavailable", { status: 503 }); // paragrafo B falha (fail-fast, sem retry)
      }
      return new Response(JSON.stringify([{ from: "ERRO_A", to: "CORRIGIDO_A" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await withClariceRetryChunked({ apiKey: "k", text: fullText, fetchImpl }, fastPolicy, noSleep);

    assert.equal(result.usedParagraphFallbackChunks, 1);
    assert.equal(result.paragraphFallbackStats[0].paragraphsSucceeded, 1);
    assert.equal(result.paragraphFallbackStats[0].paragraphsFailed, 1);
    assert.ok(result.correctedText.includes("CORRIGIDO_A"), "parágrafo A recuperado");
    assert.ok(result.correctedText.includes("Paragrafo B problematico."), "parágrafo B (falho) preserva texto original");
    // Cada request de parágrafo — inclusive o que falha — deve ter sido feito
    // exatamente 1× (fail-fast, sem retry dentro do fallback).
    assert.equal(paragraphCalls.filter((c) => c.includes("problematico")).length, 1);
    assert.equal(paragraphCalls.filter((c) => c.includes("ERRO_A")).length, 1);
  });

  it("fallback também falha 100% → propaga o erro ORIGINAL do chunk (fail-clean preservado)", async () => {
    const fullText = "Paragrafo A problematico.\n\nParagrafo B problematico.";
    const fetchImpl: typeof fetch = async () => new Response("service unavailable", { status: 503 });

    await assert.rejects(
      () => withClariceRetryChunked({ apiKey: "k", text: fullText, fetchImpl }, fastPolicy, noSleep),
      (err: unknown) => {
        assert.ok(err instanceof ClariceHttpError, `erro propagado deve ser o ClariceHttpError original do chunk, got ${(err as Error)?.constructor?.name}`);
        assert.equal((err as ClariceHttpError).status, 503);
        return true;
      },
    );
  });

  it("erro fatal (4xx) NÃO aciona o fallback — propaga imediatamente sem tentar parágrafos", async () => {
    const fullText = "Paragrafo A.\n\nParagrafo B.";
    let chunkLevelCalls = 0;
    const paragraphCalls: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const bodyStr = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyStr) as { paragraphs: Array<{ description: string }> };
      const body = parsed.paragraphs[0].description;
      if (body === fullText) {
        chunkLevelCalls++;
        return new Response("unauthorized", { status: 401 });
      }
      paragraphCalls.push(body);
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    };

    await assert.rejects(
      () => withClariceRetryChunked({ apiKey: "k", text: fullText, fetchImpl }, fastPolicy, noSleep),
      ClariceHttpError,
    );

    assert.equal(chunkLevelCalls, 1, "401 é fast-fail — não deve esgotar maxAttempts");
    assert.equal(paragraphCalls.length, 0, "fallback NÃO deve ser tentado pra erro fatal (4xx) — repetiria o mesmo erro em cada parágrafo");
  });

  it("paragraphFallback: { enabled: false } desliga o fallback — preserva fail-clean estrito original", async () => {
    const fullText = "Paragrafo A com ERRO_A.\n\nParagrafo B com ERRO_B.";
    const paragraphCalls: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const bodyStr = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyStr) as { paragraphs: Array<{ description: string }> };
      const body = parsed.paragraphs[0].description;
      if (body === fullText) {
        return new Response("service unavailable", { status: 503 });
      }
      paragraphCalls.push(body);
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    };

    await assert.rejects(
      () =>
        withClariceRetryChunked(
          { apiKey: "k", text: fullText, fetchImpl },
          fastPolicy,
          noSleep,
          undefined,
          undefined,
          { enabled: false },
        ),
      ClariceHttpError,
    );

    assert.equal(paragraphCalls.length, 0, "fallback desligado — nenhum request de parágrafo deve ser feito");
  });

  it("offsets remapeados corretamente: chunk 2 (com startOffset != 0) usa fallback e a correção aparece na posição certa do documento inteiro", async () => {
    // Documento com 2 seções separadas por --- forçadas em chunks distintos
    // via um threshold baixo. A seção 2 (chunk com startOffset != 0) esgota
    // os retries normais e cai no fallback — a correção resultante precisa
    // aparecer NA POSIÇÃO CORRETA do documento reconstruído (chunk 1 intacto
    // + chunk 2 corrigido via parágrafo), não deslocada nem duplicada.
    const CHUNK_THRESHOLD = 60;
    const section1 = "Secao 1 sem erros e sem necessidade de fallback aqui.";
    // section2 tem 2 parágrafos (separados por \n\n) DE PROPÓSITO — se fosse 1
    // parágrafo só, o texto do parágrafo seria idêntico ao texto do chunk
    // inteiro, e o mock não conseguiria distinguir "tentativa normal do chunk"
    // de "tentativa do fallback por-parágrafo" (mesmo body).
    const section2 = "Intro da secao 2 sem erro.\n\nParagrafo com ERRO_SECAO2 na segunda secao do documento.";
    const fullText = `${section1}\n---\n${section2}`;

    const chunks = splitIntoChunks(fullText, CHUNK_THRESHOLD);
    assert.ok(chunks.length >= 2, `fixture deve gerar ≥2 chunks; gerou ${chunks.length}`);
    const chunk2 = chunks.find((c) => c.text.includes("ERRO_SECAO2"))!;
    assert.ok(chunk2, "deve existir um chunk contendo ERRO_SECAO2");
    assert.notEqual(chunk2.startOffset, 0, "fixture deve testar um chunk com startOffset != 0 (não o primeiro)");

    const fetchImpl: typeof fetch = async (_url, init) => {
      const bodyStr = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyStr) as { paragraphs: Array<{ description: string }> };
      const body = parsed.paragraphs[0].description;
      // Chunk inteiro contendo ERRO_SECAO2 falha sempre (aciona o fallback);
      // qualquer request MENOR que o chunk 2 completo é o REST por-parágrafo.
      if (body === chunk2.text) {
        return new Response("service unavailable", { status: 503 });
      }
      if (body.includes("ERRO_SECAO2")) {
        return new Response(JSON.stringify([{ from: "ERRO_SECAO2", to: "CORRIGIDO_SECAO2" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const result = await withClariceRetryChunked(
      { apiKey: "k", text: fullText, fetchImpl },
      fastPolicy,
      noSleep,
      CHUNK_THRESHOLD,
      1, // concorrência serial — determinístico
    );

    assert.equal(result.usedParagraphFallbackChunks, 1);
    assert.ok(result.correctedText.includes("CORRIGIDO_SECAO2"), "correção do fallback deve estar presente");
    assert.ok(!result.correctedText.includes("ERRO_SECAO2"), "âncora original não deve sobrar");
    assert.ok(result.correctedText.includes(section1), "seção 1 (chunk sem fallback) deve estar intacta");
    // Posição relativa preservada: a seção 1 continua vindo ANTES da seção 2
    // corrigida no documento reconstruído (prova que a correção do fallback
    // foi remapeada de volta pro lugar certo do chunk 2, não pro início/fim
    // do documento nem duplicada).
    const idxSection1 = result.correctedText.indexOf(section1);
    const idxCorrection = result.correctedText.indexOf("CORRIGIDO_SECAO2");
    assert.ok(idxSection1 >= 0 && idxCorrection > idxSection1, "seção 1 deve vir antes da correção da seção 2 no texto final");
    // Comprimento total bate com o esperado (1 substituição de tamanho conhecido).
    const expectedLengthDiff = "CORRIGIDO_SECAO2".length - "ERRO_SECAO2".length;
    assert.equal(result.correctedText.length, fullText.length + expectedLengthDiff);
  });
});

// ---------------------------------------------------------------------------
// #5082 — correctTextChunked (caminho sem --retry): mesmo fallback disponível
// ---------------------------------------------------------------------------

describe("correctTextChunked (#5082) — fallback por-parágrafo também no caminho sem retry", () => {
  it("1 tentativa do chunk falha (não-4xx) → cai no fallback por-parágrafo", async () => {
    // 2 parágrafos DE PROPÓSITO — com 1 parágrafo só, o body da tentativa de
    // fallback seria idêntico ao body da tentativa normal do chunk (mesmo
    // texto), e o mock não conseguiria distinguir as duas.
    const fullText = "Abertura sem erro.\n\nParagrafo com ERRO_UNICO.";
    let chunkCalls = 0;
    const paragraphCalls: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const bodyStr = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyStr) as { paragraphs: Array<{ description: string }> };
      const body = parsed.paragraphs[0].description;
      if (body === fullText) {
        chunkCalls++;
        return new Response("service unavailable", { status: 503 });
      }
      paragraphCalls.push(body);
      const resp = body.includes("ERRO_UNICO") ? [{ from: "ERRO_UNICO", to: "CORRIGIDO_UNICO" }] : [];
      return new Response(JSON.stringify(resp), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const result = await correctTextChunked({ apiKey: "k", text: fullText, fetchImpl });

    assert.equal(chunkCalls, 1, "caminho sem --retry faz só 1 tentativa no nível de chunk");
    assert.equal(paragraphCalls.length, 2, "fallback deve mandar 1 request por parágrafo substantivo (2 no total)");
    assert.ok(result.correctedText.includes("CORRIGIDO_UNICO"));
  });

  it("paragraphFallback: { enabled: false } preserva o comportamento legado (fail-clean sem fallback)", async () => {
    const fullText = "Paragrafo unico com ERRO_UNICO.";
    const fetchImpl: typeof fetch = async () => new Response("service unavailable", { status: 503 });

    await assert.rejects(
      () => correctTextChunked({ apiKey: "k", text: fullText, fetchImpl }, undefined, undefined, { enabled: false }),
      /HTTP 503/,
    );
  });
});
