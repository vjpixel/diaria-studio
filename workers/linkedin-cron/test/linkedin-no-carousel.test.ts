/**
 * linkedin-no-carousel.test.ts (#8050)
 *
 * Regressão: `channel: "linkedin"` não suporta carrossel (`image_urls` com
 * mais de 1 item) — `fireLinkedIn` (src/dispatch.ts) só encaminha
 * `image_url` singular ao Make.com, nunca leu `image_urls`. Antes deste
 * guard, uma entry LinkedIn com `image_urls[>1]` caía em silêncio pro
 * `image_url` ausente/undefined e ficava reprocessando até a DLQ sem nenhum
 * sinal claro do motivo (achado ao vivo, sessão 260912: carrossel semanal
 * enfileirado manualmente pro LinkedIn ficou preso em retry).
 *
 * `fireQueueEntry` agora rejeita essa combinação fail-fast (dlq imediato,
 * sem tentar fetch), poupando os retries e nomeando a causa real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fireQueueEntry } from "../src/dispatch.ts";
import type { QueueEntry } from "../src/index.ts";

describe("#8050: channel=linkedin + image_urls[>1] (carrossel) → dlq fail-fast, sem fetch", () => {
  it("rejeita antes de qualquer chamada de rede e nomeia a causa", async () => {
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const entry: QueueEntry = {
      text: "carrossel semanal",
      image_url: null,
      image_urls: ["https://x.test/1.jpg", "https://x.test/2.jpg", "https://x.test/3.jpg", "https://x.test/4.jpg"],
      scheduled_at: new Date().toISOString(),
      destaque: "weekly-highlights",
      created_at: new Date().toISOString(),
      channel: "linkedin",
    };

    try {
      const outcome = await fireQueueEntry(entry, { webhookUrl: "https://make.test/diaria" });
      assert.equal(outcome.status, "dlq");
      assert.match((outcome as { reason: string }).reason, /image_urls|carrossel/i);
      assert.equal(fetchCalled, false, "não deveria ter tentado nenhum fetch");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("1 imagem só via image_urls[1] continua indo pro Make normalmente (não é carrossel)", async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | Request) => {
      calls.push(typeof url === "string" ? url : url.url);
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const entry: QueueEntry = {
      text: "post normal",
      image_url: null,
      image_urls: ["https://x.test/only.jpg"],
      scheduled_at: new Date().toISOString(),
      destaque: "d1",
      created_at: new Date().toISOString(),
      channel: "linkedin",
    };

    try {
      const outcome = await fireQueueEntry(entry, { webhookUrl: "https://make.test/diaria" });
      assert.deepEqual(outcome, { status: "fired" });
      assert.equal(calls.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
