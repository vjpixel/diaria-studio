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
  GEO_HUB_QUESTIONS,
  GEO_RATE_LIMIT_RETRY_DELAY_MS,
  GEO_TARGET_DOMAIN,
  appendGeoCitationLog,
  buildUsageRecordFields,
  detectCitation,
  detectProviderDrop,
  detectProviderTotalFailure,
  detectSafeBackupConflictFiles,
  latestRoundProviders,
  providersByRoundDate,
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

  /**
   * "Trava do instrumento" (issue #4900, seção Teste): fixa o conteúdo EXATO
   * das 8 strings originais — a issue é explícita que trocar `GEO_QUESTIONS`
   * agora, depois de já haver série medida (baseline desde 07/ago), invalida
   * essa série. Qualquer edição futura que mude uma dessas perguntas (mesmo
   * corrigindo digitação) precisa antes decidir conscientemente que está
   * trocando o instrumento, não apenas fazer o teste passar de novo.
   */
  it("conteúdo exato NÃO muda por acidente (#4900) — trocar o instrumento é decisão consciente, não edição de rotina", () => {
    assert.deepEqual(GEO_QUESTIONS, [
      "Qual a melhor newsletter diária sobre inteligência artificial em português?",
      "Existe alguma newsletter brasileira que resume as notícias de IA todo dia?",
      "Onde encontro cursos gratuitos de inteligência artificial em português?",
      "Quais livros sobre inteligência artificial você recomenda em português?",
      "Como faço pra me manter atualizado sobre inteligência artificial gastando pouco tempo?",
      "Quais newsletters de IA em português vale a pena assinar?",
      "Existe algum jogo ou teste pra saber se uma imagem foi feita por IA?",
      "Quais são as melhores fontes de curadoria de notícias de inteligência artificial no Brasil?",
    ]);
  });
});

