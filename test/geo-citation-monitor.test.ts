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
  OPENAI_GEO_TIMEOUT_MS,
  isOpenAiReasoningModel,
  GEO_PROVIDERS,
  GEO_QUESTIONS,
  GEO_HUB_QUESTIONS,
  GEO_ENTITY_QUESTIONS,
  GEO_RATE_LIMIT_RETRY_DELAY_MS,
  GEO_TARGET_DOMAIN,
  GEO_ERROR_RATE_ALARM_THRESHOLD_PCT,
  appendGeoCitationLog,
  buildUsageRecordFields,
  classifyHttp429ErrorKind,
  detectCitation,
  detectHighErrorRateProviders,
  deriveEffectiveErrorKind,
  detectProviderDrop,
  detectProviderTotalFailure,
  detectSafeBackupConflictFiles,
  errorRatePct,
  isRetryableGeoError,
  latestRoundProviders,
  providersByRoundDate,
  queryProvider,
  runGeoCitationMonitor,
  summarizeGeoCitationRecords,
  summarizeHistoryByProviderReclassified,
  type GeoCitationRecord,
} from "../scripts/lib/geo-citation-monitor.ts";

describe("GEO_ENTITY_QUESTIONS (#8344)", () => {
  it("tem exatamente 16 perguntas (2 por entidade × 8 entidades), todas em pt-BR não-vazias", () => {
    assert.equal(GEO_ENTITY_QUESTIONS.length, 16);
    for (const q of GEO_ENTITY_QUESTIONS) {
      assert.ok(q.trim().length > 0);
      assert.match(q, /[a-záàâãéêíóôõúç]/i, `pergunta "${q}" não parece pt-BR`);
    }
  });

  it("cobre as 8 entidades (cada slug de especial.diar.ia.br/entidades/{slug}/ mencionado em pelo menos 1 pergunta)", () => {
    const entities = ["Alibaba", "Amazon", "Apple", "DeepSeek", "Oracle", "Perplexity", "Samsung", "xAI"];
    for (const entity of entities) {
      assert.ok(
        GEO_ENTITY_QUESTIONS.some((q) => q.includes(entity)),
        `nenhuma pergunta menciona "${entity}"`,
      );
    }
  });

  it("nenhuma pergunta duplicada", () => {
    assert.equal(new Set(GEO_ENTITY_QUESTIONS).size, GEO_ENTITY_QUESTIONS.length);
  });
});

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
  // Teto subiu de 10 pra 20 no #4558 (5º hub, brasil-regulacao, sessão
  // develop 260811): o painel cresce por HUB (guard de cobertura em
  // test/geo-hub-questions-cobrem-hubs-4900.test.ts exige 1+ pergunta por
  // hub publicado), e o roadmap de #4558 já tem ~12 candidatos além dos 5
  // hubs de hoje — um teto fixo em 10 quebraria de novo no 6º hub. 20 dá
  // folga pra mais ~5 hubs (2 perguntas cada) sem precisar revisitar este
  // número a cada publicação. Decisão do editor (sessão 260811): manter o
  // histórico de data/geo-citations/ ao crescer o painel (não resetar o
  // baseline) — ver a nota completa sobre esse trade-off no comentário
  // acima de GEO_HUB_QUESTIONS.
  it("tem entre 5 e 20 perguntas fixas, todas em pt-BR não-vazias", () => {
    assert.ok(GEO_HUB_QUESTIONS.length >= 5 && GEO_HUB_QUESTIONS.length <= 20);
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

  it("anthropic: buildRequest com model Sonnet/Opus (não-Haiku) usa a variante web_search_20260209 (dynamic filtering)", () => {
    const { init } = anthropic.buildRequest("pergunta", "fake-key", "claude-opus-5");
    const body = JSON.parse(init.body as string);
    assert.equal(body.tools[0].type, "web_search_20260209");
    assert.equal(body.tools[0].max_uses, 2);
  });

  it("anthropic: buildRequest com model Haiku usa a variante básica web_search_20250305 — a _20260209 (dynamic filtering) não suporta Haiku 4.5 (self-review #5954, finding P1)", () => {
    const { init } = anthropic.buildRequest("pergunta", "fake-key", "claude-haiku-4-5-20251001");
    const body = JSON.parse(init.body as string);
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].type, "web_search_20250305");
    assert.equal(body.tools[0].name, "web_search");
    // variante básica não aceita max_uses (parâmetro específico da dynamic
    // filtering) — nunca deve vazar aqui.
    assert.equal("max_uses" in body.tools[0], false);
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

  it("#8064: resposta de modelo de raciocínio (reasoning + web_search_call antes da message) extrai texto e não vira erro de provider", () => {
    const fixture = {
      status: "completed",
      output: [
        { type: "reasoning", id: "rs_1", summary: [] },
        { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "newsletter IA" } },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Recomendo a diar.ia.br", annotations: [] }],
        },
      ],
      usage: { input_tokens: 9000, output_tokens: 700, output_tokens_details: { reasoning_tokens: 400 } },
    };
    assert.match(openai.extractText(fixture), /diar\.ia\.br/);
    assert.equal(openai.checkProviderError!(fixture), undefined);
    // reasoning_tokens já vêm dentro de output_tokens — nunca somar de novo.
    assert.deepEqual(openai.extractUsage!(fixture), { inputTokens: 9000, outputTokens: 700 });
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

    // #8064 — gpt-5-mini: $0.25/1M input, $2.00/1M output (verificado
    // 12/09/2026). Sem isso na tabela, o teto --max-monthly-usd ficaria cego.
    const fieldsGpt5Mini = buildUsageRecordFields("openai", { inputTokens: 1_000_000, outputTokens: 1_000_000 }, "gpt-5-mini", "2026-09-12T12:00:00.000Z");
    assert.ok(Math.abs(fieldsGpt5Mini.estimatedCostUsd! - 2.25) < 1e-9); // 0.25 + 2

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

  it("buildRequest usa max_tokens:4096 e thinking:{type:'adaptive'} explícito (#5305)", () => {
    const { init } = anthropic.buildRequest("pergunta", "fake-key", "claude-sonnet-5");
    const body = JSON.parse(init.body as string);
    assert.equal(body.max_tokens, 4096);
    assert.deepEqual(body.thinking, { type: "adaptive" });
  });

  it("buildRequest com model Haiku 4.5 usa thinking:{type:'enabled', budget_tokens:1024} — Haiku não aceita 'adaptive' (#5951)", () => {
    const { init } = anthropic.buildRequest("pergunta", "fake-key", "claude-haiku-4-5-20251001");
    const body = JSON.parse(init.body as string);
    assert.equal(body.max_tokens, 4096);
    assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 1024 });
    // Nunca desligado por completo (mesmo raciocínio do #5305 — thinking
    // desligado reduz propensão a tool use, e a chamada depende de web_search).
    assert.notEqual(body.thinking.type, "disabled");
  });

  it("defaultModel do provider anthropic é Haiku 4.5 pinned (#5951, decisão do editor 23/08/2026)", () => {
    assert.equal(anthropic.defaultModel, "claude-haiku-4-5-20251001");
  });

  it("stop_reason:'max_tokens' com content:[{type:'thinking'}] devolve erro de provider, NUNCA ausência de citação (#5305)", async () => {
    // Reproduz o cenário exato do issue: a resposta estourou max_tokens
    // (thinking + texto somados no Sonnet 5) e não sobrou bloco de texto —
    // sem a checagem de stop_reason, anthropicExtractText devolveria "" e
    // o monitor registraria "não citado" (falso negativo indistinguível do
    // caso legítimo).
    const fakeFetch = async () =>
      new Response(JSON.stringify({ stop_reason: "max_tokens", content: [{ type: "thinking" }] }), { status: 200 });
    const result = await queryProvider(anthropic, "pergunta", "fake-key", "claude-sonnet-5", fakeFetch);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorKind, "provider");
      assert.match(result.error, /max_tokens/);
    }
  });

  it("stop_reason:'refusal' devolve erro de provider, NUNCA ausência de citação (#5305)", async () => {
    // HTTP 200 com content vazio — as salvaguardas de cyber do Sonnet 5
    // recusaram a pergunta. Mesmo caminho de leitura do caso feliz, mesmo
    // risco de virar "não citado" silencioso sem a checagem.
    const fakeFetch = async () => new Response(JSON.stringify({ stop_reason: "refusal", content: [] }), { status: 200 });
    const result = await queryProvider(anthropic, "pergunta", "fake-key", "claude-sonnet-5", fakeFetch);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorKind, "provider");
      assert.match(result.error, /refusal/);
    }
  });

  it("caso feliz: stop_reason:'end_turn' + texto vazio continua 'não citado' legítimo (#5305)", async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "resposta sem o domínio" }] }), {
        status: 200,
      });
    const result = await queryProvider(anthropic, "pergunta", "fake-key", "claude-sonnet-5", fakeFetch);
    assert.equal(result.ok, true);
    if (result.ok) {
      const detection = detectCitation(result.text);
      assert.equal(detection.cited, false);
    }
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

  const openai = GEO_PROVIDERS.find((p) => p.id === "openai")!;
  const google = GEO_PROVIDERS.find((p) => p.id === "google")!;

  it("OpenAI: status:'incomplete' (max_output_tokens) devolve erro de provider, NUNCA ausência de citação (#5310)", async () => {
    // Mesma classe do #5305: a Responses API parou antes de terminar e
    // output[] não tem bloco output_text — sem a checagem, openaiExtractText
    // devolveria "" e o monitor registraria "não citado" por engano.
    const fakeFetch = async () =>
      new Response(JSON.stringify({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }), {
        status: 200,
      });
    const result = await queryProvider(openai, "pergunta", "fake-key", "gpt-4.1", fakeFetch);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorKind, "provider");
      assert.match(result.error, /incomplete/);
      assert.match(result.error, /max_output_tokens/);
    }
  });

  it("OpenAI: status:'incomplete' (content_filter) devolve erro de provider (#5310)", async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] }), {
        status: 200,
      });
    const result = await queryProvider(openai, "pergunta", "fake-key", "gpt-4.1", fakeFetch);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorKind, "provider");
      assert.match(result.error, /content_filter/);
    }
  });

  it("OpenAI: status:'failed' devolve erro de provider, NUNCA ausência de citação (#5320)", async () => {
    // Distinto de "incomplete" — resposta síncrona HTTP-200 onde a geração
    // falhou no servidor, output/output_text tipicamente vazio + objeto
    // `error` no nível raiz. Sem a checagem, openaiExtractText devolveria ""
    // e o monitor registraria "não citado" por engano (mesma classe do #5310).
    const fakeFetch = async () =>
      new Response(JSON.stringify({ status: "failed", error: { message: "internal error", code: "server_error" } }), {
        status: 200,
      });
    const result = await queryProvider(openai, "pergunta", "fake-key", "gpt-4.1", fakeFetch);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorKind, "provider");
      assert.match(result.error, /failed/);
      assert.match(result.error, /internal error/);
    }
  });

  it("OpenAI: bloco output[].content[].type:'refusal' devolve erro de provider (#5310)", async () => {
    const fakeFetch = async () =>
      new Response(
        JSON.stringify({ status: "completed", output: [{ content: [{ type: "refusal", refusal: "não posso ajudar com isso" }] }] }),
        { status: 200 },
      );
    const result = await queryProvider(openai, "pergunta", "fake-key", "gpt-4.1", fakeFetch);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorKind, "provider");
      assert.match(result.error, /refusal/);
    }
  });

  it("OpenAI: caso feliz — status:'completed' + output_text vazio continua 'não citado' legítimo (#5310)", async () => {
    const fakeFetch = async () => new Response(JSON.stringify({ status: "completed", output_text: "" }), { status: 200 });
    const result = await queryProvider(openai, "pergunta", "fake-key", "gpt-4.1", fakeFetch);
    assert.equal(result.ok, true);
    if (result.ok) {
      const detection = detectCitation(result.text);
      assert.equal(detection.cited, false);
    }
  });

  it("Google: candidates[0].finishReason:'SAFETY' devolve erro de provider, NUNCA ausência de citação (#5310)", async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ candidates: [{ finishReason: "SAFETY", content: {} }] }), { status: 200 });
    const result = await queryProvider(google, "pergunta", "fake-key", "gemini-2.5-flash", fakeFetch);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorKind, "provider");
      assert.match(result.error, /SAFETY/);
    }
  });

  it("Google: candidates[0].finishReason:'MAX_TOKENS' devolve erro de provider (#5310)", async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ candidates: [{ finishReason: "MAX_TOKENS" }] }), { status: 200 });
    const result = await queryProvider(google, "pergunta", "fake-key", "gemini-2.5-flash", fakeFetch);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorKind, "provider");
      assert.match(result.error, /MAX_TOKENS/);
    }
  });

  it("Google: promptFeedback.blockReason devolve erro de provider mesmo sem candidates (#5310)", async () => {
    const fakeFetch = async () => new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), { status: 200 });
    const result = await queryProvider(google, "pergunta", "fake-key", "gemini-2.5-flash", fakeFetch);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorKind, "provider");
      assert.match(result.error, /blockReason/);
    }
  });

  it("Google: caso feliz — finishReason:'STOP' + texto vazio continua 'não citado' legítimo (#5310)", async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "" }] } }] }), {
        status: 200,
      });
    const result = await queryProvider(google, "pergunta", "fake-key", "gemini-2.5-flash", fakeFetch);
    assert.equal(result.ok, true);
    if (result.ok) {
      const detection = detectCitation(result.text);
      assert.equal(detection.cited, false);
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

  it("#4904/#5950: Anthropic tem timeoutMs próprio (270s desde #5950, era 120s), maior que o default — 25s estourou em 8/8 chamadas reais, US$0,36 gastos sem 1 registro útil; 120s ainda descartava respostas válidas (medição 23/08/2026)", () => {
    const anthropicDef = GEO_PROVIDERS.find((p) => p.id === "anthropic")!;
    assert.equal(anthropicDef.timeoutMs, 270_000);
    assert.ok(anthropicDef.timeoutMs >= 240_000, "deve ficar acima dos 240s que a medição do #5950 ainda viu estourar");
    assert.ok(anthropicDef.timeoutMs > GEO_PROVIDER_TIMEOUT_MS);
    // Google copia o default global EXPLICITAMENTE (timeoutMs é campo
    // obrigatório, achado do type-design review desta PR — nenhum provider
    // novo pode herdar um timeout em silêncio).
    assert.equal(GEO_PROVIDERS.find((p) => p.id === "google")!.timeoutMs, GEO_PROVIDER_TIMEOUT_MS);
  });

  it("#8064: OpenAI usa gpt-5-mini, com timeout próprio acima do default", () => {
    const openaiDef = GEO_PROVIDERS.find((p) => p.id === "openai")!;
    assert.equal(openaiDef.defaultModel, "gpt-5-mini");
    assert.equal(openaiDef.timeoutMs, OPENAI_GEO_TIMEOUT_MS);
    assert.ok(openaiDef.timeoutMs > GEO_PROVIDER_TIMEOUT_MS);
  });

  it("#8064: request do gpt-5-mini manda reasoning.effort low; gpt-4.1 não manda reasoning (rejeitaria)", () => {
    const openaiDef = GEO_PROVIDERS.find((p) => p.id === "openai")!;
    const bodyOf = (model: string) => JSON.parse(String(openaiDef.buildRequest("q", "k", model).init.body));
    assert.deepEqual(bodyOf("gpt-5-mini").reasoning, { effort: "low" });
    assert.deepEqual(bodyOf("gpt-5-mini").tools, [{ type: "web_search" }]);
    assert.equal(bodyOf("gpt-4.1").reasoning, undefined);
    assert.equal(isOpenAiReasoningModel("o4-mini"), true);
    assert.equal(isOpenAiReasoningModel("gpt-4.1-mini"), false);
    assert.equal(isOpenAiReasoningModel("gpt-5-chat-latest"), false);
  });
});

