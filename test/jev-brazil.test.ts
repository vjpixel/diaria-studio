/**
 * test/jev-brazil.test.ts (#9552 — sucede test/jev-actor-brazil.test.ts do #8504)
 *
 * Cobre `scripts/lib/jev-brazil.ts` (pergunta Brasil, fail-soft) e
 * `applyJevBrazilSignal` (`scripts/collect-monthly.ts`), o elo que liga o
 * `brazil_p` à coleta do mensal e do anual. NENHUM teste chama a rede real —
 * todos injetam `fetchImpl`.
 *
 * Regressão central (#9552): antes, `resolveBrazilSignal()` recebia sempre
 * `undefined` na coleta e o mensal decidia Brasil pelo regex, que marca
 * Brasil por domínio .com.br em matéria sem Brasil nenhum. O caso
 * "cnnbrasil + Austrália" abaixo é um dos exemplos reais da avaliação #9531.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyBrazil, describeJevError, fetchBrazilProbabilities } from "../scripts/lib/jev-brazil.ts";
import { JevHttpError } from "../scripts/lib/jev.ts";
import {
  applyJevBrazilSignal,
  detectBrazil,
  JEV_BRAZIL_THRESHOLD,
  type BrazilSignalFields,
} from "../scripts/collect-monthly.ts";
import { ACTOR_BRAZIL_8416_BRAZIL } from "../scripts/lib/jev-questions.ts";

let tmpDir: string;
let prevKey: string | undefined;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "jev-brazil-test-"));
  prevKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (prevKey !== undefined) process.env.TYPESAFE_API_KEY = prevKey;
  else delete process.env.TYPESAFE_API_KEY;
});

function brazilResponse(p: number): Response {
  return new Response(JSON.stringify({ answers: { brazil: { type: "noul", noul: p, confidence: 0.95 } } }), {
    status: 200,
  });
}

/** fetch que responde `brazil_p` conforme o título do state enviado. */
function fetchByTitle(byTitle: Record<string, number>, seen?: unknown[]): typeof fetch {
  return (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { state: { title: string }; questions: Record<string, unknown> };
    seen?.push(body);
    const p = byTitle[body.state.title];
    if (p === undefined) return new Response("erro", { status: 500 });
    return brazilResponse(p);
  }) as unknown as typeof fetch;
}

function runLog(): string {
  const p = join(tmpDir, "data", "run-log.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

// Exemplos reais da avaliação pareada #9531: regex marca Brasil pelo domínio.
function fixtures(): BrazilSignalFields[] {
  return [
    {
      edition: "260910",
      position: 1,
      category: "GEOPOLÍTICA",
      title: "Após ataque de IA, Austrália convoca CEOs da OpenAI e da Anthropic",
      url: "https://www.cnnbrasil.com.br/internacional/australia-ceos-ia/",
      body: "O governo australiano convocou executivos das empresas de IA.",
      is_brazil: false,
      brazil_signals: [],
    },
    {
      edition: "260910",
      position: 2,
      category: "REGULAÇÃO",
      title: "ANPD abre consulta sobre IA generativa",
      url: "https://example.org/anpd",
      body: "A autoridade brasileira de dados abriu consulta pública.",
      is_brazil: false,
      brazil_signals: [],
    },
  ].map((d) => {
    const r = detectBrazil(d);
    return { ...d, is_brazil: r.is_brazil, brazil_signals: r.signals };
  });
}

// ---------------------------------------------------------------------------
// classifyBrazil — transporte
// ---------------------------------------------------------------------------

describe("classifyBrazil", () => {
  it("pergunta SÓ a pergunta Brasil do #8416 (ator aposentado no #9551) e lê a chave `noul`", async () => {
    const seen: unknown[] = [];
    const { probabilities, applied } = await classifyBrazil(
      [{ id: "i1", url: "https://a.example/1", title: "t", summary: "s" }],
      { apiKey: "fake-key", fetchImpl: fetchByTitle({ t: 0.12 }, seen) },
    );
    assert.equal(applied, true);
    assert.equal(probabilities.get("i1"), 0.12);
    const body = seen[0] as { questions: Record<string, { instructions: string }> };
    assert.deepEqual(Object.keys(body.questions), ["brazil"]);
    assert.equal(body.questions.brazil.instructions, ACTOR_BRAZIL_8416_BRAZIL.question.instructions);
  });

  it("falha total de transporte -> applied:false, mapa vazio (nunca lança)", async () => {
    const fetchImpl = (async () => new Response("erro", { status: 500 })) as unknown as typeof fetch;
    const { probabilities, applied } = await classifyBrazil(
      [{ id: "i1", url: "https://a.example/1", title: "t", summary: "s" }],
      { apiKey: "fake-key", fetchImpl },
    );
    assert.equal(applied, false);
    assert.equal(probabilities.size, 0);
  });

  it("lista vazia -> applied:true, sem chamar a rede", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return brazilResponse(0.1);
    }) as unknown as typeof fetch;
    const { applied } = await classifyBrazil([], { apiKey: "fake-key", fetchImpl });
    assert.equal(applied, true);
    assert.equal(called, false);
  });
});

