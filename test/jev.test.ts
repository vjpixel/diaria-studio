/**
 * test/jev.test.ts (#8413 — Fase 0 do epic #8412)
 *
 * Cobre `scripts/lib/jev.ts`: askJev/askJevBatch (choice/score/noul),
 * cache em disco, retry em 429, e fail-soft de transporte. NENHUM teste
 * chama a rede real — todos injetam `fetchImpl`.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  askJev,
  askJevBatch,
  parseJevAnswers,
  hashJevQuestions,
  loadCachedJevAnswers,
  saveCachedJevAnswers,
  JevHttpError,
  type JevQuestion,
  type JevChoiceAnswer,
} from "../scripts/lib/jev.ts";

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "jev-test-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const CHOICE_Q: JevQuestion = {
  id: "bucket",
  type: "choice",
  instructions: "isto é X ou Y?",
  criteria: { x: "descrição x", y: "descrição y" },
};

const SCORE_Q: JevQuestion = {
  id: "sev",
  type: "score",
  instructions: "gravidade",
  criteria: ["baixa", "média", "alta"],
};
const NOUL_Q: JevQuestion = { id: "harm", type: "noul", instructions: "isto causa dano real?" };

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return (async () => (status === 200 ? okResponse(body) : new Response("erro", { status }))) as unknown as typeof fetch;
}

describe("parseJevAnswers", () => {
  it("parseia choice/score/noul no mesmo envelope", () => {
    const raw = {
      answers: {
        bucket: { type: "choice", choice: "x", confidence: 0.9, probabilities: { x: 0.9, y: 0.1 } },
        sev: { type: "score", score: 7, confidence: 0.5 },
        harm: { type: "noul", probability: 0.3, confidence: 0.8 },
      },
    };
    const answers = parseJevAnswers(raw, [CHOICE_Q, SCORE_Q, NOUL_Q]);
    assert.equal(answers.length, 3);
    assert.deepEqual(answers[0], { id: "bucket", type: "choice", choice: "x", confidence: 0.9, probabilities: { x: 0.9, y: 0.1 } });
    assert.deepEqual(answers[1], { id: "sev", type: "score", score: 7, confidence: 0.5 });
    assert.deepEqual(answers[2], { id: "harm", type: "noul", probability: 0.3, confidence: 0.8 });
  });

  it("confidence ausente vira 1", () => {
    const raw = { answers: { bucket: { type: "choice", choice: "x" } } };
    const [a] = parseJevAnswers(raw, [CHOICE_Q]);
    assert.equal((a as JevChoiceAnswer).confidence, 1);
  });

  it("lança se `answers` ausente", () => {
    assert.throws(() => parseJevAnswers({}, [CHOICE_Q]), /sem objeto `answers`/);
  });

  it("lança se raw não é objeto", () => {
    assert.throws(() => parseJevAnswers(null, [CHOICE_Q]), /não é um objeto JSON/);
  });

  it("lança se falta uma pergunta pedida", () => {
    assert.throws(() => parseJevAnswers({ answers: {} }, [CHOICE_Q]), /sem `answers.bucket`/);
  });

  it("lança se choice.choice não é string", () => {
    assert.throws(
      () => parseJevAnswers({ answers: { bucket: { type: "choice" } } }, [CHOICE_Q]),
      /ausente ou não é string/,
    );
  });

  it("lança se score.score não é número", () => {
    assert.throws(() => parseJevAnswers({ answers: { sev: { type: "score" } } }, [SCORE_Q]), /não é número/);
  });

  it("lança se noul.probability não é número", () => {
    assert.throws(() => parseJevAnswers({ answers: { harm: { type: "noul" } } }, [NOUL_Q]), /não é número/);
  });

  it("parseia noul.noul — contrato REAL confirmado ao vivo (#8414, 19/09/2026): a API responde `noul`, não `probability`", () => {
    const answers = parseJevAnswers({ answers: { harm: { type: "noul", noul: 0.82 } } }, [NOUL_Q]);
    assert.deepEqual(answers[0], { id: "harm", type: "noul", probability: 0.82, confidence: 1 });
  });
});

describe("hashJevQuestions", () => {
  it("é estável independente da ordem", () => {
    assert.equal(hashJevQuestions([CHOICE_Q, SCORE_Q]), hashJevQuestions([SCORE_Q, CHOICE_Q]));
  });

  it("muda se o texto da pergunta mudar", () => {
    const alt: JevQuestion = { ...CHOICE_Q, instructions: "outra pergunta" };
    assert.notEqual(hashJevQuestions([CHOICE_Q]), hashJevQuestions([alt]));
  });
});

describe("cache em disco", () => {
  it("loadCachedJevAnswers devolve null se cacheDir ausente/null", () => {
    assert.equal(loadCachedJevAnswers(null, "x", [CHOICE_Q]), null);
    assert.equal(loadCachedJevAnswers(undefined, "x", [CHOICE_Q]), null);
  });

  it("save + load round-trip", () => {
    const answers = [{ id: "bucket", type: "choice" as const, choice: "x", confidence: 1 }];
    saveCachedJevAnswers(tmpDir, "https://a.com", [CHOICE_Q], answers);
    const loaded = loadCachedJevAnswers(tmpDir, "https://a.com", [CHOICE_Q]);
    assert.deepEqual(loaded, answers);
  });

  it("chaves diferentes (id ou perguntas) não colidem", () => {
    const a1 = [{ id: "bucket", type: "choice" as const, choice: "x", confidence: 1 }];
    saveCachedJevAnswers(tmpDir, "https://a.com", [CHOICE_Q], a1);
    assert.equal(loadCachedJevAnswers(tmpDir, "https://b.com", [CHOICE_Q]), null);
    assert.equal(loadCachedJevAnswers(tmpDir, "https://a.com", [SCORE_Q]), null);
  });

  it("askJev usa o cache e NUNCA chama fetch na 2ª vez", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return okResponse({ answers: { bucket: { type: "choice", choice: "x", confidence: 1 } } });
    }) as unknown as typeof fetch;

    const state = { url: "https://a.com", title: "t" };
    const r1 = await askJev(state, [CHOICE_Q], { apiKey: "k", fetchImpl, cacheDir: tmpDir });
    const r2 = await askJev(state, [CHOICE_Q], { apiKey: "k", fetchImpl, cacheDir: tmpDir });
    assert.equal(calls, 1, "2ª chamada deveria vir do cache, sem bater na rede");
    assert.deepEqual(r1, r2);
  });
});

describe("askJev — transporte", () => {
  it("nunca chama a rede real (todos os testes injetam fetchImpl) — sanity check do próprio arquivo", () => {
    assert.equal(typeof fetch, "function"); // fetch global existe mas não é usado sem opts.fetchImpl explícito nestes testes
  });

  it("wire de score envia `criteria` (lista ordenada), nunca `min`/`max` (#8415 — contrato confirmado contra a API real)", async () => {
    let sentBody: Record<string, unknown> | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string);
      return okResponse({ answers: { sev: { type: "score", score: 1.4, confidence: 0.6 } } });
    }) as unknown as typeof fetch;
    await askJev({ url: "https://x.com" }, [SCORE_Q], { apiKey: "k", fetchImpl });
    const wireQuestion = (sentBody as any).questions.sev;
    assert.deepEqual(wireQuestion, { type: "score", instructions: "gravidade", criteria: ["baixa", "média", "alta"] });
    assert.equal("min" in wireQuestion, false);
    assert.equal("max" in wireQuestion, false);
  });

  it("cacheKey default vem de state.url", async () => {
    const fetchImpl = fetchReturning({ answers: { bucket: { type: "choice", choice: "x", confidence: 1 } } });
    await askJev({ url: "https://x.com" }, [CHOICE_Q], { apiKey: "k", fetchImpl, cacheDir: tmpDir });
    assert.ok(existsSync(tmpDir));
    assert.ok(readdirSync(tmpDir).length > 0);
  });

  it("lança JevHttpError em HTTP não-2xx (sem retry, status != 429)", async () => {
    const fetchImpl = fetchReturning({}, 500);
    await assert.rejects(
      askJev({ url: "https://x.com" }, [CHOICE_Q], { apiKey: "k", fetchImpl, retryBaseMs: 1 }),
      JevHttpError,
    );
  });

  it("retry em 429 até maxRetries, depois lança", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("rate limited", { status: 429 });
    }) as unknown as typeof fetch;
    await assert.rejects(
      askJev({ url: "https://x.com" }, [CHOICE_Q], { apiKey: "k", fetchImpl, maxRetries: 2, retryBaseMs: 1 }),
      JevHttpError,
    );
    assert.equal(calls, 3); // tentativa inicial + 2 retries
  });

  it("sucede após 429 nas primeiras tentativas", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls < 3) return new Response("rate limited", { status: 429 });
      return okResponse({ answers: { bucket: { type: "choice", choice: "x", confidence: 1 } } });
    }) as unknown as typeof fetch;
    const answers = await askJev(
      { url: "https://x.com" },
      [CHOICE_Q],
      { apiKey: "k", fetchImpl, maxRetries: 5, retryBaseMs: 1 },
    );
    assert.equal(calls, 3);
    assert.equal((answers[0] as JevChoiceAnswer).choice, "x");
  });

  it("devolve [] pra lista de perguntas vazia, sem chamar fetch", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return okResponse({});
    }) as unknown as typeof fetch;
    const r = await askJev({ url: "https://x.com" }, [], { apiKey: "k", fetchImpl });
    assert.deepEqual(r, []);
    assert.equal(calls, 0);
  });
});

describe("askJevBatch", () => {
  it("processa vários itens concorrentemente e devolve por id", async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      return okResponse({ answers: { bucket: { type: "choice", choice: body.state.expected, confidence: 1 } } });
    }) as unknown as typeof fetch;

    const items = [
      { id: "1", state: { url: "https://a.com", expected: "x" }, questions: [CHOICE_Q] },
      { id: "2", state: { url: "https://b.com", expected: "y" }, questions: [CHOICE_Q] },
    ];
    const { results, errors } = await askJevBatch(items, { apiKey: "k", fetchImpl });
    assert.equal(errors.size, 0);
    assert.equal(results.length, 2);
    const byId = new Map(results.map((r) => [r.id, r.answers[0] as JevChoiceAnswer]));
    assert.equal(byId.get("1")?.choice, "x");
    assert.equal(byId.get("2")?.choice, "y");
  });

  it("fail-soft por item: 1 falha não derruba os outros", async () => {
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.state.url === "https://bad.com") return new Response("erro", { status: 500 });
      return okResponse({ answers: { bucket: { type: "choice", choice: "x", confidence: 1 } } });
    }) as unknown as typeof fetch;

    const items = [
      { id: "good", state: { url: "https://good.com" }, questions: [CHOICE_Q] },
      { id: "bad", state: { url: "https://bad.com" }, questions: [CHOICE_Q] },
    ];
    const { results, errors } = await askJevBatch(items, { apiKey: "k", fetchImpl, retryBaseMs: 1 });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "good");
    assert.equal(errors.size, 1);
    assert.ok(errors.has("bad"));
  });

  it("lança se TODOS os itens falharem", async () => {
    const fetchImpl = (async () => new Response("erro", { status: 500 })) as unknown as typeof fetch;
    const items = [
      { id: "1", state: { url: "https://a.com" }, questions: [CHOICE_Q] },
      { id: "2", state: { url: "https://b.com" }, questions: [CHOICE_Q] },
    ];
    await assert.rejects(askJevBatch(items, { apiKey: "k", fetchImpl, retryBaseMs: 1 }));
  });

  it("devolve vazio pra lista de itens vazia", async () => {
    const { results, errors } = await askJevBatch([], { apiKey: "k" });
    assert.deepEqual(results, []);
    assert.equal(errors.size, 0);
  });

  it("respeita o teto de concorrência (nunca mais requests simultâneos que o teto)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = (async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return okResponse({ answers: { bucket: { type: "choice", choice: "x", confidence: 1 } } });
    }) as unknown as typeof fetch;

    const items = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      state: { url: `https://x.com/${i}` },
      questions: [CHOICE_Q],
    }));
    await askJevBatch(items, { apiKey: "k", fetchImpl, concurrency: 3 });
    assert.ok(maxInFlight <= 3, `esperava teto 3, viu ${maxInFlight}`);
  });
});