/**
 * classifyHttp429ErrorKind (#8061) — payloads sintéticos fiéis ao formato
 * real documentado das 2 APIs (OpenAI `error.code`, Google `error.status` +
 * `quotaId`), cobrindo os 2 casos que a issue pede: rate-limit comum
 * (segue "http", exit 0 sob --strict) vs. quota/crédito esgotado (vira
 * "quota", exit 1 sob --strict — ver test/geo-citation-monitor-cli.test.ts
 * pro lado de `resolveStrictOutcome`).
 */
describe("classifyHttp429ErrorKind (#8061 — rate-limit vs. quota esgotada)", () => {
  it("OpenAI: error.code 'insufficient_quota' → 'quota'", () => {
    const body = JSON.stringify({
      error: {
        message: "You have no credits remaining. Your organization has been suspended for billing.",
        type: "insufficient_quota",
        param: null,
        code: "insufficient_quota",
      },
    });
    assert.equal(classifyHttp429ErrorKind(body), "quota");
  });

  it("OpenAI: mensagem citando 'no credits' sem o code oficial → ainda 'quota' (fallback textual)", () => {
    const body = JSON.stringify({ error: { message: "You have no credits remaining", type: "insufficient_quota" } });
    assert.equal(classifyHttp429ErrorKind(body), "quota");
  });

  it("OpenAI: rate_limit_exceeded comum (RPM/TPM) → 'http', NUNCA 'quota'", () => {
    const body = JSON.stringify({
      error: {
        message: "Rate limit reached for gpt-5-mini in organization org-abc123 on requests per min (RPM).",
        type: "requests",
        param: null,
        code: "rate_limit_exceeded",
      },
    });
    assert.equal(classifyHttp429ErrorKind(body), "http");
  });

  it("Google/Gemini: RESOURCE_EXHAUSTED com quotaId de quota DIÁRIA ('PerDay') → 'quota'", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message: "You exceeded your current quota, please check your plan and billing details.",
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }],
          },
        ],
      },
    });
    assert.equal(classifyHttp429ErrorKind(body), "quota");
  });

  it("Google/Gemini: RESOURCE_EXHAUSTED de rate-limit por MINUTO (sem 'PerDay') → 'http', NUNCA 'quota'", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message: "You exceeded your current quota, please check your plan and billing details.",
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }],
          },
        ],
      },
    });
    assert.equal(classifyHttp429ErrorKind(body), "http");
  });

  it("corpo não-JSON (truncado/malformado) nunca lança — cai em 'http'", () => {
    assert.equal(classifyHttp429ErrorKind("<html>502 Bad Gateway</html>"), "http");
    assert.equal(classifyHttp429ErrorKind(""), "http");
  });

  it("via queryProvider: 429 de insufficient_quota vira errorKind 'quota' no record de erro (caso real #8061)", async () => {
    const openai = GEO_PROVIDERS.find((p) => p.id === "openai")!;
    const fakeFetch = async () =>
      new Response(
        JSON.stringify({
          error: { message: "You have no credits remaining", type: "insufficient_quota", code: "insufficient_quota" },
        }),
        { status: 429 },
      );
    const result = await queryProvider(openai, "pergunta", "fake-key", "gpt-5-mini", fakeFetch);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorKind, "quota");
      assert.equal(result.httpStatus, 429);
    }
  });

  it("via queryProvider: 429 de rate-limit comum continua errorKind 'http' (regressão do comportamento pré-#8061)", async () => {
    const google = GEO_PROVIDERS.find((p) => p.id === "google")!;
    const fakeFetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 429,
            message: "Resource has been exhausted (e.g. check quota).",
            status: "RESOURCE_EXHAUSTED",
          },
        }),
        { status: 429 },
      );
    const result = await queryProvider(google, "pergunta", "fake-key", "gemini-2.5-flash", fakeFetch);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorKind, "http");
      assert.equal(result.httpStatus, 429);
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
    assert.equal(seenModels[0], "claude-haiku-4-5-20251001"); // default do provider (#5951)
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
    // sleepFn no-op (#8341: 500 agora é retentado, ver teste dedicado abaixo)
    // — só pra este teste não esperar o delay real de 1,5s; a asserção aqui
    // é sobre o record FINAL, não sobre quantas chamadas aconteceram.
    const records = await runGeoCitationMonitor(
      { ANTHROPIC_API_KEY: "fake-key" },
      ["pergunta"],
      fakeFetch,
      undefined,
      undefined,
      async () => {},
    );
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

  it("HTTP 5xx (ex: 500) É retentado desde #8341 — sucede na 2ª tentativa", async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      if (calls === 1) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "sem citação" }] }), { status: 200 });
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
    assert.equal(calls, 2, "esperava 2 chamadas: o 500 original + o retry");
    assert.deepEqual(sleeps, [GEO_RATE_LIMIT_RETRY_DELAY_MS]);
    assert.equal(records.length, 1, "1 record final — não 2");
    assert.equal(records[0].error, undefined, "o retry sucedeu, não deve sobrar erro no record");
  });

  it("HTTP 5xx que persiste nas 2 tentativas vira record de erro (sem retry infinito, #8341)", async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return new Response("boom", { status: 503 });
    };
    const records = await runGeoCitationMonitor(
      { ANTHROPIC_API_KEY: "fake-key" },
      ["pergunta"],
      fakeFetch,
      undefined,
      undefined,
      async () => {},
    );
    assert.equal(calls, 2, "1 tentativa original + exatamente 1 retry, nunca mais");
    assert.equal(records.length, 1);
    assert.equal(records[0].errorKind, "http");
    assert.equal(records[0].httpStatus, 503);
  });

  it("erro HTTP não-429/não-5xx (ex: 401/404) NÃO é retentado (#8341 — só transitório entra no retry)", async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return new Response("unauthorized", { status: 401 });
    };
    const records = await runGeoCitationMonitor({ ANTHROPIC_API_KEY: "fake-key" }, ["pergunta"], fakeFetch);
    assert.equal(calls, 1, "401 não é transitório, não deve disparar retry");
    assert.equal(records[0].httpStatus, 401);
  });

  it("erro 'network' (timeout) É retentado desde #8341 — o maior balde de erro medido na auditoria de 18/09", async () => {
    let calls = 0;
    const fakeFetch = async (_url: string, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        // 1ª chamada: rejeita como falha de rede (não timeout do AbortController,
        // pra não depender de timing real).
        throw new Error("ECONNRESET");
      }
      return new Response(JSON.stringify({ content: [{ type: "text", text: "sem citação" }] }), { status: 200 });
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
    assert.equal(calls, 2, "esperava 2 chamadas: a falha de rede original + o retry");
    assert.deepEqual(sleeps, [GEO_RATE_LIMIT_RETRY_DELAY_MS]);
    assert.equal(records.length, 1);
    assert.equal(records[0].error, undefined, "o retry sucedeu, não deve sobrar erro no record");
  });

  it("errorKind 'quota' NUNCA é retentado, mesmo sendo HTTP 429 (#8341 — falha permanente, #8061)", async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          error: { message: "You have no credits remaining", type: "insufficient_quota", code: "insufficient_quota" },
        }),
        { status: 429 },
      );
    };
    const records = await runGeoCitationMonitor(
      { OPENAI_API_KEY: "fake-key" },
      ["pergunta"],
      fakeFetch,
      undefined,
      undefined,
      async () => {
        throw new Error("sleepFn não deveria ser chamado — quota nunca retenta");
      },
    );
    assert.equal(calls, 1, "quota é falha permanente, nunca deve retentar");
    assert.equal(records.length, 1);
    assert.equal(records[0].errorKind, "quota");
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
      "history-300-safeBackup-0001.jsonl",
      "staleness-alarm-state.json",
    ]);
    assert.deepEqual(files, ["history-300-safeBackup-0001.jsonl"]);
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

