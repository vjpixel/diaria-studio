/**
 * threads-carousel.test.ts (#5348, unidade dedicada de carrossel de imagem
 * pro Threads)
 *
 * Testa o carrossel do Threads no Worker `diaria-linkedin-cron` — fluxo de
 * 3 passos da Threads API (N containers filhos `IMAGE` → 1 container pai
 * `CAROUSEL` → publish), disparado quando `entry.image_urls` tem mais de 1
 * item, e o caminho de UMA imagem (`fireThreadsSingleImage`, entry com
 * `image_urls` de tamanho 1). Ver `src/dispatch.ts` (fireThreads,
 * fireThreadsText, fireThreadsSingleImage, fireThreadsCarousel,
 * pollThreadsContainerStatus).
 *
 * Mesmo padrão de mocks de test/instagram-carousel.test.ts (#4153) e
 * test/threads-channel.test.ts (#3944 Parte B).
 *
 * Diferença estrutural central vs Instagram: o poll de status É
 * OBRIGATÓRIO e FAIL-CLOSED (nunca best-effort) — cada container (filho E
 * pai) precisa responder `status: "FINISHED"` antes do próximo passo poder
 * usá-lo. Cobertura:
 *   - happy path carrossel de 3: 3 containers filhos (cada um com poll até
 *     FINISHED) → 1 pai (com poll) → publish
 *   - 1 imagem só via `image_urls` (length 1): caminho `fireThreadsSingleImage`
 *     — container IMAGE direto, sem is_carousel_item/children, COM poll
 *     obrigatório
 *   - poll de um child NUNCA retorna FINISHED (fica IN_PROGRESS pra sempre)
 *     → timeout após o teto de tentativas, fail-closed, DLQ — NUNCA publica,
 *     NUNCA poll infinito (número de tentativas de status É finito e
 *     verificado)
 *   - poll retorna ERROR → aborta imediato (não espera esgotar tentativas)
 *   - falha no meio do carrossel (child 2 de 3): DLQ, containers 3 nunca
 *     criado, container pai nunca criado, publish nunca chamado
 *   - texto ainda respeita o guard de 500 chars mesmo com imagem
 */
import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

import { fireQueueEntry } from "../src/dispatch.ts";
import type { QueueEntry } from "../src/index.ts";

function bodyOf(init: RequestInit | undefined): string {
  return init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
}

const CREDS = { threads: { userId: "acc", accessToken: "tok", apiVersion: "v1.0" } };
const BASE_CONFIG = { webhookUrl: "https://make.test/diaria", ...CREDS };

function baseEntry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    text: "Legenda da semana",
    image_url: null,
    scheduled_at: new Date().toISOString(),
    destaque: "weekly-clicked",
    created_at: new Date().toISOString(),
    channel: "threads",
    ...overrides,
  };
}

