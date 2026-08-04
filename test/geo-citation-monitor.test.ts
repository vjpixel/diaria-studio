/**
 * test/geo-citation-monitor.test.ts (#4558 Parte C)
 *
 * Cobre `scripts/lib/geo-citation-monitor.ts` — detecção de citação
 * (`detectCitation`), extração de texto por provider (fixtures fixas,
 * simulando shapes de resposta reais o bastante pra exercitar o parsing),
 * orquestração (`runGeoCitationMonitor`, com `fetchImpl` injetado — NUNCA
 * chamada de rede real) e persistência (`appendGeoCitationLog`, com IO
 * injetado — NUNCA grava em disco de verdade).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  GEO_PROVIDER_TIMEOUT_MS,
  GEO_PROVIDERS,
  GEO_QUESTIONS,
  GEO_RATE_LIMIT_RETRY_DELAY_MS,
  GEO_TARGET_DOMAIN,
  appendGeoCitationLog,
  detectCitation,
  queryProvider,
  runGeoCitationMonitor,
  summarizeGeoCitationRecords,
  type GeoCitationRecord,
} from "../scripts/lib/geo-citation-monitor.ts";

describe("GEO_QUESTIONS (#4558)", () => {
  it("tem entre 5 e 10 perguntas fixas, todas em pt-BR não-vazias", () => {
    assert.ok(GEO_QUESTIONS.length >= 5 && GEO_QUESTIONS.length <= 10);
    for (const q of GEO_QUESTIONS) {
      assert.ok(q.trim().length > 0);
      assert.match(q, /[a-záàâãéêíóôõúç]/i, `pergunta "${q}" não parece pt-BR`);
    }
  });
});

describe("detectCitation", () => {
  it("detecta o domínio (case-insensitive) e extrai um snippet de contexto", () => {
    const d = detectCitation("Recomendo a newsletter diar.ia.br pra acompanhar IA todo dia.");
    assert.equal(d.cited, true);
    assert.match(d.snippet ?? "", /diar\.ia\.br/);
  });

  it("case-insensitive", () => {
    const d = detectCitation("Veja a DIAR.IA.BR");
    assert.equal(d.cited, true);
  });

  it("não detecta quando o domínio não aparece", () => {
    const d = detectCitation("Recomendo o TLDR AI e o Ben's Bites.");
    assert.deepEqual(d, { cited: false, snippet: null });
  });

  it("aceita um domínio customizado (não hardcoded pra diar.ia.br)", () => {
    const d = detectCitation("Veja outrosite.com.br", "outrosite.com.br");
    assert.equal(d.cited, true);
  });

  it("é pure", () => {
    const text = "diar.ia.br é ótimo";
    assert.deepEqual(detectCitation(text), detectCitation(text));
  });
});

describe("GEO_PROVIDERS — extractText por provider (fixtures)", () => {
  const anthropic = GEO_PROVIDERS.find((p) => p.id === "anthropic")!;
  const openai = GEO_PROVIDERS.find((p) => p.id === "openai")!;
  const google = GEO_PROVIDERS.find((p) => p.id === "google")!;

  it("anthropic: junta blocos de texto E urls de citação", () => {
    const fixture = {
      content: [
        { type: "text", text: "Recomendo a " },
        { type: "text", text: "diar.ia.br", citations: [{ url: "https://diar.ia.br/p/exemplo" }] },
        { type: "web_search_tool_result", content: [] },
      ],
    };
    const text = anthropic.extractText(fixture);
    assert.match(text, /diar\.ia\.br/);
    assert.match(text, /https:\/\/diar\.ia\.br\/p\/exemplo/);
  });

  it("anthropic: forma inesperada não lança, devolve string vazia", () => {
    assert.doesNotThrow(() => anthropic.extractText({}));
    assert.equal(anthropic.extractText({}), "");
    assert.equal(anthropic.extractText(null), "");
    assert.equal(anthropic.extractText("string crua"), "");
  });

  it("openai: usa output_text quando presente", () => {
    assert.equal(openai.extractText({ output_text: "Resposta com diar.ia.br" }), "Resposta com diar.ia.br");
  });

  it("openai: fallback pra output[].content[] quando output_text ausente", () => {
    const fixture = {
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "Recomendo diar.ia.br" }],
        },
      ],
    };
    assert.match(openai.extractText(fixture), /diar\.ia\.br/);
  });

  it("openai: forma inesperada não lança", () => {
    assert.doesNotThrow(() => openai.extractText({}));
    assert.equal(openai.extractText({}), "");
  });

  it("google: junta candidates[0].content.parts[].text", () => {
    const fixture = {
      candidates: [{ content: { parts: [{ text: "Recomendo " }, { text: "diar.ia.br" }] } }],
    };
    assert.equal(google.extractText(fixture), "Recomendo \ndiar.ia.br");
  });

  it("google: forma inesperada não lança", () => {
    assert.doesNotThrow(() => google.extractText({}));
    assert.equal(google.extractText({ candidates: [] }), "");
  });
});

describe("queryProvider (fetchImpl injetado — nunca rede real)", () => {
  const anthropic = GEO_PROVIDERS.find((p) => p.id === "anthropic")!;

  it("sucesso: devolve {ok:true, text} extraído via extractText", async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "cita diar.ia.br aqui" }] }), { status: 200 });
    const result = await queryProvider(anthropic, "pergunta", "fake-key", "claude-sonnet-5", fakeFetch);
    assert.equal(result.ok, true);
    if (result.ok) assert.match(result.text, /diar\.ia\.br/);
  });

  it("HTTP não-ok: devolve {ok:false, error, errorKind:'http', httpStatus} (#4616 achado 1)", async () => {
    const fakeFetch = async () => new Response("unauthorized", { status: 401 });
    const result = await queryProvider(anthropic, "pergunta", "bad-key", "claude-sonnet-5", fakeFetch);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /401/);
      assert.equal(result.errorKind, "http");
      assert.equal(result.httpStatus, 401);
    }
  });

  it("erro de rede (fetch rejeita): devolve {ok:false, error, errorKind:'network'}, sem httpStatus (#4616 achado 1)", async () => {
    const fakeFetch = async () => {
      throw new Error("network down");
    };
    const result = await queryProvider(anthropic, "pergunta", "fake-key", "claude-sonnet-5", fakeFetch);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /network down/);
      assert.equal(result.errorKind, "network");
      assert.equal(result.httpStatus, undefined);
    }
  });

  it("JSON malformado: devolve {ok:false, error, errorKind:'parse'} (#4616 achado 1)", async () => {
    const fakeFetch = async () => new Response("{not json", { status: 200 });
    const result = await queryProvider(anthropic, "pergunta", "fake-key", "claude-sonnet-5", fakeFetch);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errorKind, "parse");
  });

  it("extractText lança (regressão de contrato): devolve {ok:false, errorKind:'extract'}, distinguível de rede/parse (#4616 achado 1)", async () => {
    // Regressão hipotética: extractText é documentado como pura/defensiva/
    // nunca-lança, mas se algum dia regredir, o catch ANTES do #4616 (um
    // único try/catch em volta de fetch+json+extractText) faria isso virar
    // um `error: string` idêntico em forma a uma falha de rede transitória —
    // impossível distinguir depois. Este teste garante o discriminante.
    const throwingProvider = {
      ...anthropic,
      extractText: () => {
        throw new Error("bug de regressão no extractText");
      },
    };
    const fakeFetch = async () => new Response(JSON.stringify({ content: [] }), { status: 200 });
    const result = await queryProvider(throwingProvider, "pergunta", "fake-key", "claude-sonnet-5", fakeFetch);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /bug de regressão/);
      assert.equal(result.errorKind, "extract");
      assert.notEqual(result.errorKind, "network");
      assert.notEqual(result.errorKind, "parse");
    }
  });

  it("timeout explícito: fetch que nunca resolve é abortado via AbortController (#4616 achado 2)", async () => {
    // fetchImpl que só resolve/rejeita quando o signal injetado abortar —
    // simula uma conexão pendurada de verdade. timeoutMs pequeno (10ms) pra
    // manter o teste rápido; o valor de produção é GEO_PROVIDER_TIMEOUT_MS.
    const fakeFetch = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    const result = await queryProvider(anthropic, "pergunta", "fake-key", "claude-sonnet-5", fakeFetch, 10);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorKind, "network");
      assert.match(result.error, /abort/i);
    }
  });

  it("GEO_PROVIDER_TIMEOUT_MS é o default (25s, mesma referência do fetch in-page do Beehiiv, #4616 achado 2)", () => {
    assert.equal(GEO_PROVIDER_TIMEOUT_MS, 25_000);
  });
});

describe("runGeoCitationMonitor (#4558 Parte C)", () => {
  it("pula providers sem API key configurada — fail-soft, nunca erro", async () => {
    const fakeFetch = async () => {
      throw new Error("não deveria chamar fetch — nenhum provider tem key");
    };
    const records = await runGeoCitationMonitor({}, ["pergunta 1"], fakeFetch);
    assert.deepEqual(records, []);
  });

  it("roda só os providers com key presente, 1 record por pergunta×provider", async () => {
    const fakeFetch = async (url: string) => {
      if (url.includes("anthropic")) {
        return new Response(JSON.stringify({ content: [{ type: "text", text: "sem citação aqui" }] }), { status: 200 });
      }
      throw new Error(`não deveria chamar ${url} — só ANTHROPIC_API_KEY está setada`);
    };
    const questions = ["pergunta A", "pergunta B"];
    const records = await runGeoCitationMonitor(
      { ANTHROPIC_API_KEY: "fake-key" },
      questions,
      fakeFetch,
      () => new Date("2026-08-04T12:00:00.000Z"),
    );
    assert.equal(records.length, 2);
    assert.ok(records.every((r) => r.provider === "anthropic"));
    assert.deepEqual(
      records.map((r) => r.question),
      questions,
    );
    assert.ok(records.every((r) => r.cited === false));
    assert.ok(records.every((r) => r.date === "2026-08-04"));
  });

  it("marca cited=true quando o domínio aparece na resposta", async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "veja diar.ia.br" }] }), { status: 200 });
    const records = await runGeoCitationMonitor({ ANTHROPIC_API_KEY: "fake-key" }, ["pergunta"], fakeFetch);
    assert.equal(records.length, 1);
    assert.equal(records[0].cited, true);
    assert.equal(records[0].domain, GEO_TARGET_DOMAIN);
    assert.match(records[0].snippet ?? "", /diar\.ia\.br/);
  });

  it("falha de rede vira record com error, cited=false — nunca lança pra fora", async () => {
    const fakeFetch = async () => {
      throw new Error("timeout");
    };
    const records = await runGeoCitationMonitor({ ANTHROPIC_API_KEY: "fake-key" }, ["pergunta"], fakeFetch);
    assert.equal(records.length, 1);
    assert.equal(records[0].cited, false);
    assert.match(records[0].error ?? "", /timeout/);
  });

  it("usa o model default do provider, ou {ENVKEY}_MODEL se setado", async () => {
    const seenModels: string[] = [];
    const fakeFetch = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      seenModels.push(body.model);
      return new Response(JSON.stringify({ content: [{ type: "text", text: "x" }] }), { status: 200 });
    };
    await runGeoCitationMonitor({ ANTHROPIC_API_KEY: "fake-key" }, ["p"], fakeFetch);
    await runGeoCitationMonitor(
      { ANTHROPIC_API_KEY: "fake-key", ANTHROPIC_API_KEY_MODEL: "claude-opus-5" },
      ["p"],
      fakeFetch,
    );
    assert.equal(seenModels[0], "claude-sonnet-5"); // default do provider
    assert.equal(seenModels[1], "claude-opus-5"); // override via env
  });

  it("propaga errorKind/httpStatus pro record (#4616 achado 1)", async () => {
    const fakeFetch = async () => new Response("nope", { status: 500 });
    const records = await runGeoCitationMonitor({ ANTHROPIC_API_KEY: "fake-key" }, ["pergunta"], fakeFetch);
    assert.equal(records.length, 1);
    assert.equal(records[0].errorKind, "http");
    assert.equal(records[0].httpStatus, 500);
  });

  it("429 recebe exatamente 1 retry, com backoff — sucede na 2ª tentativa (#4616 achado 4)", async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      if (calls === 1) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "veja diar.ia.br" }] }), { status: 200 });
    };
    const sleeps: number[] = [];
    const records = await runGeoCitationMonitor(
      { ANTHROPIC_API_KEY: "fake-key" },
      ["pergunta"],
      fakeFetch,
      undefined,
      undefined,
      async (ms) => {
        sleeps.push(ms);
      },
    );
    assert.equal(calls, 2, "esperava 2 chamadas: a 429 original + o retry");
    assert.deepEqual(sleeps, [GEO_RATE_LIMIT_RETRY_DELAY_MS]);
    assert.equal(records.length, 1, "1 record final — não 2 (o retry não deve duplicar o record)");
    assert.equal(records[0].cited, true);
    assert.equal(records[0].error, undefined);
  });

  it("429 que persiste nas 2 tentativas vira record de erro (sem retry infinito, #4616 achado 4)", async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return new Response("rate limited", { status: 429 });
    };
    const records = await runGeoCitationMonitor(
      { ANTHROPIC_API_KEY: "fake-key" },
      ["pergunta"],
      fakeFetch,
      undefined,
      undefined,
      async () => {}, // sleep no-op — não espera o delay real no teste
    );
    assert.equal(calls, 2, "1 tentativa original + exatamente 1 retry, nunca mais");
    assert.equal(records.length, 1);
    assert.equal(records[0].errorKind, "http");
    assert.equal(records[0].httpStatus, 429);
  });

  it("erro não-429 (ex: 500) NÃO é retentado (só 429 tem o retry, #4616 achado 4)", async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return new Response("boom", { status: 500 });
    };
    const records = await runGeoCitationMonitor({ ANTHROPIC_API_KEY: "fake-key" }, ["pergunta"], fakeFetch);
    assert.equal(calls, 1, "500 não deve disparar o retry de rate-limit");
    assert.equal(records[0].httpStatus, 500);
  });
});

describe("summarizeGeoCitationRecords", () => {
  it("agrega total/cited/errors e por provider", () => {
    const records: GeoCitationRecord[] = [
      { date: "2026-08-04", ts: "x", provider: "anthropic", model: "m", question: "q1", cited: true, domain: "d", snippet: "s" },
      { date: "2026-08-04", ts: "x", provider: "anthropic", model: "m", question: "q2", cited: false, domain: "d", snippet: null },
      { date: "2026-08-04", ts: "x", provider: "openai", model: "m", question: "q1", cited: false, domain: "d", snippet: null, error: "boom" },
    ];
    const summary = summarizeGeoCitationRecords(records);
    assert.equal(summary.total, 3);
    assert.equal(summary.cited, 1);
    assert.equal(summary.errors, 1);
    assert.deepEqual(summary.byProvider.anthropic, { total: 2, cited: 1 });
    assert.deepEqual(summary.byProvider.openai, { total: 1, cited: 0 });
  });

  it("lista vazia não quebra", () => {
    assert.deepEqual(summarizeGeoCitationRecords([]), { total: 0, cited: 0, errors: 0, byProvider: {} });
  });
});

describe("appendGeoCitationLog (IO injetado — nunca grava em disco de verdade)", () => {
  it("chama mkdirSync + appendFileSync com 1 linha JSON por record", () => {
    const mkdirCalls: string[] = [];
    const appendCalls: Array<{ path: string; data: string }> = [];
    const records: GeoCitationRecord[] = [
      { date: "2026-08-04", ts: "x", provider: "anthropic", model: "m", question: "q1", cited: true, domain: "d", snippet: "s" },
    ];
    appendGeoCitationLog(records, "data/geo-citations/history.jsonl", {
      mkdirSync: (p) => mkdirCalls.push(p),
      appendFileSync: (p, d) => appendCalls.push({ path: p, data: d }),
    });
    assert.equal(mkdirCalls.length, 1);
    assert.equal(appendCalls.length, 1);
    assert.equal(appendCalls[0].path, "data/geo-citations/history.jsonl");
    const parsed = JSON.parse(appendCalls[0].data.trim());
    assert.deepEqual(parsed, records[0]);
  });

  it("lista vazia não grava nada (nem mkdir)", () => {
    let called = false;
    appendGeoCitationLog([], "x.jsonl", {
      mkdirSync: () => (called = true),
      appendFileSync: () => (called = true),
    });
    assert.equal(called, false);
  });

  it("2+ records viram 2+ linhas JSONL (uma por linha)", () => {
    const appendCalls: string[] = [];
    const records: GeoCitationRecord[] = [
      { date: "2026-08-04", ts: "x", provider: "anthropic", model: "m", question: "q1", cited: true, domain: "d", snippet: "s" },
      { date: "2026-08-04", ts: "x", provider: "openai", model: "m", question: "q2", cited: false, domain: "d", snippet: null },
    ];
    appendGeoCitationLog(records, "x.jsonl", {
      mkdirSync: () => {},
      appendFileSync: (_p, d) => appendCalls.push(d),
    });
    const lines = appendCalls[0].trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).question, "q1");
    assert.equal(JSON.parse(lines[1]).question, "q2");
  });
});
