/**
 * test/poll-vote-test-account-future-edition-3384.test.ts (#3384)
 *
 * Regressão: contas de teste do editor (pixel@memelab.com.br, vjpixel@gmail.com)
 * devem poder votar numa edição AAMMDD futura (ex: no e-mail de teste do Stage 5,
 * rodado na véspera — a edição ainda é "de amanhã" no momento do teste), enquanto
 * o gate de edição-futura (#3113 item 9) continua bloqueando qualquer outra conta.
 *
 * Mesmo padrão de test/poll-archive-future-edition-month-grouping-3113.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleVote } from "../workers/poll/src/vote.ts";
import type { Env } from "../workers/poll/src/index.ts";

/** "Amanhã" em AAMMDD, calculado a partir do relógio real — evita data futura
 * hardcoded que vira passado com o tempo. */
function tomorrowEdition(): string {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const yy = String(tomorrow.getUTCFullYear()).slice(2);
  const mm = String(tomorrow.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(tomorrow.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

function makeVoteEnv(seed: Record<string, string>): Env {
  return {
    POLL: {
      get: async (key: string) => seed[key] ?? null,
      put: async () => {},
    } as unknown as Env["POLL"],
    POLL_SECRET: "test-secret",
    ADMIN_SECRET: "test-admin",
    ALLOWED_ORIGINS: "*",
  };
}

describe("handleVote — contas de teste isentas do gate de edição futura (#3384)", () => {
  for (const testEmail of ["pixel@memelab.com.br", "vjpixel@gmail.com"]) {
    it(`${testEmail} vota edição de amanhã com gabarito já definido → 200 (aceito)`, async () => {
      const edition = tomorrowEdition();
      const env = makeVoteEnv({ [`correct:${edition}`]: "A" });
      const url = new URL(
        `https://poll.diaria.workers.dev/vote?email=${encodeURIComponent(testEmail)}&edition=${edition}&choice=A`,
      );
      const res = await handleVote(url, env, "diaria");
      assert.equal(res.status, 200, `esperado 200 para conta de teste; body: ${await res.text()}`);
    });

    it(`${testEmail} em maiúsculas (Beehiiv merge tag) ainda é reconhecido como conta de teste`, async () => {
      const edition = tomorrowEdition();
      const env = makeVoteEnv({ [`correct:${edition}`]: "A" });
      const url = new URL(
        `https://poll.diaria.workers.dev/vote?email=${encodeURIComponent(testEmail.toUpperCase())}&edition=${edition}&choice=A`,
      );
      const res = await handleVote(url, env, "diaria");
      assert.equal(res.status, 200, `esperado 200 (email normalizado internamente); body: ${await res.text()}`);
    });
  }

  it("conta normal (não-allowlisted) continua bloqueada (410) na mesma edição futura", async () => {
    const edition = tomorrowEdition();
    const env = makeVoteEnv({ [`correct:${edition}`]: "A" });
    const url = new URL(
      `https://poll.diaria.workers.dev/vote?email=leitor@x.com&edition=${edition}&choice=A`,
    );
    const res = await handleVote(url, env, "diaria");
    assert.equal(res.status, 410);
    const html = await res.text();
    assert.match(html, /não aceita mais votos/);
  });
});
