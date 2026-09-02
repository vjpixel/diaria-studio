/**
 * test/apoio-gate.test.ts (#7030, achado do review do PR #7038)
 *
 * Cobre `checkApoioGate` diretamente — em particular a distinção `reason:
 * "unknown"` × `reason: "confirmed_negative"` (documentada em
 * `workers/artigos/src/apoio-gate.ts`, paralela ao #4321 do `workers/cursos`).
 * A resposta HTTP ao visitante é intencionalmente idêntica nos dois casos
 * (anti-probing) — só o `reason` no valor de retorno distingue, útil se um
 * log/alarme futuro vier a consumi-lo. Sem este teste, o comportamento de
 * `reason` só era coberto indiretamente via HTTP (que não expõe o campo).
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { checkApoioGate } from "../workers/artigos/src/apoio-gate.ts";
import type { Env } from "../workers/artigos/src/index.ts";

function fakeEnv(store: Record<string, string>): Env {
  return {
    ASSETS: {} as Fetcher,
    ARTIGOS_APOIO_NIVEL: {
      get: mock.fn(async (key: string) => store[key] ?? null),
    } as unknown as KVNamespace,
    COOKIE_HMAC_SECRET: "test-secret",
  };
}

describe("checkApoioGate (#7030)", () => {
  it("e-mail sem entrada no KV → not_eligible, reason unknown", async () => {
    const outcome = await checkApoioGate(fakeEnv({}), "nunca-apoiou@example.com");
    assert.deepEqual(outcome, { status: "not_eligible", reason: "unknown" });
  });

  it("e-mail com nível abaixo do limiar → not_eligible, reason confirmed_negative", async () => {
    const email = "amigo@example.com";
    const key = `apoio:${await sha256HexFor(email)}`;
    const outcome = await checkApoioGate(fakeEnv({ [key]: "amigo" }), email);
    assert.deepEqual(outcome, { status: "not_eligible", reason: "confirmed_negative" });
  });

  it("e-mail com nível no/acima do limiar → meets_threshold, sem reason", async () => {
    const email = "apoiador@example.com";
    const key = `apoio:${await sha256HexFor(email)}`;
    const outcome = await checkApoioGate(fakeEnv({ [key]: "apoiador" }), email);
    assert.deepEqual(outcome, { status: "meets_threshold" });
  });
});

// Duplica só o suficiente pra montar a chave KV nos testes acima — a
// implementação real (`apoioLevelKvKey`) já tem cobertura própria em
// test/apoio-level-verify.test.ts; aqui só precisamos do mesmo hash.
async function sha256HexFor(input: string): Promise<string> {
  const { apoioLevelKvKey } = await import("../scripts/lib/shared/apoio-level-verify.ts");
  const full = await apoioLevelKvKey(input);
  return full.slice("apoio:".length);
}