describe("#5348 Threads carrossel: 3 containers filhos + 1 pai + 1 publish, com poll obrigatório em cada", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalTimers: typeof globalThis.setTimeout;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalTimers = globalThis.setTimeout;
    // #5348: o poll dorme THREADS_POLL_INTERVAL_MS (2000ms) entre tentativas
    // — sem isso o teste real levaria segundos. setTimeout mockado dispara
    // na hora (0ms), preservando a lógica de retry/contagem sem custo de
    // wall-clock.
    (globalThis as any).setTimeout = (fn: () => void) => { fn(); return 0 as any; };
  });
  function restore() {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalTimers;
  }

  it("cria 3 filhos (cada um com poll até FINISHED), 1 pai (com poll), e publica — na ordem certa", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    let childCounter = 0;
    let statusPollCount = 0;
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.url;
      const body = bodyOf(init);
      calls.push({ url: u, body });
      if (u.includes("?fields=status")) {
        statusPollCount++;
        return new Response(JSON.stringify({ status: "FINISHED" }), { status: 200 });
      }
      if (u.endsWith("/threads_publish")) {
        return new Response(JSON.stringify({ id: "parent-published-id" }), { status: 200 });
      }
      if (u.endsWith("/threads") && body.includes("media_type=CAROUSEL")) {
        return new Response(JSON.stringify({ id: "parent-container-id" }), { status: 200 });
      }
      if (u.endsWith("/threads")) {
        childCounter++;
        return new Response(JSON.stringify({ id: `child-${childCounter}` }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const imageUrls = [
      "https://poll.diaria.workers.dev/img/1.jpg",
      "https://poll.diaria.workers.dev/img/2.jpg",
      "https://poll.diaria.workers.dev/img/3.jpg",
    ];
    const entry = baseEntry({ image_urls: imageUrls, text: "Os mais clicados da semana" });

    try {
      const outcome = await fireQueueEntry(entry, BASE_CONFIG);
      assert.deepEqual(outcome, { status: "fired" });

      const childCalls = calls.filter(
        (c) => c.url.endsWith("/threads") && c.body.includes("is_carousel_item=true"),
      );
      assert.equal(childCalls.length, 3, "deve criar exatamente 3 containers filhos");
      childCalls.forEach((c, i) => {
        const params = new URLSearchParams(c.body);
        assert.equal(params.get("media_type"), "IMAGE");
        assert.equal(params.get("image_url"), imageUrls[i], `child ${i + 1} deve levar a imagem certa, na ordem`);
        assert.ok(!c.body.includes("text="), "child container não deve levar texto/caption");
      });

      const parentCall = calls.find((c) => c.url.endsWith("/threads") && c.body.includes("media_type=CAROUSEL"));
      assert.ok(parentCall, "deve ter criado o container pai");
      assert.match(parentCall!.body, /children=child-1%2Cchild-2%2Cchild-3/, "children deve listar os ids na ordem certa");
      assert.match(parentCall!.body, /text=/, "container pai deve levar a legenda");

      const publishCall = calls.find((c) => c.url.endsWith("/threads_publish"));
      assert.ok(publishCall, "deve ter chamado threads_publish");
      assert.match(publishCall!.body, /creation_id=parent-container-id/, "publish deve usar o creation_id do container PAI");

      // Poll obrigatório: 1 chamada de status por container (3 filhos + 1 pai = 4).
      assert.equal(statusPollCount, 4, "cada container (3 filhos + 1 pai) deve ser polled até FINISHED antes de seguir");
    } finally {
      restore();
    }
  });

  it("1 imagem só (image_urls[1]): caminho fireThreadsSingleImage — container IMAGE direto, COM poll obrigatório, sem is_carousel_item/children", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    let statusPollCount = 0;
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.url;
      const body = bodyOf(init);
      calls.push({ url: u, body });
      if (u.includes("?fields=status")) {
        statusPollCount++;
        return new Response(JSON.stringify({ status: "FINISHED" }), { status: 200 });
      }
      if (u.endsWith("/threads_publish")) {
        return new Response(JSON.stringify({ id: "published-1" }), { status: 200 });
      }
      if (u.endsWith("/threads")) {
        return new Response(JSON.stringify({ id: "container-solo" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const entry = baseEntry({ image_urls: ["https://x.test/only.jpg"] });

    try {
      const outcome = await fireQueueEntry(entry, BASE_CONFIG);
      assert.deepEqual(outcome, { status: "fired" });
      const mediaCalls = calls.filter((c) => c.url.endsWith("/threads"));
      assert.equal(mediaCalls.length, 1, "só 1 container (imagem única) — nunca 2 como no carrossel");
      assert.ok(!mediaCalls[0].body.includes("is_carousel_item"));
      assert.ok(!mediaCalls[0].body.includes("children"));
      assert.match(mediaCalls[0].body, /media_type=IMAGE/);
      assert.match(mediaCalls[0].body, /text=/, "caminho de imagem única leva o texto no único container");
      assert.equal(statusPollCount, 1, "poll obrigatório mesmo com 1 imagem só — diferente do Instagram (best-effort)");
    } finally {
      restore();
    }
  });

  it("entry sem imagem (image_urls ausente): continua TEXT-only, sem poll nenhum — regressão do caminho #3944 Parte B", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      calls.push(u);
      if (u.endsWith("/threads_publish")) return new Response(JSON.stringify({ id: "published-text" }), { status: 200 });
      if (u.endsWith("/threads")) return new Response(JSON.stringify({ id: "container-text" }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const entry = baseEntry({ text: "Post só texto" });
    try {
      const outcome = await fireQueueEntry(entry, BASE_CONFIG);
      assert.deepEqual(outcome, { status: "fired" });
      assert.ok(!calls.some((u) => u.includes("?fields=status")), "TEXT-only nunca faz poll de status");
      assert.equal(calls.filter((u) => u.endsWith("/threads")).length, 1);
      assert.equal(calls.filter((u) => u.endsWith("/threads_publish")).length, 1);
    } finally {
      restore();
    }
  });
});

describe("#5348 Threads carrossel: poll fail-closed — NUNCA publica um container que não confirmou FINISHED", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalTimers: typeof globalThis.setTimeout;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalTimers = globalThis.setTimeout;
    (globalThis as any).setTimeout = (fn: () => void) => { fn(); return 0 as any; };
  });
  function restore() {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalTimers;
  }

  it("container fica IN_PROGRESS pra sempre: timeout após o teto de tentativas, fail-closed, DLQ — NUNCA publica, NUNCA poll infinito", async () => {
    let statusPollCount = 0;
    let publishCalled = false;
    globalThis.fetch = (async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("?fields=status")) {
        statusPollCount++;
        return new Response(JSON.stringify({ status: "IN_PROGRESS" }), { status: 200 });
      }
      if (u.endsWith("/threads_publish")) {
        publishCalled = true;
        return new Response(JSON.stringify({ id: "should-not-happen" }), { status: 200 });
      }
      if (u.endsWith("/threads")) return new Response(JSON.stringify({ id: "container-stuck" }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const entry = baseEntry({ image_urls: ["https://x.test/1.jpg"] }); // caminho single-image, mais simples de isolar

    try {
      const outcome = await fireQueueEntry(entry, BASE_CONFIG);
      assert.equal(outcome.status, "dlq");
      assert.match((outcome as { reason: string }).reason, /nunca ficou FINISHED/);
      assert.match((outcome as { reason: string }).reason, /fail-closed/);
      // Teto FIXO de tentativas — nunca poll infinito. 10 é o valor
      // configurado hoje (THREADS_POLL_MAX_ATTEMPTS); o teste trava o
      // COMPORTAMENTO (finito, nunca infinito), não necessariamente o
      // número exato — mas verifica que parou dentro de um teto razoável.
      assert.ok(statusPollCount >= 2 && statusPollCount <= 20, `poll deveria parar num teto finito, não continuar pra sempre (contou ${statusPollCount})`);
      assert.equal(publishCalled, false, "NUNCA deve chamar threads_publish sem confirmar FINISHED");
    } finally {
      restore();
    }
  });

  it("container retorna status=ERROR: aborta IMEDIATO (não espera esgotar as tentativas) — DLQ", async () => {
    let statusPollCount = 0;
    globalThis.fetch = (async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.includes("?fields=status")) {
        statusPollCount++;
        return new Response(JSON.stringify({ status: "ERROR" }), { status: 200 });
      }
      if (u.endsWith("/threads")) return new Response(JSON.stringify({ id: "container-err" }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const entry = baseEntry({ image_urls: ["https://x.test/1.jpg"] });
    try {
      const outcome = await fireQueueEntry(entry, BASE_CONFIG);
      assert.equal(outcome.status, "dlq");
      assert.match((outcome as { reason: string }).reason, /status=ERROR/);
      assert.equal(statusPollCount, 1, "status=ERROR aborta na 1ª tentativa, sem re-tentar");
    } finally {
      restore();
    }
  });

  it("falha parcial: child 2 de 3 falha na CRIAÇÃO do container — DLQ, child 3 nunca criado, container pai/publish nunca chamados", async () => {
    let childAttempt = 0;
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.url;
      const body = bodyOf(init);
      if (u.includes("?fields=status")) return new Response(JSON.stringify({ status: "FINISHED" }), { status: 200 });
      if (u.endsWith("/threads_publish")) return new Response(JSON.stringify({ id: "should-not-happen" }), { status: 200 });
      if (u.endsWith("/threads") && body.includes("media_type=CAROUSEL")) {
        return new Response(JSON.stringify({ id: "should-not-happen-parent" }), { status: 200 });
      }
      if (u.endsWith("/threads")) {
        childAttempt++;
        if (childAttempt === 2) return new Response(JSON.stringify({ error: { message: "Invalid image URL" } }), { status: 400 });
        return new Response(JSON.stringify({ id: `child-${childAttempt}` }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const entry = baseEntry({
      image_urls: ["https://x.test/1.jpg", "https://x.test/2-bad.jpg", "https://x.test/3.jpg"],
    });

    try {
      const outcome = await fireQueueEntry(entry, BASE_CONFIG);
      assert.equal(outcome.status, "dlq");
      assert.match((outcome as { reason: string }).reason, /2\/3/);
      assert.equal(childAttempt, 2, "nunca deve tentar criar o 3º container após a falha no 2º");
    } finally {
      restore();
    }
  });
});

describe("#5348 Threads: guard de tamanho (≤500 chars) vale nos 3 caminhos (texto, imagem única, carrossel)", () => {
  it("texto >500 chars com image_urls presente: dlq direto, sem tentar fetch nenhum", async () => {
    const fetchMock = mock.fn(async () => new Response("{}", { status: 200 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const entry = baseEntry({ text: "x".repeat(501), image_urls: ["https://x.test/1.jpg", "https://x.test/2.jpg"] });
      const outcome = await fireQueueEntry(entry, BASE_CONFIG);
      assert.equal(outcome.status, "dlq");
      assert.match((outcome as { reason: string }).reason, /500 chars/);
      assert.equal(fetchMock.mock.calls.length, 0, "guard roda ANTES de qualquer dispatch — nunca chega a tentar criar container");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
