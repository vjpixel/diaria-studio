/**
 * test/poll-img-key-allowlist-4112.test.ts (#4112)
 *
 * P0 do review do "É IA?" (260727), CONFIRMADO em produção antes do fix:
 * `GET /img/{key}` passava a chave crua da URL direto pro `env.POLL.get()`,
 * sem allowlist de prefixo — virando um leitor arbitrário do KV inteiro, sem
 * autenticação e com `Access-Control-Allow-Origin: *`.
 *
 * O que estava exposto (verificado ao vivo em eia.diar.ia.br):
 *   - `correct:{edition}` — o gabarito do dia, gravado no Stage 4 (antes do
 *     e-mail sair). Spoiler total do jogo, para qualquer um, sem votar.
 *   - `leaderboard-snapshot:{slug}` — e-mails dos leitores EM CLARO (o
 *     snapshot persiste `email` cru), derrubando `maskEmail` (#3118) e
 *     `hashEmailForMatch` (#4029).
 *   - `score:{email}`, `vote:{edition}:{email}`, `nickname:{apelido}` — dado
 *     individual, e harvest de e-mail a partir dos apelidos públicos.
 *
 * Os testes abaixo travam as DUAS pontas: nenhuma chave de estado é servível,
 * e toda chave de imagem legítima continua servida (URLs de imagem já saíram
 * em edições passadas — quebrá-las seria uma regressão visível em e-mail
 * antigo).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../workers/poll/src/index.ts";

function makeEnv() {
  const store = new Map<string, string>();
  return {
    POLL: {
      get: async (key: string, type?: string) => {
        const v = store.get(key);
        if (v === undefined) return null;
        if (type === "arrayBuffer") return new TextEncoder().encode(v).buffer;
        return v;
      },
      put: async (key: string, value: string) => void store.set(key, value),
      list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
      delete: async () => {},
    },
    __store: store,
  } as never;
}

describe("GET /img/{key} — allowlist de prefixo (#4112)", () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    env = makeEnv();
    const store = (env as unknown as { __store: Map<string, string> }).__store;
    // Imagem legítima (convenção real do pipeline).
    store.set("img-260724-01-eia-A.jpg", "JPEGBYTES");
    store.set("img-monthly-2606-capa.jpg", "JPEGBYTES");
    // Chaves de ESTADO que vazavam antes do fix.
    store.set("correct:260727", "A");
    store.set("leaderboard-snapshot:2026-07", JSON.stringify([{ email: "leitor@example.com", correct: 9 }]));
    store.set("score:leitor@example.com", JSON.stringify({ total: 10, correct: 9 }));
    store.set("vote:260727:leitor@example.com", JSON.stringify({ choice: "A" }));
    store.set("nickname:pixel", "leitor@example.com");
    store.set("eiameta:260727", JSON.stringify({ description: "d", credit: "c" }));
    store.set("stats:260727", JSON.stringify({ total: 5 }));
    store.set("valid_editions", "260727");
    store.set("clarice:correct:2606-07", "B");
  });

  it("serve imagem legítima (img-{edition}-{basename})", async () => {
    const res = await worker.fetch(new Request("https://poll.test/img/img-260724-01-eia-A.jpg"), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "image/jpeg");
  });

  it("serve imagem do fluxo mensal (img-monthly-*)", async () => {
    const res = await worker.fetch(new Request("https://poll.test/img/img-monthly-2606-capa.jpg"), env);
    assert.equal(res.status, 200);
  });

  for (const leaked of [
    "correct:260727",
    "leaderboard-snapshot:2026-07",
    "score:leitor@example.com",
    "vote:260727:leitor@example.com",
    "nickname:pixel",
    "eiameta:260727",
    "stats:260727",
    "valid_editions",
    "clarice:correct:2606-07",
  ]) {
    it(`REGRESSÃO P0: /img/${leaked} NÃO é servido`, async () => {
      const res = await worker.fetch(
        new Request(`https://poll.test/img/${encodeURIComponent(leaked)}`),
        env,
      );
      assert.equal(res.status, 404, `chave de estado "${leaked}" continua servível`);
      const body = await res.text();
      assert.doesNotMatch(body, /@/, "resposta não pode conter e-mail");
      assert.equal(body, "not found");
    });
  }

  it("REGRESSÃO P0: percent-encoding não contorna a allowlist (%3A → ':')", async () => {
    // `decodeURIComponent` roda ANTES da checagem — um `:` escondido como
    // %3A tem que ser barrado igual.
    const res = await worker.fetch(new Request("https://poll.test/img/correct%3A260727"), env);
    assert.equal(res.status, 404);
  });

  it("double-encoding (%253A) não vira ':' — só há UM decode antes do get", async () => {
    // `new URL().pathname` não decodifica (WHATWG), e `decodeURIComponent`
    // roda exatamente uma vez em handleImage. Então `%253A` vira o literal
    // "%3A", nunca um `:` de verdade — não colide com chave de estado.
    // Não é explorável; o teste trava o invariante "um decode só".
    const res = await worker.fetch(new Request("https://poll.test/img/correct%253A260727"), env);
    assert.equal(res.status, 404);
  });

  it("REGRESSÃO P0: prefixo img- não pode ser usado como fachada pra chave com namespace", async () => {
    const store = (env as unknown as { __store: Map<string, string> }).__store;
    store.set("img-x:correct:260727", "A");
    const res = await worker.fetch(new Request("https://poll.test/img/img-x%3Acorrect%3A260727"), env);
    assert.equal(res.status, 404);
  });

  it("`%` malformado devolve 404, não 500 (URIError não tratado)", async () => {
    const res = await worker.fetch(new Request("https://poll.test/img/%"), env);
    assert.equal(res.status, 404);
  });

  it("chave inexistente com prefixo válido continua 404 com CORS", async () => {
    const res = await worker.fetch(new Request("https://poll.test/img/img-999999-nao-existe.jpg"), env);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  });
});
