/**
 * test/geo-citation-monitor-perplexity-8342.test.ts (#8342, migrado pra Agent
 * API no #8612)
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
  expectedAlarmProviderIds,
} from "../scripts/lib/geo-citation-monitor.ts";
import { computeMissingProviders } from "../scripts/lib/geo-citation-staleness-alarm.ts";

const perplexity = GEO_PROVIDERS.find((p) => p.id === "perplexity")!;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const OK_BODY = {
  id: "resp_1",
  object: "response",
  status: "completed",
  model: "fast",
  output: [
    {
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "A Perplexity lançou um agente [1].",
          annotations: [{ type: "url_citation", url: "https://example.com/x", title: "x" }],
        },
      ],
    },
    {
      type: "search_results",
      results: [{ url: "https://diar.ia.br/p/perplexity-agente", title: "t" }],
    },
  ],
  usage: { input_tokens: 20, output_tokens: 300, total_tokens: 320 },
};

describe("provider perplexity (#8342/#8612)", () => {
  it("está registrado como 4º provider, com envKey PERPLEXITY_API_KEY e preset fast", () => {
    assert.equal(GEO_PROVIDERS.length, 4);
    assert.equal(perplexity.envKey, "PERPLEXITY_API_KEY");
    assert.equal(perplexity.defaultModel, "fast");
  });

  it("buildRequest: POST /v1/agent com Bearer, preset e input", () => {
    const { url, init } = perplexity.buildRequest("pergunta?", "pk-test", "fast");
    assert.equal(url, "https://api.perplexity.ai/v1/agent");
    assert.equal(init.method, "POST");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer pk-test");
    const body = JSON.parse(init.body as string);
    assert.equal(body.preset, "fast");
    assert.equal(body.input, "pergunta?");
  });

  it("extractText inclui output_text + annotations + search_results (fonte fora do texto conta)", () => {
    const text = perplexity.extractText(OK_BODY);
    assert.ok(text.includes("agente [1]"));
    assert.ok(text.includes("https://diar.ia.br/p/perplexity-agente"));
    assert.ok(text.includes("https://example.com/x"));
  });

  it("extractText é defensivo com forma inesperada", () => {
    assert.equal(perplexity.extractText({}), "");
    assert.equal(perplexity.extractText(null), "");
    assert.equal(perplexity.extractText({ output: "x" }), "");
  });

  it("extractUsage lê input/output tokens; sem usage devolve undefined", () => {
    assert.deepEqual(perplexity.extractUsage!(OK_BODY), { inputTokens: 20, outputTokens: 300 });
    assert.equal(perplexity.extractUsage!({}), undefined);
  });

  it("checkProviderError: status diferente de completed vira erro; completed é OK", () => {
    assert.match(perplexity.checkProviderError!({ status: "incomplete" })!, /incomplete/);
    assert.match(
      perplexity.checkProviderError!({ status: "failed", error: { message: "boom" } })!,
      /boom/,
    );
    assert.equal(perplexity.checkProviderError!(OK_BODY), undefined);
    assert.equal(perplexity.checkProviderError!({}), undefined);
  });

  it("custo estimado inclui a taxa por requisição de US$0,005", () => {
    const f = buildUsageRecordFields("perplexity", { inputTokens: 1000, outputTokens: 1000 }, "fast", "2026-09-28T00:00:00Z");
    assert.ok(Math.abs(f.estimatedCostUsd! - (0.001 + 0.001 + 0.005)) < 1e-9);
  });
});

describe("queryProvider com perplexity (#8342/#8612)", () => {
  it("resposta que cita diar.ia.br: ok e texto detectável", async () => {
    const r = await queryProvider(perplexity, "q", "k", "fast", async () => jsonResponse(OK_BODY));
    assert.equal(r.ok, true);
    if (r.ok) assert.ok(r.text.includes("diar.ia.br"));
  });

  it("resposta sem o domínio: ok, texto sem diar.ia.br", async () => {
    const body = {
      ...OK_BODY,
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "sem fonte." }] },
        { type: "search_results", results: [{ url: "https://example.com" }] },
      ],
    };
    const r = await queryProvider(perplexity, "q", "k", "fast", async () => jsonResponse(body));
    assert.equal(r.ok, true);
    if (r.ok) assert.ok(!r.text.includes("diar.ia.br"));
  });

  it("HTTP 500: errorKind http com status", async () => {
    const r = await queryProvider(perplexity, "q", "k", "fast", async () => new Response("boom", { status: 500 }));
    assert.deepEqual(r.ok, false);
    if (!r.ok) {
      assert.equal(r.errorKind, "http");
      assert.equal(r.httpStatus, 500);
    }
  });

  it("HTTP 402 (crédito esgotado) vira errorKind quota, não http genérico", async () => {
    const r = await queryProvider(
      perplexity, "q", "k", "fast",
      async () => new Response(JSON.stringify({ error: { message: "Insufficient credits" } }), { status: 402 }),
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errorKind, "quota");
  });

  it("HTTP 401 de key inválida continua http; 401 com mensagem de crédito é quota", async () => {
    const bad = await queryProvider(perplexity, "q", "k", "fast", async () => new Response("Unauthorized", { status: 401 }));
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.errorKind, "http");
    const credit = await queryProvider(perplexity, "q", "k", "fast", async () => new Response("Insufficient credits", { status: 401 }));
    assert.equal(credit.ok, false);
    if (!credit.ok) assert.equal(credit.errorKind, "quota");
  });

  it("HTTP 429 rate limit comum continua http (transitório)", async () => {
    const r = await queryProvider(perplexity, "q", "k", "fast", async () => new Response("Too many requests", { status: 429 }));
    if (!r.ok) assert.equal(r.errorKind, "http");
  });

  it("HTTP 403 do endpoint antigo (Sonar Chat Completions desligado) — não é este endpoint, mas documentando o sintoma que motivou a migração (#8612): continua http, não quota", async () => {
    const r = await queryProvider(
      perplexity, "q", "k", "fast",
      async () => new Response("Sonar is now the Agent API. Use /v1/responses instead of /chat/completions", { status: 403 }),
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errorKind, "http");
  });
});

describe("classifyPaymentStatusErrorKind / deriveEffectiveErrorKind (#8342)", () => {
  it("402 sempre quota; 500 nunca", () => {
    assert.equal(classifyPaymentStatusErrorKind(402, ""), "quota");
    assert.equal(classifyPaymentStatusErrorKind(500, "credit"), "http");
  });
  it("reclassifica registro histórico 402 gravado como http", () => {
    assert.equal(deriveEffectiveErrorKind({ provider: "perplexity", errorKind: "http", httpStatus: 402, error: "HTTP 402: x" }), "quota");
    assert.equal(deriveEffectiveErrorKind({ provider: "openai", errorKind: "http", httpStatus: 402, error: "HTTP 402: x" }), "http");
  });
});

describe("alarme de provider ausente (#5316) x perplexity opcional (#8342)", () => {
  it("conjunto esperado exclui perplexity e mantém os 3 originais (derivado de GEO_PROVIDERS)", () => {
    const expected = expectedAlarmProviderIds(GEO_PROVIDERS);
    assert.ok(!expected.includes("perplexity"));
    for (const p of GEO_PROVIDERS.filter((x) => !x.optional)) assert.ok(expected.includes(p.id));
  });
  it("rodada sem perplexity não gera provider ausente", () => {
    const round = ["anthropic", "openai", "google"];
    assert.deepEqual(computeMissingProviders(round, expectedAlarmProviderIds(GEO_PROVIDERS)), []);
  });
});

describe("custo sem usage (#8342)", () => {
  it("fast sem usage ainda emite a taxa por requisição", () => {
    const f = buildUsageRecordFields("perplexity", undefined, "fast", "2026-09-28T00:00:00Z");
    assert.ok(Math.abs(f.estimatedCostUsd! - 0.005) < 1e-9);
    assert.deepEqual(buildUsageRecordFields("openai", undefined, "gpt-5-mini", "2026-09-28T00:00:00Z"), {});
  });
});

describe("runGeoCitationMonitor com perplexity (#8342/#8612)", () => {
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
      () => new Date("2026-09-28T12:00:00Z"),
      undefined,
      async () => {},
    );
    assert.equal(records.length, 2);
    for (const r of records) {
      assert.equal(r.provider, "perplexity");
      assert.equal(r.model, "fast");
      assert.equal(r.cited, true);
      assert.equal(r.error, undefined);
    }
  });
});