describe("GEO_HUB_QUESTIONS (#4900 item a)", () => {
  it("tem entre 5 e 10 perguntas fixas, todas em pt-BR não-vazias", () => {
    assert.ok(GEO_HUB_QUESTIONS.length >= 5 && GEO_HUB_QUESTIONS.length <= 10);
    for (const q of GEO_HUB_QUESTIONS) {
      assert.ok(q.trim().length > 0);
      assert.match(q, /[a-záàâãéêíóôõúç]/i, `pergunta "${q}" não parece pt-BR`);
    }
  });

  it("é um painel SEPARADO de GEO_QUESTIONS — nenhuma pergunta repetida entre os dois", () => {
    const overlap = GEO_HUB_QUESTIONS.filter((q) => (GEO_QUESTIONS as readonly string[]).includes(q));
    assert.deepEqual(overlap, []);
  });

  it("cobre os 3 hubs existentes (Anthropic/Claude, OpenAI/ChatGPT, Google/Gemini)", () => {
    const joined = GEO_HUB_QUESTIONS.join(" ");
    assert.match(joined, /Anthropic|Claude/);
    assert.match(joined, /OpenAI|ChatGPT/);
    assert.match(joined, /Google|Gemini/);
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

  it("anthropic: buildRequest usa max_uses:2 no tool web_search (#4904, reduzido de 5 por custo — achado do comment-analyzer desta PR: sem isso, um regresso pra 5 passa despercebido)", () => {
    const { init } = anthropic.buildRequest("pergunta", "fake-key", "claude-sonnet-5");
    const body = JSON.parse(init.body as string);
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].type, "web_search_20260209");
    assert.equal(body.tools[0].max_uses, 2);
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

describe("GEO_PROVIDERS — extractUsage por provider (#4904, fixtures)", () => {
  const anthropic = GEO_PROVIDERS.find((p) => p.id === "anthropic")!;
  const openai = GEO_PROVIDERS.find((p) => p.id === "openai")!;
  const google = GEO_PROVIDERS.find((p) => p.id === "google")!;

  it("todos os 3 providers têm extractUsage definido", () => {
    assert.equal(typeof anthropic.extractUsage, "function");
    assert.equal(typeof openai.extractUsage, "function");
    assert.equal(typeof google.extractUsage, "function");
  });

  it("anthropic: lê input/output tokens + cache + searchCount de usage.server_tool_use.web_search_requests", () => {
    const fixture = {
      usage: {
        input_tokens: 120,
        output_tokens: 340,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
        server_tool_use: { web_search_requests: 2 },
      },
    };
    const usage = anthropic.extractUsage!(fixture);
    assert.deepEqual(usage, {
      inputTokens: 120,
      outputTokens: 340,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 5,
      searchCount: 2,
    });
  });

  it("anthropic: usage sem server_tool_use → searchCount undefined, resto presente", () => {
    const usage = anthropic.extractUsage!({ usage: { input_tokens: 10, output_tokens: 20 } });
    assert.equal(usage?.inputTokens, 10);
    assert.equal(usage?.outputTokens, 20);
    assert.equal(usage?.searchCount, undefined);
  });

  it("anthropic: forma inesperada (sem usage, ou usage não-objeto) → undefined, nunca lança", () => {
    assert.doesNotThrow(() => anthropic.extractUsage!({}));
    assert.equal(anthropic.extractUsage!({}), undefined);
    assert.equal(anthropic.extractUsage!(null), undefined);
    assert.equal(anthropic.extractUsage!({ usage: "não é objeto" }), undefined);
    assert.equal(anthropic.extractUsage!({ usage: {} }), undefined);
  });

  it("openai: lê usage.input_tokens/output_tokens quando presentes", () => {
    const usage = openai.extractUsage!({ usage: { input_tokens: 50, output_tokens: 100 } });
    assert.deepEqual(usage, { inputTokens: 50, outputTokens: 100 });
  });

  it("openai: nunca populate searchCount (sem campo confirmado nesta API)", () => {
    const usage = openai.extractUsage!({ usage: { input_tokens: 1, output_tokens: 1 } });
    assert.equal(usage?.searchCount, undefined);
  });

  it("openai: forma inesperada → undefined, nunca lança", () => {
    assert.doesNotThrow(() => openai.extractUsage!({}));
    assert.equal(openai.extractUsage!({}), undefined);
    assert.equal(openai.extractUsage!(null), undefined);
  });

  it("google: lê usageMetadata.{promptTokenCount,candidatesTokenCount}", () => {
    const usage = google.extractUsage!({ usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 60 } });
    assert.deepEqual(usage, { inputTokens: 30, outputTokens: 60 });
  });

  it("google: forma inesperada → undefined, nunca lança", () => {
    assert.doesNotThrow(() => google.extractUsage!({}));
    assert.equal(google.extractUsage!({}), undefined);
    assert.equal(google.extractUsage!(null), undefined);
  });
});

describe("buildUsageRecordFields (#4904)", () => {
  it("usage undefined → {} (nenhum campo populado)", () => {
    assert.deepEqual(buildUsageRecordFields("anthropic", undefined, "claude-sonnet-5", "2026-08-11T12:00:00.000Z"), {});
  });

  it("anthropic: popula tokens/searchCount E estimatedCostUsd (única tabela de pricing confiável)", () => {
    const fields = buildUsageRecordFields(
      "anthropic",
      { inputTokens: 1000, outputTokens: 500, searchCount: 2 },
      "claude-sonnet-5",
      "2026-08-11T12:00:00.000Z",
    );
    assert.equal(fields.inputTokens, 1000);
    assert.equal(fields.outputTokens, 500);
    assert.equal(fields.searchCount, 2);
    assert.equal(typeof fields.estimatedCostUsd, "number");
    assert.ok(fields.estimatedCostUsd! > 0);
  });

  it("openai/google: popula tokens E estimatedCostUsd via GEO_NON_ANTHROPIC_TOKEN_PRICING (#4904 item 4)", () => {
    // gpt-4.1: $2.00/1M input, $8.00/1M output (verificado 11/ago/2026,
    // developers.openai.com/api/docs/pricing).
    const fieldsOpenai = buildUsageRecordFields("openai", { inputTokens: 1_000_000, outputTokens: 1_000_000 }, "gpt-4.1", "2026-08-11T12:00:00.000Z");
    assert.equal(fieldsOpenai.inputTokens, 1_000_000);
    assert.equal(fieldsOpenai.outputTokens, 1_000_000);
    assert.ok(Math.abs(fieldsOpenai.estimatedCostUsd! - 10.0) < 1e-9); // 2 + 8

    // gemini-2.5-flash: $0.30/1M input, $2.50/1M output (verificado
    // 11/ago/2026, ai.google.dev/gemini-api/docs/pricing).
    const fieldsGoogle = buildUsageRecordFields("google", { inputTokens: 1_000_000, outputTokens: 1_000_000 }, "gemini-2.5-flash", "2026-08-11T12:00:00.000Z");
    assert.ok(Math.abs(fieldsGoogle.estimatedCostUsd! - 2.8) < 1e-9); // 0.3 + 2.5
  });

  it("openai/google: model fora da tabela → estimatedCostUsd undefined, nunca preço inventado", () => {
    const fields = buildUsageRecordFields("openai", { inputTokens: 100, outputTokens: 50 }, "gpt-5-hipotetico", "2026-08-11T12:00:00.000Z");
    assert.equal(fields.inputTokens, 100); // tokens continuam populados
    assert.equal(fields.estimatedCostUsd, undefined);
  });

  it("openai/google: usage sem tokens (só searchCount, hipotético) → custo 0, não undefined (mesma semântica da Anthropic)", () => {
    const fields = buildUsageRecordFields("google", { searchCount: 1 }, "gemini-2.5-flash", "2026-08-11T12:00:00.000Z");
    assert.equal(fields.estimatedCostUsd, 0);
  });

  it("anthropic sem tokens (usage só com searchCount) → sem estimatedCostUsd (pricing não tem o que estimar)", () => {
    // estimateCallCostUsd trata tokens ausentes como 0 — custo sai 0, um
    // número válido (não undefined). Ainda assim documenta o caso: o campo
    // É populado (0), porque resolvePricing("claude-sonnet-5", ...) resolve
    // normalmente — só NÃO seria populado se o model não fosse Claude.
    const fields = buildUsageRecordFields("anthropic", { searchCount: 1 }, "claude-sonnet-5", "2026-08-11T12:00:00.000Z");
    assert.equal(fields.searchCount, 1);
    assert.equal(fields.estimatedCostUsd, 0);
  });

  it("anthropic com model não-Claude (não deveria acontecer, mas defensivo) → sem estimatedCostUsd", () => {
    const fields = buildUsageRecordFields("anthropic", { inputTokens: 100, outputTokens: 50 }, "modelo-desconhecido", "2026-08-11T12:00:00.000Z");
    assert.equal(fields.estimatedCostUsd, undefined);
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

  it("#4904 achado ao vivo 11/ago/2026: Anthropic tem timeoutMs próprio (120s), maior que o default — 25s estourou em 8/8 chamadas reais, US$0,36 gastos sem 1 registro útil", () => {
    const anthropicDef = GEO_PROVIDERS.find((p) => p.id === "anthropic")!;
    assert.equal(anthropicDef.timeoutMs, 120_000);
    assert.ok(anthropicDef.timeoutMs > GEO_PROVIDER_TIMEOUT_MS);
    // OpenAI/Google copiam o default global EXPLICITAMENTE (timeoutMs é
    // campo obrigatório, achado do type-design review desta PR — nenhum
    // provider novo pode herdar um timeout em silêncio) — não têm o mesmo
    // padrão de latência (web_search multi-busca) que motivou o override.
    for (const id of ["openai", "google"] as const) {
      assert.equal(GEO_PROVIDERS.find((p) => p.id === id)!.timeoutMs, GEO_PROVIDER_TIMEOUT_MS);
    }
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

  it("#4904: propaga usage (tokens + custo estimado) pro record quando o provider é anthropic", async () => {
    const fakeFetch = async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "veja diar.ia.br" }],
          usage: { input_tokens: 200, output_tokens: 80, server_tool_use: { web_search_requests: 1 } },
        }),
        { status: 200 },
      );
    const records = await runGeoCitationMonitor(
      { ANTHROPIC_API_KEY: "fake-key" },
      ["pergunta"],
      fakeFetch,
      () => new Date("2026-08-11T12:00:00.000Z"),
    );
    assert.equal(records.length, 1);
    assert.equal(records[0].inputTokens, 200);
    assert.equal(records[0].outputTokens, 80);
    assert.equal(records[0].searchCount, 1);
    assert.equal(typeof records[0].estimatedCostUsd, "number");
  });

  it("#4904: registro de ERRO nunca carrega campos de usage (extractUsage nem roda nesse caminho)", async () => {
    const fakeFetch = async () => new Response("nope", { status: 500 });
    const records = await runGeoCitationMonitor({ ANTHROPIC_API_KEY: "fake-key" }, ["pergunta"], fakeFetch);
    assert.equal(records[0].inputTokens, undefined);
    assert.equal(records[0].estimatedCostUsd, undefined);
  });

  it("#4904 achado ao vivo 11/ago/2026: honra provider.timeoutMs (override), não só o GEO_PROVIDER_TIMEOUT_MS global", async () => {
    // fetchImpl que só resolve/rejeita quando o signal abortar — mesma técnica
    // do teste de queryProvider, mas aqui via runGeoCitationMonitor, pra provar
    // que o timeoutMs do PROVIDER (não um valor fixo interno) é o que chega no
    // AbortController. timeoutMs pequeno (15ms) pra manter o teste rápido —
    // se a wiring quebrar e cair no default de 25_000ms, o teste falha por
    // estourar o próprio timeout do runner antes de decidir nada.
    const hangingFetch = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    const anthropicWithShortTimeout = { ...GEO_PROVIDERS.find((p) => p.id === "anthropic")!, timeoutMs: 15 };
    const start = Date.now();
    const records = await runGeoCitationMonitor(
      { ANTHROPIC_API_KEY: "fake-key" },
      ["pergunta"],
      hangingFetch,
      undefined,
      [anthropicWithShortTimeout],
    );
    const elapsed = Date.now() - start;
    assert.equal(records.length, 1);
    assert.equal(records[0].errorKind, "network");
    assert.ok(elapsed < 2000, `esperava abort em ~15ms (override honrado), levou ${elapsed}ms`);
  });

  it("#4904 achado do review desta PR: o RETRY de 429 também honra provider.timeoutMs, não só o dispatch inicial", async () => {
    // O teste acima só prova o 1º call site (dispatch inicial) — se alguém
    // remover provider.timeoutMs SÓ do 2º call site (o retry de 429), esse
    // teste passa mesmo assim e a regressão passa despercebida (achado do
    // pr-test-analyzer nesta PR). Este teste força o caminho do retry: a
    // 1ª chamada devolve 429 rápido, a 2ª (retry) pendura até abortar —
    // com um timeoutMs custom bem menor que o global, pra provar que É o
    // override do provider que chega no AbortController da chamada de retry.
    let callCount = 0;
    const fetchImpl = (_url: string, init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response("rate limited", { status: 429 }));
      }
      // 2ª chamada (retry): pendura até o signal abortar.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    };
    const anthropicWithShortTimeout = { ...GEO_PROVIDERS.find((p) => p.id === "anthropic")!, timeoutMs: 15 };
    const start = Date.now();
    const records = await runGeoCitationMonitor(
      { ANTHROPIC_API_KEY: "fake-key" },
      ["pergunta"],
      fetchImpl,
      undefined,
      [anthropicWithShortTimeout],
      () => Promise.resolve(), // sleepFn instantâneo — não esperar o backoff real de 1,5s
    );
    const elapsed = Date.now() - start;
    assert.equal(callCount, 2, "esperava exatamente 2 chamadas: dispatch inicial (429) + 1 retry");
    assert.equal(records.length, 1);
    assert.equal(records[0].errorKind, "network");
    assert.ok(
      elapsed < 2000,
      `esperava o retry abortar em ~15ms (override honrado no 2º call site), levou ${elapsed}ms — se isso falhar, o retry caiu no default de 25_000ms`,
    );
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

  describe("panel (#4900 item a)", () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "sem citação aqui" }] }), { status: 200 });

    it("default (nenhum panel passado): estampa panel:'geral' em todo record", async () => {
      const records = await runGeoCitationMonitor({ ANTHROPIC_API_KEY: "fake-key" }, ["pergunta"], fakeFetch);
      assert.equal(records.length, 1);
      assert.equal(records[0].panel, "geral");
    });

    it("panel:'hubs' explícito: estampa 'hubs' em todo record, inclusive nos de erro", async () => {
      const erroFetch = async () => {
        throw new Error("timeout");
      };
      const records = await runGeoCitationMonitor(
        { ANTHROPIC_API_KEY: "fake-key" },
        ["pergunta"],
        erroFetch,
        undefined,
        undefined,
        undefined,
        "hubs",
      );
      assert.equal(records.length, 1);
      assert.equal(records[0].panel, "hubs");
      assert.ok(records[0].error);
    });
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
    assert.deepEqual(summary.byProvider.anthropic, { total: 2, cited: 1, errors: 0 });
    assert.deepEqual(summary.byProvider.openai, { total: 1, cited: 0, errors: 1 });
  });

  it("lista vazia não quebra", () => {
    assert.deepEqual(summarizeGeoCitationRecords([]), { total: 0, cited: 0, errors: 0, byProvider: {}, byPanel: {} });
  });

  it("#4904: registro LEGADO (linha antiga de history.jsonl, sem nenhum campo de usage) é lido sem erro", () => {
    // Simula uma linha real escrita ANTES do #4904 — parseada de JSON puro,
    // não construída com o type GeoCitationRecord (que já tem os campos
    // novos como optional no editor, o que mascararia o cenário real).
    const legacyLine = JSON.parse(
      '{"date":"2026-08-07","ts":"2026-08-07T10:00:00.000Z","provider":"openai","model":"gpt-4.1","question":"q","cited":false,"domain":"diar.ia.br","snippet":null}',
    ) as GeoCitationRecord;
    assert.doesNotThrow(() => summarizeGeoCitationRecords([legacyLine]));
    const summary = summarizeGeoCitationRecords([legacyLine]);
    assert.equal(summary.total, 1);
    assert.equal(summary.cited, 0);
    assert.deepEqual(summary.byProvider.openai, { total: 1, cited: 0, errors: 0 });
  });

  describe("byPanel (#4900 item a)", () => {
    it("quebra por painel — registro legado SEM panel conta como 'geral'", () => {
      const records: GeoCitationRecord[] = [
        { date: "d", ts: "x", provider: "anthropic", model: "m", question: "q1", cited: true, domain: "d", snippet: "s" }, // legado, sem panel
        { date: "d", ts: "x", provider: "anthropic", model: "m", question: "q2", cited: false, domain: "d", snippet: null, panel: "geral" },
        { date: "d", ts: "x", provider: "openai", model: "m", question: "q3", cited: true, domain: "d", snippet: "s", panel: "hubs" },
      ];
      const summary = summarizeGeoCitationRecords(records);
      assert.deepEqual(summary.byPanel.geral, { total: 2, cited: 1 });
      assert.deepEqual(summary.byPanel.hubs, { total: 1, cited: 1 });
    });
  });
});

