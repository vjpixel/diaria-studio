/**
 * test/studio-telegram-notify.test.ts (#3564)
 *
 * Testes de regressão pro watcher de notificação Telegram do Studio
 * (`scripts/studio-ui/studio-telegram-notify.ts`):
 *
 *   - resolveStudioPublicBaseUrl: default local + STUDIO_PUBLIC_BASE_URL,
 *     nunca hardcoda studio.diar.ia.br.
 *   - formatEditionGateMessage / formatChatGateMessage: texto + deep-link.
 *   - computeGateNotifications: diff puro (o que notificar / esquecer).
 *   - runTelegramNotifyTick: integração leve com buildStateFn/notifyFn
 *     injetáveis — dedup real (mesmo gate não notifica 2x em ticks
 *     consecutivos) + re-notificação quando o gate reaparece depois de
 *     resolvido.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveStudioPublicBaseUrl,
  formatEditionGateMessage,
  formatChatGateMessage,
  computeGateNotifications,
  runTelegramNotifyTick,
} from "../scripts/studio-ui/studio-telegram-notify.ts";
import { createInMemoryNotifiedStore } from "../scripts/lib/telegram-notify.ts";
import type { StudioState } from "../scripts/studio-ui/studio-state.ts";

// ---------------------------------------------------------------------------
// resolveStudioPublicBaseUrl
// ---------------------------------------------------------------------------

describe("resolveStudioPublicBaseUrl (#3564)", () => {
  it("default é o loopback local (Studio ainda não tem deploy público, #3560)", () => {
    assert.equal(resolveStudioPublicBaseUrl({} as NodeJS.ProcessEnv), "http://127.0.0.1:4174");
  });

  it("respeita STUDIO_PUBLIC_BASE_URL quando setada", () => {
    assert.equal(
      resolveStudioPublicBaseUrl({ STUDIO_PUBLIC_BASE_URL: "http://192.168.1.5:4174" } as NodeJS.ProcessEnv),
      "http://192.168.1.5:4174",
    );
  });

  it("remove trailing slash (evita // duplo ao concatenar path)", () => {
    assert.equal(
      resolveStudioPublicBaseUrl({ STUDIO_PUBLIC_BASE_URL: "http://127.0.0.1:4174/" } as NodeJS.ProcessEnv),
      "http://127.0.0.1:4174",
    );
  });
});

// ---------------------------------------------------------------------------
// formatação de mensagens
// ---------------------------------------------------------------------------

describe("formatEditionGateMessage", () => {
  it("inclui a edição, o rótulo do stage e o deep-link pro cockpit da edição", () => {
    const msg = formatEditionGateMessage("260716", 4, "http://127.0.0.1:4174");
    assert.match(msg, /260716/);
    assert.match(msg, /revisão editorial/);
    assert.match(msg, /http:\/\/127\.0\.0\.1:4174\/edicao\/260716/);
  });

  it("stage 6 usa o rótulo de agendamento", () => {
    const msg = formatEditionGateMessage("260716", 6, "http://127.0.0.1:4174");
    assert.match(msg, /agendamento final/);
  });
});

describe("formatChatGateMessage", () => {
  it("inclui o preview da pergunta quando presente + deep-link pra home", () => {
    const msg = formatChatGateMessage("qual destaque promover?", "http://127.0.0.1:4174");
    assert.match(msg, /qual destaque promover\?/);
    assert.match(msg, /http:\/\/127\.0\.0\.1:4174\//);
  });

  it("funciona sem preview (question null) — não quebra o formato", () => {
    const msg = formatChatGateMessage(null, "http://127.0.0.1:4174");
    assert.match(msg, /esperando uma resposta/);
    assert.doesNotMatch(msg, /null/);
  });
});

// ---------------------------------------------------------------------------
// computeGateNotifications — diff puro
// ---------------------------------------------------------------------------

describe("computeGateNotifications", () => {
  it("chave nova (não notificada ainda) entra em toNotify", () => {
    const plan = computeGateNotifications(["a"], []);
    assert.deepEqual(plan.toNotify, ["a"]);
    assert.deepEqual(plan.toClear, []);
  });

  it("chave já notificada e ainda presente -> não repete em toNotify", () => {
    const plan = computeGateNotifications(["a"], ["a"]);
    assert.deepEqual(plan.toNotify, []);
    assert.deepEqual(plan.toClear, []);
  });

  it("chave notificada que sumiu do current -> vai pra toClear", () => {
    const plan = computeGateNotifications([], ["a"]);
    assert.deepEqual(plan.toNotify, []);
    assert.deepEqual(plan.toClear, ["a"]);
  });

  it("mistura: uma nova, uma persistente, uma resolvida", () => {
    const plan = computeGateNotifications(["b", "persist"], ["persist", "resolved"]);
    assert.deepEqual(plan.toNotify, ["b"]);
    assert.deepEqual(plan.toClear, ["resolved"]);
  });
});

// ---------------------------------------------------------------------------
// runTelegramNotifyTick — dedup real através de ticks sucessivos
// ---------------------------------------------------------------------------

function stateWith(opts: {
  gatesPending?: StudioState["gatesPending"];
  chatPermissionsPending?: StudioState["chatPermissionsPending"];
}): StudioState {
  return {
    generatedAt: new Date().toISOString(),
    rootDir: "/fake",
    currentEdition: null,
    editions: [],
    gatesPending: opts.gatesPending ?? [],
    overnight: null,
    develop: null,
    chatPermissionsPending: opts.chatPermissionsPending ?? [],
  };
}

describe("runTelegramNotifyTick (#3564 — dedup + re-notificação)", () => {
  it("notifica 1x um gate novo e NÃO repete em ticks seguintes com o mesmo estado", async () => {
    const store = createInMemoryNotifiedStore();
    const calls: string[] = [];
    const buildStateFn = () => stateWith({ gatesPending: [{ edition: "260716", stage: 4 }] });
    const notifyFn = async (text: string) => {
      calls.push(text);
      return { ok: true };
    };

    const first = await runTelegramNotifyTick("/fake", store, { buildStateFn, notifyFn });
    assert.deepEqual(first, ["edition-gate:260716:4"]);
    assert.equal(calls.length, 1);

    const second = await runTelegramNotifyTick("/fake", store, { buildStateFn, notifyFn });
    assert.deepEqual(second, [], "mesmo gate ainda pendente não deve notificar de novo");
    assert.equal(calls.length, 1, "sendTelegramNotification não deve ser chamado 2x pro mesmo gate");
  });

  it("notifica de novo se o gate for resolvido e depois reaparecer", async () => {
    const store = createInMemoryNotifiedStore();
    const calls: string[] = [];
    const notifyFn = async (text: string) => {
      calls.push(text);
      return { ok: true };
    };

    const pending = () => stateWith({ gatesPending: [{ edition: "260716", stage: 4 }] });
    const resolved = () => stateWith({ gatesPending: [] });

    await runTelegramNotifyTick("/fake", store, { buildStateFn: pending, notifyFn });
    assert.equal(calls.length, 1);

    await runTelegramNotifyTick("/fake", store, { buildStateFn: resolved, notifyFn });
    assert.equal(calls.length, 1, "gate resolvido não dispara notificação nova");
    assert.equal(store.has("edition-gate:260716:4"), false, "chave deve ser esquecida ao resolver");

    await runTelegramNotifyTick("/fake", store, { buildStateFn: pending, notifyFn });
    assert.equal(calls.length, 2, "gate reaparecendo depois de resolvido notifica de novo");
  });

  it("notifica gates de chat (AskUserQuestion) com o mesmo mecanismo de dedup", async () => {
    const store = createInMemoryNotifiedStore();
    const calls: string[] = [];
    const notifyFn = async (text: string) => {
      calls.push(text);
      return { ok: true };
    };
    const buildStateFn = () =>
      stateWith({
        chatPermissionsPending: [
          { toolUseId: "tool-1", toolName: "AskUserQuestion", askedAt: 1, firstQuestion: "promover D2?" },
        ],
      });

    await runTelegramNotifyTick("/fake", store, { buildStateFn, notifyFn });
    assert.equal(calls.length, 1);
    assert.match(calls[0], /promover D2\?/);

    await runTelegramNotifyTick("/fake", store, { buildStateFn, notifyFn });
    assert.equal(calls.length, 1, "mesma pergunta pendente não notifica 2x");
  });

  it("2 gates simultâneos (edição + chat) geram 2 notificações distintas no mesmo tick", async () => {
    const store = createInMemoryNotifiedStore();
    const calls: string[] = [];
    const notifyFn = async (text: string) => {
      calls.push(text);
      return { ok: true };
    };
    const buildStateFn = () =>
      stateWith({
        gatesPending: [{ edition: "260716", stage: 6 }],
        chatPermissionsPending: [
          { toolUseId: "tool-2", toolName: "AskUserQuestion", askedAt: 1, firstQuestion: null },
        ],
      });

    const notified = await runTelegramNotifyTick("/fake", store, { buildStateFn, notifyFn });
    assert.equal(notified.length, 2);
    assert.equal(calls.length, 2);
  });

  it("notifyFn retornando {ok:false, skipped:true} (sem credenciais) NÃO marca dedup — retenta no próximo tick", async () => {
    const store = createInMemoryNotifiedStore();
    const calls: string[] = [];
    const notifyFn = async (text: string) => {
      calls.push(text);
      return { ok: false, skipped: true };
    };
    const buildStateFn = () => stateWith({ gatesPending: [{ edition: "260716", stage: 4 }] });

    await runTelegramNotifyTick("/fake", store, { buildStateFn, notifyFn });
    await runTelegramNotifyTick("/fake", store, { buildStateFn, notifyFn });

    assert.equal(calls.length, 2, "sem credenciais, cada tick deve tentar de novo — nunca 'desiste' de um gate ainda pendente");
    assert.equal(store.has("edition-gate:260716:4"), false);
  });

  it("notifyFn retornando {ok:false} (erro de rede) NÃO marca dedup — retenta no próximo tick", async () => {
    const store = createInMemoryNotifiedStore();
    const calls: string[] = [];
    const notifyFn = async (text: string) => {
      calls.push(text);
      return { ok: false, error: "network down" };
    };
    const buildStateFn = () => stateWith({ gatesPending: [{ edition: "260716", stage: 4 }] });

    await runTelegramNotifyTick("/fake", store, { buildStateFn, notifyFn });
    await runTelegramNotifyTick("/fake", store, { buildStateFn, notifyFn });

    assert.equal(calls.length, 2, "falha de rede não deve suprimir a retentativa no próximo tick");
    assert.equal(store.has("edition-gate:260716:4"), false);
  });

  it("nenhum gate pendente -> nenhuma chamada de notifyFn", async () => {
    const store = createInMemoryNotifiedStore();
    let called = false;
    const notifyFn = async () => {
      called = true;
      return { ok: true };
    };
    const notified = await runTelegramNotifyTick("/fake", store, {
      buildStateFn: () => stateWith({}),
      notifyFn,
    });
    assert.deepEqual(notified, []);
    assert.equal(called, false);
  });
});
