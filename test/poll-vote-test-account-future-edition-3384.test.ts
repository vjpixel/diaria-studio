/**
 * test/poll-vote-test-account-future-edition-3384.test.ts (#3384, #6902)
 *
 * Regressão #3384: contas de teste do editor (TEST_ACCOUNT_EMAILS) devem poder
 * votar numa edição AAMMDD futura (ex: no e-mail de teste do Stage 5, rodado na
 * véspera — a edição ainda é "de amanhã" no momento do teste), enquanto o gate de
 * edição-futura (#3113 item 9) continua bloqueando qualquer outra conta.
 *
 * Regressão #6902: TEST_ACCOUNT_EMAILS agora deriva de EDITOR_SEED_EMAILS (5
 * endereços, não mais 2 hardcoded). Além disso, a mensagem 410 pro caso de
 * edição FUTURA (ainda não enviada) foi distinta da mensagem pro caso de edição
 * EXPIRADA (já fechada) — "não aceita mais votos" só deve aparecer no caminho
 * expirado; a edição futura tem mensagem aclaradora.
 *
 * Mesmo padrão de test/poll-archive-future-edition-month-grouping-3113.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EDITOR_SEED_EMAILS } from "../scripts/lib/editor-copy.ts";
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

/** "Ontem" em AAMMDD — edição passada cujo gabarito nunca foi setado (simula
 * expirada/nunca-existente, para testar a mensagem distinta do #6902). */
function yesterdayEdition(): string {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yy = String(yesterday.getUTCFullYear()).slice(2);
  const mm = String(yesterday.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(yesterday.getUTCDate()).padStart(2, "0");
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

describe("handleVote — contas de teste isentas do gate de edição futura (#3384, #6902)", () => {
  // #6902: TEST_ACCOUNT_EMAILS deriva de EDITOR_SEED_EMAILS — todas as 5 sementes
  // do editor devem passar pelo gate de edição futura, não só as 2 originalmente
  // hardcoded. Itera sobre a fonte canônica diretamente (nunca uma lista fixa no
  // teste — senão o teste mascara a própria regressão #6902).
  for (const testEmail of EDITOR_SEED_EMAILS) {
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

  it("conta normal (não-allowlisted) é bloqueada (410) na edição futura com mensagem distinta (#6902)", async () => {
    const edition = tomorrowEdition();
    const env = makeVoteEnv({ [`correct:${edition}`]: "A" });
    const url = new URL(
      `https://poll.diaria.workers.dev/vote?email=leitor@x.com&edition=${edition}&choice=A`,
    );
    const res = await handleVote(url, env, "diaria");
    assert.equal(res.status, 410);
    const html = await res.text();
    // #6902: edição FUTURA → mensagem "ainda não foi enviada", NÃO "não aceita mais votos".
    assert.match(html, /ainda não foi enviada/);
    assert.doesNotMatch(html, /não aceita mais votos/);
  });

  it("edição expirada sem gabarito mantém mensagem 'não aceita mais votos' (#6902 — caso não regressivo)", async () => {
    // ontem, sem gabarito setado, e valid_editions populado SEM incluir ontem
    // → cai no gate de edição expirada/nunca-existente (correctRaw===null + NOT valid).
    const edition = yesterdayEdition();
    const env = makeVoteEnv({ valid_editions: JSON.stringify([tomorrowEdition()]) });
    const url = new URL(
      `https://poll.diaria.workers.dev/vote?email=leitor@x.com&edition=${edition}&choice=A`,
    );
    const res = await handleVote(url, env, "diaria");
    assert.equal(res.status, 410);
    const html = await res.text();
    assert.match(html, /não aceita mais votos/);
  });
});