describe("fetchBrazilProbabilities — fail-soft", () => {
  it("TYPESAFE_API_KEY ausente -> no-key, sem rede, warn no run-log", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return brazilResponse(0.9);
    }) as unknown as typeof fetch;
    const r = await fetchBrazilProbabilities([{ id: "i1", url: "u", title: "t", summary: "s" }], {
      fetchImpl,
      rootDir: tmpDir,
      agent: "collect-monthly",
    });
    assert.equal(r.reason, "no-key");
    assert.equal(r.applied, false);
    assert.equal(called, false);
    assert.match(runLog(), /TYPESAFE_API_KEY ausente/);
    assert.match(runLog(), /"level":"warn"/);
  });

  it("API fora -> transport, warn no run-log", async () => {
    const fetchImpl = (async () => new Response("erro", { status: 503 })) as unknown as typeof fetch;
    const r = await fetchBrazilProbabilities([{ id: "i1", url: "u", title: "t", summary: "s" }], {
      apiKey: "k",
      fetchImpl,
      rootDir: tmpDir,
    });
    assert.equal(r.reason, "transport");
    assert.match(runLog(), /Jev indisponível/);
  });

  it("falha parcial -> ok com os que responderam, warn com a contagem", async () => {
    const r = await fetchBrazilProbabilities(
      [
        { id: "a", url: "u1", title: "t1", summary: "s" },
        { id: "b", url: "u2", title: "t2", summary: "s" },
      ],
      { apiKey: "k", fetchImpl: fetchByTitle({ t1: 0.7 }), rootDir: tmpDir },
    );
    assert.equal(r.reason, "ok");
    assert.equal(r.probabilities.get("a"), 0.7);
    assert.equal(r.probabilities.has("b"), false);
    assert.match(runLog(), /1\/2 item/);
    // #9558: amostra dos erros por item, com status.
    assert.match(runLog(), /b: HTTP 500/);
  });

  it("regressão #9558: key revogada (401) -> reason auth, detail com o status, warn de credencial — nunca a key", async () => {
    const secret = "sk-test-SEGREDO-123";
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      // Corpo que ecoa a credencial: a redação precisa mascarar.
      return new Response(`{"error":"invalid api key ${secret}","auth":"Bearer ${secret}"}`, { status: 401 });
    }) as unknown as typeof fetch;
    const r = await fetchBrazilProbabilities(
      [
        { id: "i1", url: "u1", title: "t1", summary: "s" },
        { id: "i2", url: "u2", title: "t2", summary: "s" },
      ],
      { apiKey: secret, fetchImpl, rootDir: tmpDir, agent: "collect-monthly" },
    );
    assert.ok(calls > 0);
    assert.equal(r.applied, false);
    assert.equal(r.reason, "auth");
    assert.match(r.detail ?? "", /HTTP 401/);
    assert.ok(!(r.detail ?? "").includes(secret), "detail não pode carregar a key");
    const log = runLog();
    assert.match(log, /recusou a credencial/);
    assert.match(log, /HTTP 401/);
    assert.match(log, /"reason":"auth"/);
    assert.doesNotMatch(log, /Jev indisponível/, "401 não é queda temporária");
    assert.ok(!log.includes(secret), "run-log não pode carregar a key");
  });

  it("#9558: 403 também é auth; 503 continua transport, com o status no detail", async () => {
    const forbidden = (async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    const r403 = await fetchBrazilProbabilities([{ id: "i1", url: "u", title: "t", summary: "s" }], {
      apiKey: "k",
      fetchImpl: forbidden,
      rootDir: tmpDir,
    });
    assert.equal(r403.reason, "auth");
    const down = (async () => new Response("erro", { status: 503 })) as unknown as typeof fetch;
    const r503 = await fetchBrazilProbabilities([{ id: "i1", url: "u", title: "t", summary: "s" }], {
      apiKey: "k",
      fetchImpl: down,
      rootDir: tmpDir,
    });
    assert.equal(r503.reason, "transport");
    assert.match(r503.detail ?? "", /HTTP 503/);
    assert.match(runLog(), /Jev indisponível \(HTTP 503/);
  });

  it("#9558: erro de rede (sem status) -> transport com a mensagem", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET socket hang up");
    }) as unknown as typeof fetch;
    const r = await fetchBrazilProbabilities([{ id: "i1", url: "u", title: "t", summary: "s" }], {
      apiKey: "k",
      fetchImpl,
      rootDir: tmpDir,
    });
    assert.equal(r.reason, "transport");
    assert.match(r.detail ?? "", /ECONNRESET/);
  });
});