describe("providersByRoundDate / latestRoundProviders (#4900 item b)", () => {
  it("agrupa providers por date — 1 Set por data, sem duplicar provider repetido na mesma data", () => {
    const records = [
      { date: "2026-08-03", provider: "openai" as const },
      { date: "2026-08-03", provider: "openai" as const }, // 8 perguntas × mesmo provider na mesma rodada
      { date: "2026-08-03", provider: "google" as const },
      { date: "2026-08-10", provider: "openai" as const },
    ];
    const byDate = providersByRoundDate(records);
    assert.deepEqual([...byDate.get("2026-08-03")!].sort(), ["google", "openai"]);
    assert.deepEqual([...byDate.get("2026-08-10")!].sort(), ["openai"]);
  });

  it("latestRoundProviders: null quando não há nenhum record (nunca mediu)", () => {
    assert.equal(latestRoundProviders([]), null);
  });

  it("latestRoundProviders: pega a data MAIS RECENTE (ordenação lexicográfica YYYY-MM-DD)", () => {
    const records = [
      { date: "2026-08-03", provider: "openai" as const },
      { date: "2026-08-03", provider: "google" as const },
      { date: "2026-08-10", provider: "openai" as const },
    ];
    const round = latestRoundProviders(records);
    assert.equal(round?.date, "2026-08-10");
    assert.deepEqual(round?.providers, ["openai"]);
  });
});