describe("isRetryableGeoError (#8341)", () => {
  it("network (timeout incluso) é retryable", () => {
    assert.equal(isRetryableGeoError({ ok: false, error: "x", errorKind: "network" }), true);
  });

  it("http 429 é retryable (comportamento pré-existente, #4616)", () => {
    assert.equal(isRetryableGeoError({ ok: false, error: "x", errorKind: "http", httpStatus: 429 }), true);
  });

  it("http 5xx (500, 502, 503) é retryable", () => {
    for (const status of [500, 502, 503]) {
      assert.equal(
        isRetryableGeoError({ ok: false, error: "x", errorKind: "http", httpStatus: status }),
        true,
        `status ${status} deveria ser retryable`,
      );
    }
  });

  it("http 4xx que não é 429 NÃO é retryable (ex: 401, 404)", () => {
    for (const status of [401, 403, 404]) {
      assert.equal(
        isRetryableGeoError({ ok: false, error: "x", errorKind: "http", httpStatus: status }),
        false,
        `status ${status} não deveria ser retryable`,
      );
    }
  });

  it("quota NUNCA é retryable, mesmo sem httpStatus explícito no shape (#8061 — falha permanente)", () => {
    assert.equal(isRetryableGeoError({ ok: false, error: "x", errorKind: "quota", httpStatus: 429 }), false);
  });

  it("parse/extract/provider NÃO são retryable (não são falha de transporte)", () => {
    assert.equal(isRetryableGeoError({ ok: false, error: "x", errorKind: "parse" }), false);
    assert.equal(isRetryableGeoError({ ok: false, error: "x", errorKind: "extract" }), false);
    assert.equal(isRetryableGeoError({ ok: false, error: "x", errorKind: "provider" }), false);
  });
});