describe("describeJevError (#9558)", () => {
  it("mascara a key e Bearer, trunca mensagem longa, preserva status de JevHttpError", () => {
    const info = describeJevError(new JevHttpError(401, `key abc123 Bearer abc123 ${"x".repeat(400)}`), "abc123");
    assert.equal(info.status, 401);
    assert.ok(!info.message.includes("abc123"));
    assert.ok(info.message.length <= 201);
    assert.equal(describeJevError("falhou").status, undefined);
  });
});

// ---------------------------------------------------------------------------
// applyJevBrazilSignal — o elo com a coleta mensal/anual (#9552)
// ---------------------------------------------------------------------------

describe("applyJevBrazilSignal — off ⇒ idêntico ao detectBrazil()", () => {
  it("sem key: destaques ficam deep-equal ao resultado do detectBrazil()", async () => {
    const items = fixtures();
    const before = structuredClone(items);
    const summary = await applyJevBrazilSignal(items, { rootDir: tmpDir });
    assert.deepEqual(items, before);
    assert.deepEqual(summary, {
      applied: false,
      reason: "no-key",
      total: 2,
      annotated: 0,
      changed: 0,
      threshold: JEV_BRAZIL_THRESHOLD,
    });
  });

  it("API fora: destaques ficam deep-equal ao resultado do detectBrazil()", async () => {
    const items = fixtures();
    const before = structuredClone(items);
    const fetchImpl = (async () => new Response("erro", { status: 500 })) as unknown as typeof fetch;
    const summary = await applyJevBrazilSignal(items, { apiKey: "k", fetchImpl, rootDir: tmpDir });
    assert.deepEqual(items, before);
    assert.equal(summary.reason, "transport");
    assert.match(summary.detail ?? "", /HTTP 500/, "#9558: brazil_jev.detail carrega o motivo");
  });

  it("#9558: key revogada chega ao resumo brazil_jev como auth", async () => {
    const items = fixtures();
    const fetchImpl = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    const summary = await applyJevBrazilSignal(items, { apiKey: "k", fetchImpl, rootDir: tmpDir });
    assert.equal(summary.reason, "auth");
    assert.match(summary.detail ?? "", /HTTP 401/);
  });
});

describe("applyJevBrazilSignal — Jev decide", () => {
  it("regressão #9552: matéria da Austrália em cnnbrasil deixa de ser Brasil; ANPD continua", async () => {
    const items = fixtures();
    assert.equal(items[0].is_brazil, true, "pré-condição: o regex marca Brasil pelo domínio");
    const fetchImpl = fetchByTitle({ [items[0].title]: 0.04, [items[1].title]: 0.97 });
    const summary = await applyJevBrazilSignal(items, { apiKey: "k", fetchImpl, rootDir: tmpDir });

    assert.equal(items[0].is_brazil, false);
    assert.equal(items[0].brazil_p, 0.04);
    assert.deepEqual(items[0].brazil_signals, ["jev:brazil_p=0.04"]);
    assert.ok(items[0].brazil_regex_signals?.some((s) => s.startsWith("host:")), "sinais do regex guardados pra conferência no gate");

    assert.equal(items[1].is_brazil, true);
    assert.equal(items[1].brazil_p, 0.97);

    assert.deepEqual(summary, {
      applied: true,
      reason: "ok",
      total: 2,
      annotated: 2,
      changed: 1,
      threshold: JEV_BRAZIL_THRESHOLD,
    });
  });

  it("limiar é inclusivo (brazil_p == JEV_BRAZIL_THRESHOLD → Brasil)", async () => {
    const items = fixtures().slice(0, 1);
    await applyJevBrazilSignal(items, {
      apiKey: "k",
      fetchImpl: fetchByTitle({ [items[0].title]: JEV_BRAZIL_THRESHOLD }),
      rootDir: tmpDir,
    });
    assert.equal(items[0].is_brazil, true);
  });

  it("falha parcial: item sem resposta mantém o detectBrazil(), sem brazil_p", async () => {
    const items = fixtures();
    const before1 = structuredClone(items[1]);
    await applyJevBrazilSignal(items, {
      apiKey: "k",
      fetchImpl: fetchByTitle({ [items[0].title]: 0.1 }),
      rootDir: tmpDir,
    });
    assert.equal(items[0].brazil_p, 0.1);
    assert.deepEqual(items[1], before1);
  });

  it("mesmo URL em duas posições recebe respostas independentes (id por posição, não por URL)", async () => {
    const base = fixtures()[0];
    const items = [
      { ...base, position: 1 },
      { ...base, edition: "260911", position: 1 },
    ];
    const summary = await applyJevBrazilSignal(items, {
      apiKey: "k",
      fetchImpl: fetchByTitle({ [base.title]: 0.2 }),
      rootDir: tmpDir,
    });
    assert.equal(summary.annotated, 2);
    assert.ok(items.every((d) => d.brazil_p === 0.2));
  });
});
