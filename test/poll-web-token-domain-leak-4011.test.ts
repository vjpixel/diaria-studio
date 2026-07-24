/**
 * test/poll-web-token-domain-leak-4011.test.ts (#4011)
 *
 * O #3976/#3989 adicionou `isValidWebToken` pra rejeitar token forjado sob o
 * domínio reservado `web.eia.diaria.local` — mas o guard em `handleVote`
 * (vote.ts) estava atrás de `if (brand === "web")`. Um e-mail forjado sob esse
 * domínio era REJEITADO no brand web (guard correto), mas ACEITO sob QUALQUER
 * outro brand (o `/vote` sem `?brand=` cai no default "diaria", modo
 * merge-tag sem sig — #1236) — gravando score/vote/counted/score-by-month
 * reais no namespace diária.
 *
 * Reproduzido ao vivo pelo editor (260724) e purgado manualmente:
 * `GET /vote?email=hacker123@web.eia.diaria.local&edition=260601&choice=A`
 * (sem `?brand=`) → HTTP 200, criou `score:hacker123@web.eia.diaria.local` +
 * 5 chaves no brand diária.
 *
 * Por que importa: `.eia.diaria.local` é um domínio RESERVADO — não tem
 * razão de existir sob NENHUM brand além de "web". Aceitar sob outro brand
 * reabre a mesma classe de poluição do ranking que o #3976 fechou, só no
 * brand vizinho.
 *
 * Fix: a condição de rejeição em `handleVote` agora é
 * `(brand === "web" || isAnonymousWebIdentity(email)) && !isValidWebToken(email)`
 * — cobre tanto o caso original do #3976 (brand==="web" sem token válido)
 * quanto o caso novo do #4011 (e-mail sob o domínio reservado em QUALQUER
 * outro brand). `isAnonymousWebIdentity` (lib.ts, #3975) já existia como
 * checagem SÓ de domínio (mais ampla que `isValidWebToken`, que também exige
 * forma UUID v4) — reusada aqui em vez de duplicar a checagem de domínio.
 *
 * NÃO faz nenhuma chamada de rede real — todo o KV é mockado em memória
 * (mesmo padrão de test/poll-uuid-guard-leaderboard-3976.test.ts). Nunca
 * repetir o teste ao vivo contra o Worker de produção (o editor já
 * reproduziu e limpou manualmente).
 *
 * Cobre os 3 casos explícitos da issue:
 *   1. E-mail forjado sob `@web.eia.diaria.local` sob brand diária → 400.
 *   2. Forjado sob brand web SEM UUID válido → 400 (comportamento pré-
 *      existente do #3976, confirma que continua).
 *   3. UUID válido sob brand web → 200 (comportamento pré-existente,
 *      confirma que continua).
 *
 * Também confirma o fluxo LEGÍTIMO não regride: e-mail comum de assinante
 * sob brand diária (fora do domínio reservado) continua 200 normalmente —
 * o alvo do fix é estreito (só o domínio reservado fora do brand web), não
 * o modo merge-tag em si.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isValidWebToken, isAnonymousWebIdentity, WEB_TOKEN_DOMAIN } from "../workers/poll/src/lib.ts";
import worker, { type Env } from "../workers/poll/src/index.ts";

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
    _map: m,
  };
}

const makeEnv = (seed: Record<string, string> = {}): Env & { POLL: ReturnType<typeof makeMapKV> } => ({
  POLL: makeMapKV(seed),
  POLL_SECRET: "poll-secret",
  ADMIN_SECRET: "admin-secret",
  ALLOWED_ORIGINS: "*",
});

const VALID_TOKEN = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const VALID_WEB_EMAIL = `${VALID_TOKEN}@${WEB_TOKEN_DOMAIN}`;
const FORGED_EMAIL = `hacker123@${WEB_TOKEN_DOMAIN}`;

describe("isAnonymousWebIdentity + isValidWebToken (pure, #4011)", () => {
  it("e-mail forjado sob o domínio reservado é detectado por isAnonymousWebIdentity mesmo não sendo UUID", () => {
    assert.equal(isAnonymousWebIdentity(FORGED_EMAIL), true);
    assert.equal(isValidWebToken(FORGED_EMAIL), false);
  });

  it("e-mail comum (fora do domínio reservado) não é identidade anônima do web", () => {
    assert.equal(isAnonymousWebIdentity("leitor@example.com"), false);
  });
});

describe("#4011: e-mail forjado sob @web.eia.diaria.local é rejeitado em QUALQUER brand", () => {
  it("caso 1 (achado da issue): brand diária (default, sem ?brand=) → 400, nada gravado no KV", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent(FORGED_EMAIL)}&edition=260601&choice=A`),
      env,
    );
    assert.equal(res.status, 400);
    assert.equal(env.POLL._map.size, 0, "nenhuma key deveria ser escrita — domínio reservado fora do brand web");
  });

  it("mesmo domínio reservado explicitado com ?brand=diaria → 400", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent(FORGED_EMAIL)}&edition=260601&choice=A&brand=diaria`),
      env,
    );
    assert.equal(res.status, 400);
    assert.equal(env.POLL._map.size, 0);
  });

  it("domínio reservado sob brand=clarice → 400 (o domínio é reservado, não só fora do default)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent(FORGED_EMAIL)}&edition=260601&choice=A&brand=clarice`),
      env,
    );
    assert.equal(res.status, 400);
    assert.equal(env.POLL._map.size, 0);
  });

  it("caso 2 (regressão #3976): brand web SEM UUID válido continua 400", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent(FORGED_EMAIL)}&edition=260601&choice=A&brand=web`),
      env,
    );
    assert.equal(res.status, 400);
    assert.equal(env.POLL._map.size, 0);
  });

  it("caso 3 (regressão #3976): UUID válido sob brand web continua 200, voto gravado", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent(VALID_WEB_EMAIL)}&edition=260601&choice=A&brand=web`),
      env,
    );
    assert.equal(res.status, 200);
    assert.ok(env.POLL._map.has(`web:vote:260601:${VALID_WEB_EMAIL}`));
  });
});

describe("regressão: fluxo legítimo de voto por e-mail arbitrário no brand diária não é afetado", () => {
  it("e-mail comum de assinante (fora do domínio reservado) sob brand diária continua 200", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://poll.test/vote?email=leitor@example.com&edition=260601&choice=A"),
      env,
    );
    assert.equal(res.status, 200);
  });

  it("e-mail comum de assinante sob brand clarice continua 200", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://poll.test/vote?email=leitor@example.com&edition=260601&choice=A&brand=clarice"),
      env,
    );
    assert.equal(res.status, 200);
  });
});
