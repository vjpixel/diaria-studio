/**
 * test/brevo-client-quota-wiring-5697.test.ts (#5697)
 *
 * Cobre a PONTA de gravação em brevo-client.ts: toda resposta de um path
 * `/emailCampaigns*` grava `x-sib-ratelimit-remaining`/`-limit` no estado de
 * cota (via os dois pontos de `fetch` reais — `brevoRawFetch`, exercitado
 * aqui por `brevoGetCampaign`, e `brevoGet`, exercitado por
 * `fetchCampaignsByStatus`); qualquer outro path (ex: `/contacts/lists/*`)
 * NUNCA grava — a reserva é só pra família que tem o teto apertado.
 *
 * Estes testes usam o path DEFAULT real (`DEFAULT_RATE_STATE_PATH`, dentro
 * de `data/`) porque `brevo-client.ts` não aceita um path de estado
 * injetável (seria acoplamento desnecessário na API pública do client só
 * pra teste) — o próprio módulo `brevo-rate-state.ts` já tem cobertura
 * isolada via path injetável em `test/brevo-rate-state-5697.test.ts`. Este
 * arquivo limpa `data/` no `afterEach` se ele não existia antes do teste
 * (`data/` é gitignored e, neste worktree, não é o junction real do
 * OneDrive — ausente por padrão).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  brevoGetCampaign,
  fetchCampaignsByStatus,
  brevoGetList,
} from "../scripts/lib/brevo-client.ts";
import { DEFAULT_RATE_STATE_PATH, readCampaignQuotaState } from "../scripts/lib/brevo-rate-state.ts";

const stateDir = dirname(DEFAULT_RATE_STATE_PATH);
let dirPreexisted: boolean;

beforeEach(() => {
  dirPreexisted = existsSync(stateDir);
  if (existsSync(DEFAULT_RATE_STATE_PATH)) rmSync(DEFAULT_RATE_STATE_PATH);
});

afterEach(() => {
  if (existsSync(DEFAULT_RATE_STATE_PATH)) rmSync(DEFAULT_RATE_STATE_PATH);
  if (!dirPreexisted && existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true });
});

function makeJsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as Response);
}

describe("brevo-client.ts grava cota da família /emailCampaigns* (#5697)", () => {
  it("brevoGetCampaign (via brevoRawFetch) grava remaining/limit no estado", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      makeJsonResponse(
        { id: 42, name: "campanha x", status: "sent" },
        { "x-sib-ratelimit-remaining": "17", "x-sib-ratelimit-limit": "100" },
      )) as unknown as typeof fetch;
    try {
      await brevoGetCampaign("fake-key", 42);
      const state = readCampaignQuotaState();
      assert.ok(state, "estado deveria ter sido gravado");
      assert.equal(state!.remaining, 17);
      assert.equal(state!.limit, 100);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("fetchCampaignsByStatus (via brevoGet) grava remaining/limit no estado", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      makeJsonResponse(
        { campaigns: [] },
        { "x-sib-ratelimit-remaining": "8", "x-sib-ratelimit-limit": "100" },
      )) as unknown as typeof fetch;
    try {
      await fetchCampaignsByStatus("fake-key", "sent");
      const state = readCampaignQuotaState();
      assert.ok(state);
      assert.equal(state!.remaining, 8);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("path fora da família /emailCampaigns* (ex: /contacts/lists/*) NUNCA grava estado", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      makeJsonResponse(
        { id: 7, name: "lista x", totalSubscribers: 10 },
        { "x-sib-ratelimit-remaining": "3", "x-sib-ratelimit-limit": "36000" },
      )) as unknown as typeof fetch;
    try {
      await brevoGetList("fake-key", 7);
      assert.equal(readCampaignQuotaState(), null, "chamada fora da família não deveria gravar nada");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("resposta sem os headers de rate-limit não grava (nem quebra a chamada)", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => makeJsonResponse({ id: 1, name: "x", status: "sent" })) as unknown as typeof fetch;
    try {
      const campaign = await brevoGetCampaign("fake-key", 1);
      assert.equal(campaign.id, 1);
      assert.equal(readCampaignQuotaState(), null);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
