/**
 * threads-carousel-parent-retry-13100.test.ts (#13100)
 *
 * Retro semanal 261114 (`weekly-clicked`) no Threads: 7 filhos criados e
 * `FINISHED`, e a criação do container PAI devolveu um único HTTP 400
 * "Invalid parameter". O Worker mandou o post direto pra DLQ, sem 2ª
 * tentativa, e guardou só o `message` da Meta (sem code/subcode/user_msg/
 * fbtrace_id), o que deixou a falha sem diagnóstico possível depois.
 *
 * Cobre:
 *   - pai falha 1x com o erro real da DLQ e passa na 2ª: publica, reusando os
 *     MESMOS filhos (nenhum filho recriado), com 7 itens como no incidente;
 *   - pai falha em todas as tentativas: DLQ, sem publish, com o teto de
 *     tentativas respeitado e o erro completo de cada tentativa no reason;
 *   - espera entre tentativas = THREADS_CAROUSEL_PARENT_RETRY_MS;
 *   - não repete após timeout do fetch nem em code 190 (auth); 200 sem id
 *     conta como falha;
 *   - `describeThreadsError` inclui code/subcode/user_msg/fbtrace_id.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  fireQueueEntry,
  describeThreadsError,
  THREADS_CAROUSEL_PARENT_MAX_ATTEMPTS,
  THREADS_CAROUSEL_PARENT_RETRY_MS,
  isThreadsParentRetryable,
} from "../src/dispatch.ts";
import type { QueueEntry } from "../src/index.ts";

function bodyOf(init: RequestInit | undefined): string {
  return init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
}

const CONFIG = {
  webhookUrl: "https://make.test/diaria",
  threads: { userId: "acc", accessToken: "tok", apiVersion: "v1.0" },
};

// Legenda e imagens com o mesmo formato do payload da DLQ de 261114.
const CAPTION =
  "As notícias de IA mais lidas da semana na diar.ia.br:\n\n1. Nubank demite time antifraude e põe IA no lugar\n" +
  "2. Claude Code pode ter vazado suas senhas no GitHub\n3. Você filmaria sua faxina para treinar um robô?\n" +
  "4. Denúncia acusa multinacional de barrar engenheiras\n5. ChatGPT e Gemini indicam lojas falsas para você\n\n" +
  "Arquivo completo: https://diar.ia.br/?utm_source=threads&utm_medium=organic_social&utm_campaign=weekly-archive";
const IMAGES = ["cover", "261111-d1", "261112-d1", "261111-d3", "261112-d3", "261113-d2", "cta"].map(
  (s) => `https://eia.diar.ia.br/img/img-unknown-weekly-261114-clicked-${s}-4x5.jpg`,
);

// Corpo de erro da Graph no formato que a Meta devolve pra code 100.
const INVALID_PARAMETER = {
  error: {
    message: "Invalid parameter",
    type: "OAuthException",
    code: 100,
    error_subcode: 4279009,
    error_user_title: "Parâmetro inválido",
    error_user_msg: "Um dos itens do carrossel não pôde ser usado.",
    fbtrace_id: "AbCdEf123",
  },
};

function entry(): QueueEntry {
  return {
    text: CAPTION,
    image_url: null,
    scheduled_at: "2026-11-15T11:00:00-03:00",
    destaque: "weekly-clicked",
    created_at: "2026-11-13T23:30:53.064Z",
    channel: "threads",
    image_urls: IMAGES,
  };
}

describe("#13100 Threads carrossel: criação do container pai repete com os mesmos filhos", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalSetTimeout: typeof globalThis.setTimeout;
  let delays: number[];
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalSetTimeout = globalThis.setTimeout;
    delays = [];
    (globalThis as any).setTimeout = (fn: () => void, ms?: number) => { delays.push(ms ?? 0); fn(); return 0 as any; };
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });

  type ParentResponder = (attempt: number) => Response | Promise<Response>;
  const failThen = (failures: number, fail: () => Response): ParentResponder => (attempt) =>
    attempt <= failures ? fail() : new Response(JSON.stringify({ id: "parent-1" }), { status: 200 });
  const invalidParameter = () => new Response(JSON.stringify(INVALID_PARAMETER), { status: 400 });

  function mockFetch(parent: number | ParentResponder) {
    const respond: ParentResponder = typeof parent === "number" ? failThen(parent, invalidParameter) : parent;
    const calls: Array<{ url: string; body: string }> = [];
    let child = 0;
    let parentAttempts = 0;
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.url;
      const body = bodyOf(init);
      calls.push({ url: u, body });
      if (u.includes("?fields=status")) return new Response(JSON.stringify({ status: "FINISHED" }), { status: 200 });
      if (u.endsWith("/threads_publish")) return new Response(JSON.stringify({ id: "published-1" }), { status: 200 });
      if (u.endsWith("/threads") && body.includes("media_type=CAROUSEL")) {
        parentAttempts++;
        return respond(parentAttempts);
      }
      if (u.endsWith("/threads")) {
        child++;
        return new Response(JSON.stringify({ id: `child-${child}` }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    return { calls, parentAttempts: () => parentAttempts };
  }

  it("1º 400 'Invalid parameter' no pai e sucesso na 2ª: publica, sem recriar filho nenhum", async () => {
    const m = mockFetch(1);
    const outcome = await fireQueueEntry(entry(), CONFIG);
    assert.equal(outcome.status, "fired");
    assert.equal(m.parentAttempts(), 2);

    const childCalls = m.calls.filter((c) => c.url.endsWith("/threads") && c.body.includes("is_carousel_item=true"));
    assert.equal(childCalls.length, 7, "os 7 filhos são criados uma vez só");

    const parentCalls = m.calls.filter((c) => c.url.endsWith("/threads") && c.body.includes("media_type=CAROUSEL"));
    const expectedChildren = Array.from({ length: 7 }, (_, i) => `child-${i + 1}`).join(",");
    for (const p of parentCalls) {
      assert.equal(new URLSearchParams(p.body).get("children"), expectedChildren, "toda tentativa reusa os mesmos filhos");
    }
    const publish = m.calls.find((c) => c.url.endsWith("/threads_publish"));
    assert.match(publish!.body, /creation_id=parent-1/);
    assert.ok(delays.includes(THREADS_CAROUSEL_PARENT_RETRY_MS), "espera entre a 1ª e a 2ª tentativa");
  });

  it("pai falha em todas as tentativas: DLQ, nunca publica, teto respeitado, erro completo no reason", async () => {
    const m = mockFetch(Number.POSITIVE_INFINITY);
    const outcome = await fireQueueEntry(entry(), CONFIG);
    assert.equal(outcome.status, "dlq");
    assert.equal(m.parentAttempts(), THREADS_CAROUSEL_PARENT_MAX_ATTEMPTS);
    assert.ok(THREADS_CAROUSEL_PARENT_MAX_ATTEMPTS > 1, "precisa haver ao menos uma repetição");
    assert.ok(!m.calls.some((c) => c.url.endsWith("/threads_publish")), "nunca publica sem pai");
    const reason = (outcome as { reason: string }).reason;
    assert.match(reason, new RegExp(`container pai falhou após ${THREADS_CAROUSEL_PARENT_MAX_ATTEMPTS} tentativas`));
    const retryWaits = delays.filter((d) => d === THREADS_CAROUSEL_PARENT_RETRY_MS);
    assert.equal(retryWaits.length, THREADS_CAROUSEL_PARENT_MAX_ATTEMPTS - 1, "uma espera entre cada par de tentativas");
    assert.ok(retryWaits.every((d) => d === THREADS_CAROUSEL_PARENT_RETRY_MS));
    assert.match(reason, /code=100/);
    assert.match(reason, /subcode=4279009/);
    assert.match(reason, /Um dos itens do carrossel/);
    assert.match(reason, /fbtrace_id=AbCdEf123/);
    assert.match(reason, /children=child-1,child-2/);
  });

  it("timeout do fetch na 1ª tentativa: não repete, vai pra DLQ", async () => {
    const m = mockFetch(() => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const outcome = await fireQueueEntry(entry(), CONFIG);
    assert.equal(outcome.status, "dlq");
    assert.equal(m.parentAttempts(), 1);
    assert.ok(!delays.includes(THREADS_CAROUSEL_PARENT_RETRY_MS), "sem espera de retry");
    const reason = (outcome as { reason: string }).reason;
    assert.match(reason, /falhou após 1 tentativa:/);
    assert.match(reason, /fetch timeout/);
  });

  it("code 190 (token inválido): não repete, vai pra DLQ", async () => {
    const m = mockFetch(() =>
      new Response(JSON.stringify({ error: { message: "Invalid OAuth access token", type: "OAuthException", code: 190 } }), { status: 400 }),
    );
    const outcome = await fireQueueEntry(entry(), CONFIG);
    assert.equal(outcome.status, "dlq");
    assert.equal(m.parentAttempts(), 1);
    assert.match((outcome as { reason: string }).reason, /code=190/);
  });

  it("200 sem id conta como falha e é repetido", async () => {
    const m = mockFetch(failThen(1, () => new Response(JSON.stringify({}), { status: 200 })));
    const outcome = await fireQueueEntry(entry(), CONFIG);
    assert.equal(outcome.status, "fired");
    assert.equal(m.parentAttempts(), 2);
  });
});

describe("#13100 isThreadsParentRetryable", () => {
  it("repete code 100, 5xx sem corpo de erro e is_transient", () => {
    assert.equal(isThreadsParentRetryable({ code: 100 }), true);
    assert.equal(isThreadsParentRetryable(undefined), true);
    assert.equal(isThreadsParentRetryable({ code: 190, is_transient: true }), true);
  });
  it("não repete auth/permissão nem limite de taxa (#10992)", () => {
    for (const code of [190, 10, 200, 4, 17, 32, 613, 80002]) {
      assert.equal(isThreadsParentRetryable({ code }), false, `code ${code}`);
    }
  });
});

describe("#13100 describeThreadsError", () => {
  it("só message: mantém o texto de antes", () => {
    assert.equal(describeThreadsError({ message: "Invalid parameter" }, "{}"), "Invalid parameter");
  });
  it("erro completo: inclui type, code, subcode, mensagem ao usuário e fbtrace_id", () => {
    assert.equal(
      describeThreadsError(INVALID_PARAMETER.error, ""),
      "Invalid parameter (type=OAuthException, code=100, subcode=4279009) — Parâmetro inválido: Um dos itens do carrossel não pôde ser usado. [fbtrace_id=AbCdEf123]",
    );
  });
  it("message vazio: sem espaço na frente", () => {
    assert.equal(describeThreadsError({ message: "", code: 100 }, ""), "(code=100)");
  });
  it("sem error: cai no corpo cru", () => {
    assert.equal(describeThreadsError(undefined, "oops"), "oops");
  });
});