describe("errorRatePct (#8341)", () => {
  it("total 0 devolve 0, nunca NaN", () => {
    assert.equal(errorRatePct(0, 0), 0);
  });

  it("arredonda pra 1 casa decimal", () => {
    // 56/171 = 32,7485...% -> 32.7
    assert.equal(errorRatePct(171, 56), 32.7);
  });

  it("0 erros em N consultas dá 0%", () => {
    assert.equal(errorRatePct(24, 0), 0);
  });

  it("100% de erro dá 100", () => {
    assert.equal(errorRatePct(10, 10), 100);
  });
});

describe("detectHighErrorRateProviders (#8341, item 4 da issue)", () => {
  it("não reporta provider abaixo do limiar", () => {
    const byProvider = { google: { total: 146, cited: 5, errors: 24 } }; // 16,4%
    assert.deepEqual(detectHighErrorRateProviders(byProvider, GEO_ERROR_RATE_ALARM_THRESHOLD_PCT), []);
  });

  it("reporta provider igual/acima do limiar, ordenado por taxa desc", () => {
    const byProvider = {
      anthropic: { total: 171, cited: 8, errors: 69 }, // 40,4%
      openai: { total: 176, cited: 0, errors: 50 }, // 28,4%
      google: { total: 146, cited: 5, errors: 24 }, // 16,4%
    };
    const result = detectHighErrorRateProviders(byProvider, 25);
    assert.deepEqual(
      result.map((r) => r.provider),
      ["anthropic", "openai"],
    );
    assert.equal(result[0].errorRatePct, 40.4);
  });

  it("provider com total 0 nunca entra (sem consulta, sem taxa a medir)", () => {
    const byProvider = { anthropic: { total: 0, cited: 0, errors: 0 } };
    assert.deepEqual(detectHighErrorRateProviders(byProvider, 0), []);
  });
});

