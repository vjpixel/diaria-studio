/**
 * test/push-notify.test.ts (#5341, sucede a suíte do client genérico anterior)
 *
 * Testes de regressão pro client genérico de notificação push por e-mail
 * (`scripts/lib/push-notify.ts`), substituto do client anterior (removido
 * em #5341 — decisão do editor: padronizar em e-mail em vez de exigir um
 * app de mensagens novo; o canal anterior era no-op silencioso sem
 * credenciais configuradas). Cobre:
 *
 *   - sendPushNotification: fail-soft TOTAL — `sendGmailMessage` lançando
 *     (auth, rede, 4xx/5xx, ou timeout) NUNCA propaga, sempre resolve com
 *     `{ok:false, error}`. Sucesso -> `{ok:true}`.
 *   - Timeout explícito (#2958): uma chamada que nunca resolve não trava o
 *     caller além de `timeoutMs`.
 *   - shouldNotify/markNotified: dedup puro por janela de tempo.
 *   - createInMemoryNotifiedStore: has/add/delete/keys.
 *   - formatHaltNotifyMessage: formatação determinística (subject/body).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PUSH_IO_TIMEOUT_MS,
  sendPushNotification,
  shouldNotify,
  markNotified,
  createInMemoryNotifiedStore,
  formatHaltNotifyMessage,
  type DedupRecord,
} from "../scripts/lib/push-notify.ts";

// ---------------------------------------------------------------------------
// sendPushNotification — fail-soft TOTAL
// ---------------------------------------------------------------------------

describe("sendPushNotification (fail-soft)", () => {
  it("sucesso -> {ok:true}, chama sendFn com to/subject/body corretos", async () => {
    let calledWith: unknown[] = [];
    const result = await sendPushNotification(
      { subject: "assunto", body: "corpo" },
      {
        to: "editor@example.com",
        sendFn: (async (...args: unknown[]) => {
          calledWith = args;
          return { id: "msg-1", threadId: "thread-1" };
        }) as any,
      },
    );
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(calledWith, ["editor@example.com", "assunto", "corpo"]);
  });

  it("sendFn lançando (auth/rede/4xx/5xx) -> {ok:false, error}, nunca propaga a exceção", async () => {
    const result = await sendPushNotification(
      { subject: "x", body: "y" },
      {
        to: "editor@example.com",
        sendFn: (async () => {
          throw new Error("Gmail API falhou (401): invalid_grant");
        }) as any,
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /invalid_grant/);
  });

  it("timeout: sendFn que nunca resolve não trava além de timeoutMs, nunca lança", async () => {
    const result = await sendPushNotification(
      { subject: "x", body: "y" },
      {
        to: "editor@example.com",
        timeoutMs: 20,
        sendFn: (() => new Promise(() => {})) as any,
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /timed out/i);
  });

  it("usa `to` default (resolveEditorEmail) quando omitido", async () => {
    let calledTo: string | undefined;
    const result = await sendPushNotification(
      { subject: "x", body: "y" },
      {
        sendFn: (async (to: string) => {
          calledTo = to;
          return { id: "1", threadId: "1" };
        }) as any,
      },
    );
    assert.equal(result.ok, true);
    assert.ok(calledTo && calledTo.includes("@"));
  });

  it("PUSH_IO_TIMEOUT_MS é finito e positivo", () => {
    assert.ok(Number.isFinite(PUSH_IO_TIMEOUT_MS) && PUSH_IO_TIMEOUT_MS > 0);
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
  it("inclui stage, motivo e ação no subject/body formatados", () => {
    const msg = formatHaltNotifyMessage(
      "2b — Clarice review",
      "mcp__clarice desconectado",
      "reconecte e responda 'retry', ou 'abort' para abortar",
    );
    assert.match(msg.subject, /Pipeline parou/);
    assert.match(msg.subject, /2b — Clarice review/);
    assert.match(msg.body, /mcp__clarice desconectado/);
    assert.match(msg.body, /reconecte e responda 'retry'/);
  });
});
