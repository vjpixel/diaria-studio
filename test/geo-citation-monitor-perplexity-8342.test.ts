/**
 * test/geo-citation-monitor-perplexity-8342.test.ts (#8342)
 *
 * Perplexity como 4º provedor do monitor GEO. Tudo com `fetchImpl` mockado —
 * NUNCA chamada de rede real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  GEO_PROVIDERS,
  GEO_QUESTIONS,
  buildUsageRecordFields,
  classifyPaymentStatusErrorKind,
  deriveEffectiveErrorKind,
  queryProvider,
  runGeoCitationMonitor,
} from "../scripts/lib/geo-citation-monitor.ts";

const perplexity = GEO_PROVIDERS.find((p) => p.id === "perplexity")!;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const OK_BODY = {
  choices: [{ message: { content: "A Perplexity lançou um agente [1]." }, finish_reason: "stop" }],
  citations: ["https://diar.ia.br/p/perplexity-agente", "https://example.com/x"],
  search_results: [{ title: "t", url: "https://diar.ia.br/p/perplexity-agente" }],
  usage: { prompt_tokens: 20, completion_tokens: 300, total_tokens: 320 },
};

describe("provider perplexity (#8342)", () => {
  it("está registrado como 4º provider, com envKey PERPLEXITY_API_KEY e model sonar", () => {
    assert.equal(GEO_PROVIDERS.length, 4);
    assert.equal(perplexity.envKey, "PERPLEXITY_API_KEY");
    assert.equal(perplexity.defaultModel, "sonar");
  });

  it("buildRequest: POST chat/completions com Bearer, model, pergunta e contexto low", () => {
    const { url, init } = perplexity.buildRequest("pergunta?", "pk-test", "sonar");
    assert.equal(url, "https://api.perplexity.ai/chat/completions");
    assert.equal(init.method, "POST");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer pk-test");
    const body = JSON.parse(init.body as string);
    assert.equal(body.model, "sonar");
    assert.deepEqual(body.messages, [{ role: "user", content: "pergunta?" }]);
    assert.equal(body.web_search_options.search_context_size, "low");
  });

  it("extractText inclui content + citations + search_results (fonte fora do texto conta)", () => {
    const text = perplexity.extractText(OK_BODY);
    assert.ok(text.includes("agente [1]"));
    assert.ok(text.includes("https://diar.ia.br/p/perplexity-agente"));
  });

  it("extractText é defensivo com forma inesperada", () => {
    assert.equal(perplexity.extractText({}), "");
    assert.equal(perplexity.extractText(null), "");
    assert.equal(perplexity.extractText({ choices: "x", citations: 3 }), "");
  });

  it("extractUsage lê prompt/completion tokens; sem usage devolve undefined", () => {
    assert.deepEqual(perplexity.extractUsage!(OK_BODY), { inputTokens: 20, outputTokens: 300 });
    assert.equal(perplexity.extractUsage!({}), undefined);
  });

  it("checkProviderError: finish_reason length vira erro; stop é OK", () => {
    assert.match(perplexity.checkProviderError!({ choices: [{ finish_reason: "length" }] })!, /length/);
    assert.equal(perplexity.checkProviderError!(OK_BODY), undefined);
    assert.equal(perplexity.checkProviderError!({}), undefined);
  });

  it("custo estimado inclui a taxa por requisição de US$0,005", () => {
    const f = buildUsageRecordFields("perplexity", { inputTokens: 1000, outputTokens: 1000 }, "sonar", "2026-09-20T00:00:00Z");
    assert.ok(Math.abs(f.estimatedCostUsd! - (0.001 + 0.001 + 0.005)) < 1e-9);
  });
});

describe("queryProvider com perplexity (#8342)", () => {
  it("resposta que cita diar.ia.br: ok e texto detectável", async () => {
    const r = await queryProvider(perplexity, "q", "k", "sonar", async () => jsonResponse(OK_BODY));
    assert.equal(r.ok, true);
    if (r.ok) assert.ok(r.text.includes("diar.ia.br"));
  });

  it("resposta sem o domínio: ok, texto sem diar.ia.br", async () => {
    const body = { ...OK_BODY, citations: ["https://example.com"], search_results: [] };
    const r = await queryProvider(perplexity, "q", "k", "sonar", async () => jsonResponse(body));
    assert.equal(r.ok, true);
    if (r.ok) assert.ok(!r.text.includes("diar.ia.br"));
  });

  it("HTTP 500: errorKind http com status", async () => {
    const r = await queryProvider(perplexity, "q", "k", "sonar", async () => new Response("boom", { status: 500 }));
    assert.deepEqual(r.ok, false);
    if (!r.ok) {
      assert.equal(r.errorKind, "http");
      assert.equal(r.httpStatus, 500);
    }
  });

  it("HTTP 402 (crédito esgotado) vira errorKind quota, não http genérico", async () => {
    const r = await queryProvider(
      perplexity, "q", "k", "sonar",
      async () => new Response(JSON.stringify({ error: { message: "Insufficient credits" } }), { status: 402 }),
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errorKind, "quota");
  });

  it("HTTP 401 de key inválida continua http; 401 com mensagem de crédito é quota", async () => {
    const bad = await queryProvider(perplexity, "q", "k", "sonar", async () => new Response("Unauthorized", { status: 401 }));
    if (!bad.ok) assert.equal(bad.errorKind, "http");
    const credit = await queryProvider(perplexity, "q", "k", "sonar", async () => new Response("Insufficient credits", { status: 401 }));
    if (!credit.ok) assert.equal(credit.errorKind, "quota");
  });

  it("HTTP 429 rate limit comum continua http (transitório)", async () => {
    const r = await queryProvider(perplexity, "q", "k", "sonar", async () => new Response("Too many requests", { status: 429 }));
    if (!r.ok) assert.equal(r.errorKind, "http");
  });
});

describe("classifyPaymentStatusErrorKind / deriveEffectiveErrorKind (#8342)", () => {
  it("402 sempre quota; 500 nunca", () => {
    assert.equal(classifyPaymentStatusErrorKind(402, ""), "quota");
    assert.equal(classifyPaymentStatusErrorKind(500, "credit"), "http");
  });
  it("reclassifica registro histórico 402 gravado como http", () => {
    assert.equal(deriveEffectiveErrorKind({ errorKind: "http", httpStatus: 402, error: "HTTP 402: x" }), "quota");
  });
});

describe("runGeoCitationMonitor com perplexity (#8342)", () => {
  const questions = GEO_QUESTIONS.slice(0, 2);

  it("sem PERPLEXITY_API_KEY: provider pulado em silêncio (fail-soft), sem chamada nem erro", async () => {
    const urls: string[] = [];
    const records = await runGeoCitationMonitor(
      { OPENAI_API_KEY: "" } as NodeJS.ProcessEnv,
      questions,
      async (u) => { urls.push(String(u)); return jsonResponse(OK_BODY); },
    );
    assert.equal(records.length, 0);
    assert.equal(urls.length, 0);
  });

  it("com a key: 1 registro por pergunta, provider/model gravados, citação detectada", async () => {
    const records = await runGeoCitationMonitor(
      { PERPLEXITY_API_KEY: "pk" } as NodeJS.ProcessEnv,
      questions,
      async () => jsonResponse(OK_BODY),
      () => new Date("2026-09-20T12:00:00Z"),
      undefined,
      async () => {},
    );
    assert.equal(records.length, 2);
    for (const r of records) {
      assert.equal(r.provider, "perplexity");
      assert.equal(r.model, "sonar");
      assert.equal(r.cited, true);
      assert.equal(r.error, undefined);
    }
  });
});
