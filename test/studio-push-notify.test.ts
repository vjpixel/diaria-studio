/**
 * test/studio-push-notify.test.ts (#3564, canal e-mail #5341)
 *
 * Testes de regressão pro watcher de notificação push do Studio
 * (`scripts/studio-ui/studio-push-notify.ts`):
 *
 *   - resolveStudioPublicBaseUrl: default local + STUDIO_PUBLIC_BASE_URL,
 *     nunca hardcoda studio.diar.ia.br.
 *   - formatEditionGateMessage: subject/body + deep-link.
 *   - computeGateNotifications: diff puro (o que notificar / esquecer).
 *   - runPushNotifyTick: integração leve com buildStateFn/notifyFn
 *     injetáveis — dedup real (mesmo gate não notifica 2x em ticks
 *     consecutivos) + re-notificação quando o gate reaparece depois de
 *     resolvido.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveStudioPublicBaseUrl,
  formatEditionGateMessage,
  computeGateNotifications,
  runPushNotifyTick,
} from "../scripts/studio-ui/studio-push-notify.ts";
import { createInMemoryNotifiedStore, type PushMessage } from "../scripts/lib/push-notify.ts";
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
    assert.match(msg.subject, /260716/);
    assert.match(msg.body, /revisão editorial/);
    assert.match(msg.body, /http:\/\/127\.0\.0\.1:4174\/edicao\/260716/);
  });

  it("stage 6 usa o rótulo de agendamento", () => {
    const msg = formatEditionGateMessage("260716", 6, "http://127.0.0.1:4174");
    assert.match(msg.body, /agendamento final/);
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
// runPushNotifyTick — dedup real através de ticks sucessivos
// ---------------------------------------------------------------------------

function stateWith(opts: {
  gatesPending?: StudioState["gatesPending"];
}): StudioState {
  return {
    generatedAt: new Date().toISOString(),
    rootDir: "/fake",
    currentEdition: null,
    editions: [],
    gatesPending: opts.gatesPending ?? [],
    overnight: null,
    develop: null,
  };
}

describe("runPushNotifyTick (#3564 — dedup + re-notificação)", () => {
  it("notifica 1x um gate novo e NÃO repete em ticks seguintes com o mesmo estado", async () => {
    const store = createInMemoryNotifiedStore();
    const calls: PushMessage[] = [];
    const buildStateFn = () => stateWith({ gatesPending: [{ edition: "260716", stage: 4 }] });
    const notifyFn = async (msg: PushMessage) => {
      calls.push(msg);
      return { ok: true };
    };

    const first = await runPushNotifyTick("/fake", store, { buildStateFn, notifyFn });
    assert.deepEqual(first, ["edition-gate:260716:4"]);
    assert.equal(calls.length, 1);

    const second = await runPushNotifyTick("/fake", store, { buildStateFn, notifyFn });
    assert.deepEqual(second, [], "mesmo gate ainda pendente não deve notificar de novo");
    assert.equal(calls.length, 1, "sendPushNotification não deve ser chamado 2x pro mesmo gate");
  });

  it("notifica de novo se o gate for resolvido e depois reaparecer", async () => {
    const store = createInMemoryNotifiedStore();
    const calls: PushMessage[] = [];
    const notifyFn = async (msg: PushMessage) => {
      calls.push(msg);
      return { ok: true };
    };

    const pending = () => stateWith({ gatesPending: [{ edition: "260716", stage: 4 }] });
    const resolved = () => stateWith({ gatesPending: [] });

    await runPushNotifyTick("/fake", store, { buildStateFn: pending, notifyFn });
    assert.equal(calls.length, 1);

    await runPushNotifyTick("/fake", store, { buildStateFn: resolved, notifyFn });
    assert.equal(calls.length, 1, "gate resolvido não dispara notificação nova");
    assert.equal(store.has("edition-gate:260716:4"), false, "chave deve ser esquecida ao resolver");

    await runPushNotifyTick("/fake", store, { buildStateFn: pending, notifyFn });
    assert.equal(calls.length, 2, "gate reaparecendo depois de resolvido notifica de novo");
  });

  it("2 gates simultâneos (2 edições diferentes) geram 2 notificações distintas no mesmo tick", async () => {
    const store = createInMemoryNotifiedStore();
    const calls: PushMessage[] = [];
    const notifyFn = async (msg: PushMessage) => {
      calls.push(msg);
      return { ok: true };
    };
    const buildStateFn = () =>
      stateWith({
        gatesPending: [
          { edition: "260716", stage: 6 },
          { edition: "260717", stage: 4 },
        ],
      });

    const notified = await runPushNotifyTick("/fake", store, { buildStateFn, notifyFn });
    assert.equal(notified.length, 2);
    assert.equal(calls.length, 2);
  });

  it("notifyFn retornando {ok:false} (auth/rede/timeout) NÃO marca dedup — retenta no próximo tick", async () => {
    const store = createInMemoryNotifiedStore();
    const calls: PushMessage[] = [];
    const notifyFn = async (msg: PushMessage) => {
      calls.push(msg);
      return { ok: false, error: "network down" };
    };
    const buildStateFn = () => stateWith({ gatesPending: [{ edition: "260716", stage: 4 }] });

    await runPushNotifyTick("/fake", store, { buildStateFn, notifyFn });
    await runPushNotifyTick("/fake", store, { buildStateFn, notifyFn });

    assert.equal(calls.length, 2, "falha não deve suprimir a retentativa no próximo tick");
    assert.equal(store.has("edition-gate:260716:4"), false);
  });

  it("nenhum gate pendente -> nenhuma chamada de notifyFn", async () => {
    const store = createInMemoryNotifiedStore();
    let called = false;
    const notifyFn = async () => {
      called = true;
      return { ok: true };
    };
    const notified = await runPushNotifyTick("/fake", store, {
      buildStateFn: () => stateWith({}),
      notifyFn,
    });
    assert.deepEqual(notified, []);
    assert.equal(called, false);
  });
});