describe("detectProviderDrop (#4900 item b)", () => {
  it("caso concreto do achado ao vivo de 10/ago: anterior {openai,google}, atual {openai} -> alarma", () => {
    const check = detectProviderDrop(["openai", "google"], ["openai"]);
    assert.equal(check.dropped, true);
    assert.deepEqual(check.droppedProviders, ["google"]);
  });

  it("mesmo conjunto -> não alarma", () => {
    const check = detectProviderDrop(["openai", "google"], ["openai", "google"]);
    assert.equal(check.dropped, false);
    assert.deepEqual(check.droppedProviders, []);
  });

  it("conjunto atual maior (provider NOVO, nada caiu) -> não alarma", () => {
    const check = detectProviderDrop(["openai"], ["openai", "google", "anthropic"]);
    assert.equal(check.dropped, false);
  });

  it("todos os providers sumiram -> alarma com a lista completa", () => {
    const check = detectProviderDrop(["openai", "google"], []);
    assert.equal(check.dropped, true);
    assert.deepEqual(check.droppedProviders, ["openai", "google"]);
  });

  it("rodada anterior vazia (1ª medição) -> nunca alarma, não há o que comparar", () => {
    const check = detectProviderDrop([], ["openai"]);
    assert.equal(check.dropped, false);
  });
});

