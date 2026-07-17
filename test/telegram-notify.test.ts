/**
 * test/telegram-notify.test.ts (#3564)
 *
 * Testes de regressão pro client genérico de notificação Telegram
 * (`scripts/lib/telegram-notify.ts`), extraído do padrão que
 * `scripts/overnight-watchdog.ts` (#2688/#2958) já usava. Cobre:
 *
 *   - buildTelegramSendMessageRequest: formatação da requisição + timeout.
 *   - resolveTelegramCredentials: precedência TELEGRAM_CHAT_ID >
 *     TELEGRAM_WATCHDOG_CHAT_ID, ausência de qualquer uma -> null.
 *   - sendTelegramNotification: fail-soft TOTAL — sem credenciais (skip),
 *     HTTP não-2xx, fetch lançando, sucesso — nunca lança em nenhum caso.
 *   - shouldNotify/markNotified: dedup puro por janela de tempo.
 *   - createInMemoryNotifiedStore: has/add/delete/keys.
 *   - formatHaltNotifyMessage: formatação determinística (stage/motivo/ação).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  TELEGRAM_IO_TIMEOUT_MS,
  buildTelegramSendMessageRequest,
  resolveTelegramCredentials,
  sendTelegramNotification,
  shouldNotify,
  markNotified,
  createInMemoryNotifiedStore,
  formatHaltNotifyMessage,
  type DedupRecord,
} from "../scripts/lib/telegram-notify.ts";

// ---------------------------------------------------------------------------
// buildTelegramSendMessageRequest
// ---------------------------------------------------------------------------

describe("buildTelegramSendMessageRequest", () => {
  it("monta a URL da Bot API com o token informado", () => {
    const { url } = buildTelegramSendMessageRequest("TOKEN123", "chat-1", "olá");
    assert.equal(url, "https://api.telegram.org/botTOKEN123/sendMessage");
  });

  it("o corpo carrega chat_id, texto e parse_mode Markdown", () => {
    const { options } = buildTelegramSendMessageRequest("TOKEN123", "chat-42", "gate pendente");
    const body = JSON.parse(options.body as string);
    assert.equal(body.chat_id, "chat-42");
    assert.equal(body.text, "gate pendente");
    assert.equal(body.parse_mode, "Markdown");
  });

  it("inclui um AbortSignal de timeout (#2958 — nunca fica pendurado sem limite)", () => {
    const { options } = buildTelegramSendMessageRequest("TOKEN123", "chat-1", "x");
    assert.ok(options.signal instanceof AbortSignal);
  });

  it("TELEGRAM_IO_TIMEOUT_MS é finito e positivo", () => {
    assert.ok(Number.isFinite(TELEGRAM_IO_TIMEOUT_MS) && TELEGRAM_IO_TIMEOUT_MS > 0);
  });
});

// ---------------------------------------------------------------------------
// resolveTelegramCredentials
// ---------------------------------------------------------------------------

describe("resolveTelegramCredentials", () => {
  it("retorna null quando TELEGRAM_BOT_TOKEN está ausente", () => {
    const creds = resolveTelegramCredentials({ TELEGRAM_CHAT_ID: "chat-1" } as NodeJS.ProcessEnv);
    assert.equal(creds, null);
  });

  it("retorna null quando nenhum chat id (novo nem legado) está presente", () => {
    const creds = resolveTelegramCredentials({ TELEGRAM_BOT_TOKEN: "T" } as NodeJS.ProcessEnv);
    assert.equal(creds, null);
  });

  it("usa TELEGRAM_CHAT_ID (#3564, nome genérico) quando presente", () => {
    const creds = resolveTelegramCredentials({
      TELEGRAM_BOT_TOKEN: "T",
      TELEGRAM_CHAT_ID: "chat-novo",
      TELEGRAM_WATCHDOG_CHAT_ID: "chat-legado",
    } as NodeJS.ProcessEnv);
    assert.deepEqual(creds, { token: "T", chatId: "chat-novo" });
  });

  it("cai pro TELEGRAM_WATCHDOG_CHAT_ID (#2688, legado) quando TELEGRAM_CHAT_ID está ausente", () => {
    const creds = resolveTelegramCredentials({
      TELEGRAM_BOT_TOKEN: "T",
      TELEGRAM_WATCHDOG_CHAT_ID: "chat-legado",
    } as NodeJS.ProcessEnv);
    assert.deepEqual(creds, { token: "T", chatId: "chat-legado" });
  });
});

// ---------------------------------------------------------------------------
// sendTelegramNotification — fail-soft TOTAL
// ---------------------------------------------------------------------------

describe("sendTelegramNotification (fail-soft)", () => {
  it("sem credenciais -> {ok:false, skipped:true}, NÃO chama fetch", async () => {
    let called = false;
    const result = await sendTelegramNotification("texto", {
      credentials: null,
      fetchFn: (async () => {
        called = true;
        throw new Error("não deveria ser chamado");
      }) as unknown as typeof fetch,
    });
    assert.deepEqual(result, { ok: false, skipped: true });
    assert.equal(called, false);
  });

  it("HTTP 200 -> {ok:true}", async () => {
    const result = await sendTelegramNotification("texto", {
      credentials: { token: "T", chatId: "C" },
      fetchFn: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });
    assert.deepEqual(result, { ok: true });
  });

  it("HTTP não-2xx -> {ok:false, error} com o corpo da resposta, nunca lança", async () => {
    const result = await sendTelegramNotification("texto", {
      credentials: { token: "T", chatId: "C" },
      fetchFn: (async () =>
        new Response("chat not found", { status: 400 })) as unknown as typeof fetch,
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /400/);
    assert.match(result.error ?? "", /chat not found/);
  });

  it("fetch lançando (rede/timeout) -> {ok:false, error}, nunca propaga a exceção", async () => {
    const result = await sendTelegramNotification("texto", {
      credentials: { token: "T", chatId: "C" },
      fetchFn: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /network down/);
  });

  it("usa resolveTelegramCredentials(process.env) por default quando `credentials` é omitido", async () => {
    const prevToken = process.env.TELEGRAM_BOT_TOKEN;
    const prevChat = process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    try {
      const result = await sendTelegramNotification("texto");
      assert.deepEqual(result, { ok: false, skipped: true });
    } finally {
      if (prevToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = prevToken;
      if (prevChat !== undefined) process.env.TELEGRAM_CHAT_ID = prevChat;
    }
  });
});

// ---------------------------------------------------------------------------
// dedup puro: shouldNotify / markNotified
// ---------------------------------------------------------------------------

describe("shouldNotify / markNotified (dedup puro, #3564)", () => {
  it("chave nunca vista -> shouldNotify true", () => {
    const record: DedupRecord = {};
    assert.equal(shouldNotify(record, "gate-4-260716", 1_000_000, 60_000), true);
  });

  it("mesmo evento dentro da janela -> shouldNotify false (não notifica 2x)", () => {
    const nowMs = 1_000_000;
    const record = markNotified({}, "gate-4-260716", nowMs);
    assert.equal(shouldNotify(record, "gate-4-260716", nowMs + 30_000, 60_000), false);
  });

  it("mesmo evento FORA da janela -> shouldNotify true de novo", () => {
    const nowMs = 1_000_000;
    const record = markNotified({}, "gate-4-260716", nowMs);
    assert.equal(shouldNotify(record, "gate-4-260716", nowMs + 60_001, 60_000), true);
  });

  it("markNotified não muta o record original (pura)", () => {
    const original: DedupRecord = {};
    const updated = markNotified(original, "k", 1);
    assert.deepEqual(original, {});
    assert.deepEqual(updated, { k: 1 });
  });

  it("chaves diferentes não interferem entre si", () => {
    const nowMs = 1_000_000;
    let record = markNotified({}, "gate-4", nowMs);
    record = markNotified(record, "gate-6", nowMs);
    assert.equal(shouldNotify(record, "gate-4", nowMs + 1, 60_000), false);
    assert.equal(shouldNotify(record, "chat-abc", nowMs + 1, 60_000), true);
  });
});

// ---------------------------------------------------------------------------
// createInMemoryNotifiedStore
// ---------------------------------------------------------------------------

describe("createInMemoryNotifiedStore", () => {
  it("has/add/delete/keys funcionam como um Set", () => {
    const store = createInMemoryNotifiedStore();
    assert.equal(store.has("a"), false);
    store.add("a");
    assert.equal(store.has("a"), true);
    assert.deepEqual(store.keys(), ["a"]);
    store.delete("a");
    assert.equal(store.has("a"), false);
    assert.deepEqual(store.keys(), []);
  });

  it("add é idempotente (adicionar 2x não duplica em keys())", () => {
    const store = createInMemoryNotifiedStore();
    store.add("a");
    store.add("a");
    assert.deepEqual(store.keys(), ["a"]);
  });
});

// ---------------------------------------------------------------------------
// formatHaltNotifyMessage
// ---------------------------------------------------------------------------

describe("formatHaltNotifyMessage", () => {
  it("inclui stage, motivo e ação no texto formatado", () => {
    const msg = formatHaltNotifyMessage(
      "2b — Clarice review",
      "mcp__clarice desconectado",
      "reconecte e responda 'retry', ou 'abort' para abortar",
    );
    assert.match(msg, /PIPELINE PAROU/);
    assert.match(msg, /2b — Clarice review/);
    assert.match(msg, /mcp__clarice desconectado/);
    assert.match(msg, /reconecte e responda 'retry'/);
  });
});
