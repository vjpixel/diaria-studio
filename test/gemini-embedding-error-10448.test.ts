/**
 * #10448 — 100% dos embeddings gemini-embedding-001 falharam de 260930 a
 * 261019 e o aviso do gate só dizia "causa não confirmada". Causa real,
 * medida ao vivo em 18/10/2026: `402 RESOURCE_EXHAUSTED — prepayment credits
 * are depleted` (billing da conta). `embedText` engolia a resposta, então nem
 * o sidecar nem o run-log tinham o status HTTP.
 *
 * Regressão: o status/mensagem reais precisam chegar ao sidecar
 * (`first_error`/`errors_by_status`), ao aviso do validator e ao relatório do
 * stage-1-run — e a chave nunca pode vazar pra nenhum deles.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  classifyEmbeddingError,
  describeEmbeddingError,
  embeddingCauseSentence,
  normalizeEmbeddingErrorMessage,
  redactGeminiKey,
} from "../scripts/lib/gemini-embedding-error.ts";
import {
  aggregateEmbeddingStats,
  clusterArticlesWithEmbeddings,
  embedTextDetailed,
  type Article,
} from "../scripts/topic-cluster.ts";
import { validateEmbeddingHealth } from "../scripts/lib/stage-1-validator.ts";
import { stage1ValidatorWarningLines } from "../scripts/stage-1-run.ts";

const FAKE_KEY = "AIzaFAKEKEY-10448_abc";
// Corpo real devolvido pela API em 18/10/2026.
const BILLING_402_BODY = JSON.stringify({
  error: {
    code: 402,
    message:
      "Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.",
    status: "RESOURCE_EXHAUSTED",
  },
});

describe("classifyEmbeddingError (#10448)", () => {
  it("402 / prepayment depleted → billing", () => {
    assert.equal(classifyEmbeddingError({ status: 402, message: "x" }), "billing");
    assert.equal(
      classifyEmbeddingError({ status: 429, message: "Your prepayment credits are depleted" }),
      "billing",
    );
  });
  it("404 → model_not_found (drift #4654), 429 → quota, 403 → auth, null → network, 503 → server", () => {
    assert.equal(classifyEmbeddingError({ status: 404, message: "not found" }), "model_not_found");
    assert.equal(classifyEmbeddingError({ status: 429, message: "rate" }), "quota");
    assert.equal(classifyEmbeddingError({ status: 403, message: "denied" }), "auth");
    assert.equal(classifyEmbeddingError({ status: 400, message: "API key not valid" }), "auth");
    assert.equal(classifyEmbeddingError({ status: null, message: "fetch failed" }), "network");
    assert.equal(classifyEmbeddingError({ status: 503, message: "unavailable" }), "server");
  });
  it("describe aponta billing no AI Studio, não validate-gemini-config", () => {
    const d = describeEmbeddingError({ status: 402, message: "credits depleted" });
    assert.match(d, /HTTP 402 \(billing\)/);
    assert.match(d, /ai\.studio/);
  });
});

describe("redação da chave (#10448)", () => {
  it("remove a chave literal e qualquer ?key= de URL", () => {
    const msg = `request to https://x/v1beta/models/m:embedContent?key=${FAKE_KEY} failed`;
    const out = redactGeminiKey(msg, FAKE_KEY);
    assert.ok(!out.includes(FAKE_KEY));
    assert.match(redactGeminiKey("url?key=OTHERSECRET&x=1", undefined), /key=\[REDACTED\]&x=1/);
  });
  it("trunca mensagens longas", () => {
    assert.ok(normalizeEmbeddingErrorMessage("a".repeat(1000), undefined).length <= 301);
  });
});

describe("topic-cluster captura o status HTTP real (#10448)", () => {
  let savedKey: string | undefined;
  let savedFetch: typeof globalThis.fetch;
  beforeEach(() => {
    savedKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = FAKE_KEY;
    savedFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
    else delete process.env.GEMINI_API_KEY;
  });

  it("embedTextDetailed devolve status 402 + mensagem da API", async () => {
    globalThis.fetch = async () => new Response(BILLING_402_BODY, { status: 402 });
    const r = await embedTextDetailed("texto");
    assert.equal(r.values, null);
    assert.equal(r.error?.status, 402);
    assert.match(r.error?.message ?? "", /RESOURCE_EXHAUSTED: Your prepayment credits are depleted/);
  });

  it("exceção de rede vira status null sem vazar a chave", async () => {
    globalThis.fetch = async () => {
      throw new Error(`connect ETIMEDOUT for ?key=${FAKE_KEY}`);
    };
    const r = await embedTextDetailed("texto");
    assert.equal(r.error?.status, null);
    assert.ok(!(r.error?.message ?? "").includes(FAKE_KEY));
  });

  it("cenário 261019: 100% em 402 → stats com errors_by_status/first_error e aviso do gate nomeia billing", async () => {
    globalThis.fetch = async () => new Response(BILLING_402_BODY, { status: 402 });
    const articles: Article[] = [
      { url: "https://a.com/1", title: "OpenAI lança modelo novo de raciocínio", summary: "OpenAI modelo" },
      { url: "https://b.com/1", title: "Anthropic publica pesquisa interpretabilidade", summary: "Anthropic paper" },
      { url: "https://c.com/1", title: "Google Gemini ganha agente de navegador", summary: "Gemini agente" },
    ];
    const { stats } = await clusterArticlesWithEmbeddings(articles, 0.85);
    assert.equal(stats.failed, 3);
    assert.equal(stats.fallback_triggered, true);
    assert.deepEqual(stats.errors_by_status, { "402": 3 });
    assert.equal(stats.first_error?.status, 402);

    const agg = aggregateEmbeddingStats([stats, { ...stats, errors_by_status: { "402": 2 } }]);
    assert.deepEqual(agg.errors_by_status, { "402": 5 });
    assert.equal(agg.first_error?.status, 402);

    const v = validateEmbeddingHealth(agg);
    assert.equal(v.status, "warn");
    assert.match(v.message, /HTTP 402 \(billing\)/);
    assert.match(v.message, /prepayment credits are depleted/);
    assert.match(v.message, /402×5/);
    assert.doesNotMatch(v.message, /Causa não confirmada/);
    assert.ok(!JSON.stringify(agg).includes(FAKE_KEY), "chave não pode ir pro sidecar");
  });

  it("caminho feliz não grava campos de erro", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ embedding: { values: [1, 0] } }), { status: 200 });
    const { stats } = await clusterArticlesWithEmbeddings(
      [{ url: "https://a.com/1", title: "Artigo sobre IA generativa", summary: "" }],
      0.85,
    );
    assert.equal(stats.failed, 0);
    assert.equal(stats.first_error, undefined);
    assert.equal(stats.errors_by_status, undefined);
  });
});

describe("compat com sidecar anterior ao #10448", () => {
  it("sem first_error, o aviso diz que a causa não foi registrada", () => {
    const s = embeddingCauseSentence({});
    assert.match(s, /não registrada/);
    const v = validateEmbeddingHealth({
      model: "gemini-embedding-001",
      key_present: true,
      attempted: 368,
      failed: 368,
      fail_rate: 1,
      fallback_triggered: true,
    });
    assert.equal(v.status, "warn");
    assert.match(v.message, /100% dos 368/);
  });
});

describe("stage1ValidatorWarningLines (#10448) — texto do warning no relatório", () => {
  it("lista name: message só das assertions warn", () => {
    const lines = stage1ValidatorWarningLines({
      assertions: [
        { name: "outputs_present", status: "ok", message: "ok" },
        { name: "embedding_health", status: "warn", message: "100% falharam — Causa: HTTP 402" },
        { name: "x", status: "block", message: "bloqueio" },
      ],
    });
    assert.deepEqual(lines, ["embedding_health: 100% falharam — Causa: HTTP 402"]);
  });
  it("shape inesperado → []", () => {
    assert.deepEqual(stage1ValidatorWarningLines(undefined), []);
    assert.deepEqual(stage1ValidatorWarningLines({ assertions: "x" }), []);
  });
});