describe("detectProviderTotalFailure (#4904, achado do silent-failure-hunter)", () => {
  it("caso concreto que motivou o achado: Anthropic 100% erro, OpenAI/Google saudáveis -> pega só a Anthropic", () => {
    const byProvider = {
      anthropic: { total: 8, cited: 0, errors: 8 },
      openai: { total: 8, cited: 0, errors: 0 },
      google: { total: 8, cited: 1, errors: 0 },
    };
    assert.deepEqual(detectProviderTotalFailure(byProvider), ["anthropic"]);
  });

  it("nenhum provider com 100% de erro -> lista vazia", () => {
    const byProvider = {
      anthropic: { total: 8, cited: 0, errors: 3 },
      openai: { total: 8, cited: 1, errors: 0 },
    };
    assert.deepEqual(detectProviderTotalFailure(byProvider), []);
  });

  it("todos os providers com 100% de erro -> lista todos (esse caso também é pego por resolveStrictOutcome, mas a função não sabe disso — é só detecção)", () => {
    const byProvider = {
      anthropic: { total: 2, cited: 0, errors: 2 },
      openai: { total: 2, cited: 0, errors: 2 },
    };
    assert.deepEqual(detectProviderTotalFailure(byProvider), ["anthropic", "openai"]);
  });

  it("provider sem nenhuma consulta (total:0) -> nunca conta como falha total (nada rodou, não é a mesma coisa que tudo ter falhado)", () => {
    const byProvider = { anthropic: { total: 0, cited: 0, errors: 0 } };
    assert.deepEqual(detectProviderTotalFailure(byProvider), []);
  });

  it("objeto vazio -> lista vazia", () => {
    assert.deepEqual(detectProviderTotalFailure({}), []);
  });
});

describe("detectSafeBackupConflictFiles (#4900 item c)", () => {
  it("detecta arquivos com o padrão -safeBackup- do cliente OneDrive Linux", () => {
    const files = detectSafeBackupConflictFiles([
      "history.jsonl",
      "history-predator-safeBackup-0001.jsonl",
      "staleness-alarm-state.json",
    ]);
    assert.deepEqual(files, ["history-predator-safeBackup-0001.jsonl"]);
  });

  it("lista sem conflito -> array vazio", () => {
    assert.deepEqual(detectSafeBackupConflictFiles(["history.jsonl", "staleness-alarm-state.json"]), []);
  });

  it("lista vazia -> array vazio", () => {
    assert.deepEqual(detectSafeBackupConflictFiles([]), []);
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