describe("deriveEffectiveErrorKind (#8341, item 1 da issue — reclassificação SÓ NA LEITURA)", () => {
  it("reclassifica http 429 histórico (pré-#8061) cujo corpo já indicava cota esgotada", () => {
    const record = {
      errorKind: "http" as const,
      httpStatus: 429,
      error: 'HTTP 429: {"error":{"message":"You have no credits remaining","type":"insufficient_quota","code":"insufficient_quota"}}',
    };
    assert.equal(deriveEffectiveErrorKind(record), "quota");
  });

  it("mantém http 429 de rate-limit comum como 'http' (não reclassifica sem sinal de quota)", () => {
    const record = { errorKind: "http" as const, httpStatus: 429, error: "HTTP 429: rate limited" };
    assert.equal(deriveEffectiveErrorKind(record), "http");
  });

  it("registro já gravado como 'quota' (pós-#8061) passa intacto", () => {
    const record = { errorKind: "quota" as const, httpStatus: 429, error: "HTTP 429: no credits" };
    assert.equal(deriveEffectiveErrorKind(record), "quota");
  });

  it("errorKind não-http/não-429 passa intacto (network, parse, extract, provider, undefined)", () => {
    assert.equal(deriveEffectiveErrorKind({ errorKind: "network", httpStatus: undefined, error: "timeout" }), "network");
    assert.equal(deriveEffectiveErrorKind({ errorKind: undefined, httpStatus: undefined, error: undefined }), undefined);
  });

  it("http não-429 (ex: 500) passa intacto, nunca reclassificado como quota", () => {
    const record = { errorKind: "http" as const, httpStatus: 500, error: "HTTP 500: boom" };
    assert.equal(deriveEffectiveErrorKind(record), "http");
  });

  /**
   * Achado de self-review desta PR: `record.error` guarda o formato
   * "HTTP 429: <body>" (ver `queryProvider`) — passar a string INTEIRA pra
   * `classifyHttp429ErrorKind` faz `JSON.parse` falhar sempre (o prefixo
   * "HTTP 429: " não é JSON válido), quebrando os 2 caminhos de
   * classificação por `code`/`status` (só o fallback textual "no credits"
   * sobreviveria por acidente). `deriveEffectiveErrorKind` precisa
   * REMOVER o prefixo antes de classificar — este teste prova o caso que
   * dependeria do `code` OpenAI (não só da mensagem) e o caso Google
   * PerDay, que dependem de `JSON.parse` bem-sucedido.
   */
  it("reclassifica via error.code (não só via texto 'no credits') mesmo com o prefixo 'HTTP 429: ' no error armazenado", () => {
    const record = {
      errorKind: "http" as const,
      httpStatus: 429,
      error: 'HTTP 429: {"error":{"code":"insufficient_quota","type":"insufficient_quota","message":"billing hard limit reached"}}',
    };
    assert.equal(deriveEffectiveErrorKind(record), "quota", "deveria classificar via error.code, sem depender do texto 'no credits'");
  });

  it("reclassifica Google/Gemini RESOURCE_EXHAUSTED com quotaId PerDay mesmo com o prefixo 'HTTP 429: '", () => {
    const body = JSON.stringify({
      error: {
        status: "RESOURCE_EXHAUSTED",
        message: "You exceeded your current quota, please check your plan and billing details.",
        details: [
          {
            violations: [
              { quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" },
            ],
          },
        ],
      },
    });
    const record = { errorKind: "http" as const, httpStatus: 429, error: `HTTP 429: ${body}` };
    assert.equal(deriveEffectiveErrorKind(record), "quota");
  });

  it("Google/Gemini RESOURCE_EXHAUSTED de rate-limit por MINUTO (sem PerDay) permanece 'http', mesmo com o prefixo", () => {
    const body = JSON.stringify({
      error: {
        status: "RESOURCE_EXHAUSTED",
        message: "You exceeded your current quota, please check your plan and billing details.",
        details: [
          {
            violations: [
              { quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" },
            ],
          },
        ],
      },
    });
    const record = { errorKind: "http" as const, httpStatus: 429, error: `HTTP 429: ${body}` };
    assert.equal(deriveEffectiveErrorKind(record), "http");
  });
});

describe("summarizeHistoryByProviderReclassified (#8341, item 3 da issue)", () => {
  it("agrega citadas/válidas com denominador correto — reproduz o cenário da auditoria de 18/09/2026", () => {
    // Reproduz o achado da issue: OpenAI tinha 48 erros HTTP 429 que na
    // verdade eram cota esgotada (registrados como "http" pré-#8061) — a
    // leitura reclassificada deve mostrar 0 erros de rate-limit "http" e 48
    // de "quota", com o denominador de citação sendo só as válidas.
    const records: Array<Pick<GeoCitationRecord, "provider" | "cited" | "errorKind" | "httpStatus" | "error">> = [
      // 3 consultas válidas, 0 citaram.
      { provider: "openai", cited: false, errorKind: undefined, httpStatus: undefined, error: undefined },
      { provider: "openai", cited: false, errorKind: undefined, httpStatus: undefined, error: undefined },
      { provider: "openai", cited: false, errorKind: undefined, httpStatus: undefined, error: undefined },
      // 2 erros de quota histórica (gravados como "http"+429, corpo de cota).
      {
        provider: "openai",
        cited: false,
        errorKind: "http",
        httpStatus: 429,
        error: 'HTTP 429: {"error":{"code":"insufficient_quota","message":"You have no credits remaining"}}',
      },
      {
        provider: "openai",
        cited: false,
        errorKind: "http",
        httpStatus: 429,
        error: 'HTTP 429: {"error":{"code":"insufficient_quota","message":"You have no credits remaining"}}',
      },
    ];
    const rows = summarizeHistoryByProviderReclassified(records);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.provider, "openai");
    assert.equal(row.total, 5);
    assert.equal(row.valid, 3);
    assert.equal(row.errors, 2);
    assert.equal(row.quotaErrors, 2, "os 2 erros deveriam reclassificar pra quota, não ficar como http/rate-limit");
    assert.equal(row.cited, 0);
    assert.equal(row.errorRatePct, 40);
    assert.equal(row.validCitationRatePct, 0);
  });

  it("valid 0 (todas as consultas deram erro) dá validCitationRatePct 0, nunca NaN", () => {
    const records: Array<Pick<GeoCitationRecord, "provider" | "cited" | "errorKind" | "httpStatus" | "error">> = [
      { provider: "anthropic", cited: false, errorKind: "network", httpStatus: undefined, error: "timeout" },
    ];
    const rows = summarizeHistoryByProviderReclassified(records);
    assert.equal(rows[0].valid, 0);
    assert.equal(rows[0].validCitationRatePct, 0);
  });

  it("multi-provider sai ordenado alfabeticamente", () => {
    const records: Array<Pick<GeoCitationRecord, "provider" | "cited" | "errorKind" | "httpStatus" | "error">> = [
      { provider: "openai", cited: true, errorKind: undefined, httpStatus: undefined, error: undefined },
      { provider: "anthropic", cited: false, errorKind: undefined, httpStatus: undefined, error: undefined },
      { provider: "google", cited: false, errorKind: undefined, httpStatus: undefined, error: undefined },
    ];
    const rows = summarizeHistoryByProviderReclassified(records);
    assert.deepEqual(
      rows.map((r) => r.provider),
      ["anthropic", "google", "openai"],
    );
  });
});
