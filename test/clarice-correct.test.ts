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
import { CLARICE_CHUNK_THRESHOLD, splitIntoChunks } from "../scripts/lib/clarice-chunk.ts";
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
