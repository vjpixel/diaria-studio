/**
 * test/poll-subscribe-welcome-sequence-6508.test.ts (#6508)
 *
 * Guard de regressão contra o bug: cadastro via API direta
 * (`subscribeToKit` no worker `poll`) nunca entrava na sequence de
 * boas-vindas do Kit. Quem passa pelo FORM `9839463` já entrava
 * automaticamente via Automation Rule (rule id `5578342`), mas o worker
 * `poll` cria subscriber via `POST /v4/subscribers` SEM passar pelo form,
 * então precisava do vínculo explícito `POST /v4/sequences/{id}/subscribers`.
 *
 * Este teste usa um mock fetch para simular o Kit API e confirma:
 *   1. Com `KIT_WELCOME_SEQUENCE_ID` configurado, o subscriber criado
 *      recebe um 2º fetch para a sequence
 *   2. Sem `KIT_WELCOME_SEQUENCE_ID`, NUNCA tenta adicionar à sequence
 *   3. Se o fetch da sequence falhar, a assinatura NÃO é revertida
 *      (best-effort, fail-soft, mesmo padrão de `vincularKitDoiForm`)
 *   4. `KIT_WELCOME_SEQUENCE_ID` inválido (não numérico) → loga erro,
 *      não tenta a sequence, assinatura segue normal
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Import the subscribe module via tsx dynamic import
const mod = await import(join(ROOT, "workers/poll/src/subscribe.ts"));

// We can't import the internal `subscribeToKit` (not exported — #6291),
// but we CAN import `subscribeViaConfiguredBackend` (the single entrypoint)
// and call it with SUBSCRIBE_BACKEND=kit + KIT_WELCOME_SEQUENCE_ID.
const { subscribeViaConfiguredBackend } = mod as {
  subscribeViaConfiguredBackend: (
    env: Record<string, unknown>,
    input: { name: string; email: string },
    fetchImpl?: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
  ) => Promise<{ ok: boolean; status: number; reason?: string }>;
};

function makeFetchMock(calls: { url: string; status: number; body?: string }[]) {
  return async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const u = String(input);
    // Match by endpoint path
    const match = calls.find(c => u.includes(c.url));
    if (!match) {
      // Return a 200 with empty body for any unmatched call (e.g., sequence)
      return new Response(
        JSON.stringify({ subscriber: { id: 99999 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      match.body ?? JSON.stringify({ subscriber: { id: 99999 } }),
      { status: match.status, headers: { "Content-Type": "application/json" } },
    );
  };
}

describe("subscribeToKit — sequence de boas-vindas (#6508)", () => {
  const baseEnv = {
    SUBSCRIBE_BACKEND: "kit",
    KIT_API_KEY: "test-key",
    KIT_API_URL: "https://api.kit.com/v4",
  };

  it("com KIT_WELCOME_SEQUENCE_ID configurado, tenta adicionar à sequence", async () => {
    const calls: { url: string; status: number }[] = [];
    const fetchImpl = async (input: URL | RequestInfo, init?: RequestInit) => {
      const u = String(input);
      calls.push({ url: u, status: 200 });
      return new Response(
        JSON.stringify({ subscriber: { id: 99999 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await subscribeViaConfiguredBackend(
      { ...baseEnv, KIT_WELCOME_SEQUENCE_ID: "2876508" },
      { name: "Teste", email: "teste@example.com" },
      fetchImpl,
    );

    assert.ok(result.ok, `assinatura deveria ter sucesso, got: ${JSON.stringify(result)}`);
    // The subscriber creation + sequence link should both be in calls
    const hasSubscriberCall = calls.some(c => c.url.includes("/subscribers") && !c.url.includes("/sequences/"));
    const hasSequenceCall = calls.some(c => c.url.includes("/sequences/"));
    assert.ok(hasSubscriberCall, "deveria ter fechado POST /subscribers");
    assert.ok(hasSequenceCall, "deveria ter fechado POST /sequences/{id}/subscribers");
  });

  it("sem KIT_WELCOME_SEQUENCE_ID, NUNCA tenta adicionar à sequence", async () => {
    const calls: { url: string }[] = [];
    const fetchImpl = async (input: URL | RequestInfo, init?: RequestInit) => {
      const u = String(input);
      calls.push({ url: u });
      return new Response(
        JSON.stringify({ subscriber: { id: 99999 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await subscribeViaConfiguredBackend(
      baseEnv, // sem KIT_WELCOME_SEQUENCE_ID
      { name: "Teste", email: "teste@example.com" },
      fetchImpl,
    );

    assert.ok(result.ok, `assinatura deveria ter sucesso, got: ${JSON.stringify(result)}`);
    const hasSequenceCall = calls.some(c => c.url.includes("/sequences/"));
    assert.equal(hasSequenceCall, false, "NUNCA deveria tentar adicionar à sequence sem KIT_WELCOME_SEQUENCE_ID");
  });

  it("falha ao adicionar à sequence NÃO reverte o sucesso da assinatura (best-effort)", async () => {
    let callCount = 0;
    const fetchImpl = async (input: URL | RequestInfo, init?: RequestInit) => {
      const u = String(input);
      callCount++;
      if (u.includes("/sequences/")) {
        // Sequence link fails — should NOT affect the subscription result
        return new Response(
          JSON.stringify({ error: "subscriber already in sequence" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ subscriber: { id: 99999 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await subscribeViaConfiguredBackend(
      { ...baseEnv, KIT_WELCOME_SEQUENCE_ID: "2876508" },
      { name: "Teste", email: "teste@example.com" },
      fetchImpl,
    );

    assert.ok(result.ok, `falha na sequence não deveria reverter a assinatura, got: ${JSON.stringify(result)}`);
    assert.equal(result.status, 200, "status deveria ser 200 (sucesso da assinatura)");
  });

  it("KIT_WELCOME_SEQUENCE_ID inválido (não numérico) → loga erro sem quebrar", async () => {
    const calls: { url: string }[] = [];
    const fetchImpl = async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input) });
      return new Response(
        JSON.stringify({ subscriber: { id: 99999 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await subscribeViaConfiguredBackend(
      { ...baseEnv, KIT_WELCOME_SEQUENCE_ID: "invalid" },
      { name: "Teste", email: "teste@example.com" },
      fetchImpl,
    );

    assert.ok(result.ok, `KIT_WELCOME_SEQUENCE_ID inválido não deveria quebrar a assinatura, got: ${JSON.stringify(result)}`);
    const hasSequenceCall = calls.some(c => c.url.includes("/sequences/"));
    assert.equal(hasSequenceCall, false, "não deveria tentar a sequence com ID inválido");
  });
});