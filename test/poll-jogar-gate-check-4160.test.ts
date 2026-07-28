/**
 * test/poll-jogar-gate-check-4160.test.ts (#4160)
 *
 * O gate-check client-side (jogar.ts, dentro de `goNext`, na transição de
 * rodada 1 → 2 da sequência) fazia `html.indexOf('id="gate-form"') !== -1`
 * pra decidir se o servidor respondeu com a tela de gate — mas esse `if` (e o
 * comentário logo acima citando a mesma string) moram DENTRO do template
 * literal que gera a própria página de SEQUÊNCIA. A agulha se encontrava a
 * si mesma: a busca era SEMPRE `!== -1`, pra qualquer resposta de `/jogar`
 * (gate ou não).
 *
 * Fix: `renderJogarGatePage` passa a ser servida com um header dedicado
 * (`X-Eia-Gate: 1`) nos dois call sites (`handleJogarPage` em jogar.ts,
 * `GET /jogar/gate` em index.ts) — o cliente checa
 * `res.headers.get("X-Eia-Gate")`, zero acoplamento com o corpo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker, { type Env } from "../workers/poll/src/index.ts";
import { renderJogarSequencePageHtml } from "../workers/poll/src/jogar.ts";
import { renderJogarGatePage, ROUNDS_PLAYED_COOKIE } from "../workers/poll/src/web-gate.ts";

function makeMapKV(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    async get(key: string) {
      const v = m.get(key);
      return v === undefined ? null : v;
    },
    async getWithMetadata(key: string) {
      const v = m.get(key);
      return { value: v ?? null, metadata: null };
    },
    async put(key: string, value: string) {
      m.set(key, value);
    },
    async delete(key: string) {
      m.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string; cursor?: string } = {}) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
  };
}

const makeEnv = (overrides: Partial<Env> = {}): Env => ({
  POLL: makeMapKV() as unknown as KVNamespace,
  POLL_SECRET: "poll-secret",
  ADMIN_SECRET: "admin-secret",
  ALLOWED_ORIGINS: "*",
  COOKIE_HMAC_SECRET: "cookie-secret",
  ...overrides,
});

describe("#4160: a página de SEQUÊNCIA nunca contém a agulha id=\"gate-form\" (anônima e identificada)", () => {
  it("renderJogarSequencePageHtml (sem sessão, caso anônimo) NÃO contém a string usada pelo gate-check do cliente", () => {
    const html = renderJogarSequencePageHtml(["260701", "260702"]);
    assert.doesNotMatch(html, /id="gate-form"/, "a página de sequência não pode conter a agulha do gate-check — ela sempre se encontraria a si mesma");
  });

  it("renderJogarSequencePageHtml com 0 edições (caso 'identificado'/mês sem pares ainda) também não contém a agulha", () => {
    const html = renderJogarSequencePageHtml([]);
    assert.doesNotMatch(html, /id="gate-form"/);
  });

  it("a página de sequência SERVIDA via GET /jogar (sem cookie de rodada livre) não contém a agulha", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/jogar"), env);
    const html = await res.text();
    assert.doesNotMatch(html, /id="gate-form"/);
  });
});

describe("#4160: a página de GATE carrega o sinal X-Eia-Gate — a página de sequência não", () => {
  it("renderJogarGatePage contém id=\"gate-form\" (é a própria página de gate — esperado, é o corpo real do form)", () => {
    const html = renderJogarGatePage(null);
    assert.match(html, /id="gate-form"/);
  });

  it("GET /jogar com ROUNDS_PLAYED_COOKIE no limiar e SEM sessão → resposta é o gate, com header X-Eia-Gate: 1", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://poll.test/jogar", { headers: { Cookie: `${ROUNDS_PLAYED_COOKIE}=5` } }),
      env,
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Eia-Gate"), "1");
    const html = await res.text();
    assert.match(html, /Quer disputar o ranking\?/);
  });

  it("GET /jogar SEM o cookie de rodada livre (jogo normal) → SEM o header X-Eia-Gate", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/jogar"), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Eia-Gate"), null);
  });

  it("GET /jogar/gate (rota direta, index.ts) também carrega o header X-Eia-Gate: 1", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/jogar/gate"), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Eia-Gate"), "1");
    const html = await res.text();
    assert.match(html, /id="gate-form"/);
  });
});
