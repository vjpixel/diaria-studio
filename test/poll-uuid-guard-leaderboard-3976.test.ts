/**
 * test/poll-uuid-guard-leaderboard-3976.test.ts (#3976)
 *
 * Entrada fantasma `verify1840428@web.eia.diaria.local` no leaderboard
 * público do jogo web — NÃO é e-mail de ninguém real, é um pseudo-email do
 * jogo (`/jogar`) cujo local-part deveria ser SEMPRE um UUID v4 gerado
 * client-side (`crypto.randomUUID()`, `anonEmailForToken` em jogar.ts).
 * `verify1840428` não é UUID → foi forjado por um HTTP client externo
 * (bot/scanner) exercitando os endpoints diretamente, sem passar pelo
 * client oficial (`/jogar`).
 *
 * Causa raiz: `isValidVoteEmailFormat` (lib.ts) só valida a FORMA genérica
 * `local@domínio.tld` — aceita QUALQUER local-part, não distingue um token
 * legítimo de um forjado. Fix: `isValidWebToken` (lib.ts) — guard adicional
 * exigindo local-part UUID v4 SOB o domínio reservado `web.eia.diaria.local`,
 * aplicado em TODOS os pontos de entrada que aceitam a identidade anônima do
 * brand `web`:
 *
 *   - `handleVote` (vote.ts, `GET /vote`) quando `brand === "web"`.
 *   - `handleJogarSeqState` (jogar.ts, `GET /jogar/seq-state`) — endpoint
 *     exclusivo do brand `web`, sempre valida.
 *
 * `GET /jogar/quiz/answer` (jogar.ts, `handleQuizAnswer`) NÃO aceita e-mail
 * (endpoint read-only só com `?edition=`) — não precisa do guard, confirmado
 * lendo o handler (sem parâmetro de identidade).
 *
 * Cobre:
 *   - `isValidWebToken` (pure, lib.ts): UUID v4 válido passa; local-part
 *     arbitrário (padrão do achado, "verify1840428") é rejeitado; domínio
 *     errado é rejeitado mesmo com UUID válido (fecha o escape trivial de
 *     "trocar de domínio pra fugir do guard"); variante/versão fora do
 *     padrão UUID v4 é rejeitada; case-insensitive (hex maiúsculo aceito).
 *   - `GET /vote?brand=web`: token UUID válido → 200 (grava voto); token
 *     forjado (não-UUID) → 400; UUID válido mas domínio errado → 400.
 *   - Regressão: `brand=diaria`/`brand=clarice` (que usam e-mail real de
 *     assinante, não o pseudo-token do jogo) NÃO são afetados pelo guard —
 *     continuam aceitando qualquer formato de e-mail válido (isValidVoteEmailFormat
 *     de sempre), mesmo um local-part que "parece" o padrão do achado.
 *   - `GET /jogar/seq-state`: token UUID válido → 200; token forjado → 400.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isValidWebToken, WEB_TOKEN_DOMAIN } from "../workers/poll/src/lib.ts";
import worker, { type Env } from "../workers/poll/src/index.ts";

// ── isValidWebToken (pure, lib.ts) ──────────────────────────────────────────

describe("isValidWebToken (pure, #3976)", () => {
  it("UUID v4 válido sob o domínio reservado → true", () => {
    assert.equal(isValidWebToken("3fa85f64-5717-4562-b3fc-2c963f66afa6@web.eia.diaria.local"), true);
  });

  it("case-insensitive: UUID v4 em maiúsculas também é aceito", () => {
    assert.equal(isValidWebToken("3FA85F64-5717-4562-B3FC-2C963F66AFA6@web.eia.diaria.local"), true);
  });

  it("achado #3976: local-part arbitrário ('verify1840428', não-UUID) → false", () => {
    assert.equal(isValidWebToken(`verify1840428@${WEB_TOKEN_DOMAIN}`), false);
  });

  it("fecha a classe inteira — qualquer local-part não-UUID é rejeitado, não só o padrão 'verify*'", () => {
    for (const bogus of ["not-a-uuid", "123456", "admin", "a", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]) {
      assert.equal(isValidWebToken(`${bogus}@${WEB_TOKEN_DOMAIN}`), false, `"${bogus}" deveria ser rejeitado`);
    }
  });

  it("nibble de versão errado (não '4') → false, mesmo com forma 8-4-4-4-12 hex válida", () => {
    // 3º grupo deveria começar com "4" (versão) — aqui começa com "5".
    assert.equal(isValidWebToken(`3fa85f64-5717-5562-b3fc-2c963f66afa6@${WEB_TOKEN_DOMAIN}`), false);
  });

  it("nibble de variante errado (fora de 8/9/a/b) → false", () => {
    // 4º grupo deveria começar com 8/9/a/b — aqui começa com "3".
    assert.equal(isValidWebToken(`3fa85f64-5717-4562-3b3fc-2c963f66afa@${WEB_TOKEN_DOMAIN}`), false);
  });

  it("domínio errado → false MESMO com local-part UUID v4 válido (fecha o escape trivial 'trocar de domínio')", () => {
    assert.equal(isValidWebToken("3fa85f64-5717-4562-b3fc-2c963f66afa6@evil.com"), false);
    assert.equal(isValidWebToken("3fa85f64-5717-4562-b3fc-2c963f66afa6@web.eia.diaria.local.evil.com"), false);
  });

  it("sem '@' → false, nunca lança", () => {
    assert.doesNotThrow(() => assert.equal(isValidWebToken("sem-arroba"), false));
  });

  it("string vazia → false, nunca lança", () => {
    assert.doesNotThrow(() => assert.equal(isValidWebToken(""), false));
  });
});

// ── GET /vote?brand=web ──────────────────────────────────────────────────

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
const VALID_EMAIL = `${VALID_TOKEN}@web.eia.diaria.local`;

describe("GET /vote?brand=web — guard de UUID v4 (#3976)", () => {
  it("token UUID v4 válido → 200, voto gravado normalmente", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent(VALID_EMAIL)}&edition=260701&choice=A&brand=web`),
      env,
    );
    assert.equal(res.status, 200);
    assert.ok(env.POLL._map.has(`web:vote:260701:${VALID_EMAIL}`));
  });

  it("achado #3976: token forjado 'verify1840428' → 400, nada gravado no KV", async () => {
    const env = makeEnv();
    const bogusEmail = "verify1840428@web.eia.diaria.local";
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent(bogusEmail)}&edition=260701&choice=A&brand=web`),
      env,
    );
    assert.equal(res.status, 400);
    assert.equal(env.POLL._map.size, 0, "nenhuma key deveria ser escrita pra um token rejeitado");
  });

  it("token UUID v4 válido mas domínio diferente do reservado → 400", async () => {
    const env = makeEnv();
    const email = `${VALID_TOKEN}@evil.com`;
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent(email)}&edition=260701&choice=A&brand=web`),
      env,
    );
    assert.equal(res.status, 400);
  });

  it("mensagem 400 é a mesma de 'link inválido' já usada pros outros gates de forma (sem vazar detalhe do guard)", async () => {
    const env = makeEnv();
    const bogusEmail = "verify1840428@web.eia.diaria.local";
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent(bogusEmail)}&edition=260701&choice=A&brand=web`),
      env,
    );
    const html = await res.text();
    assert.match(html, /Link inválido/);
  });
});

describe("regressão: brand=diaria/clarice não são afetados pelo guard do brand web (#3976)", () => {
  it("brand=diaria (default) com e-mail real de assinante continua 200 — guard só se aplica a brand=web", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://poll.test/vote?email=leitor@example.com&edition=260701&choice=A"),
      env,
    );
    assert.equal(res.status, 200);
  });

  it("brand=clarice com um local-part 'estilo achado' (não-UUID) continua 200 — guard é específico do brand web", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://poll.test/vote?email=verify1840428@algum-dominio.com&edition=260701&choice=A&brand=clarice"),
      env,
    );
    assert.equal(res.status, 200);
  });
});

// ── GET /jogar/seq-state ──────────────────────────────────────────────────

describe("GET /jogar/seq-state — guard de UUID v4 (#3976)", () => {
  it("token UUID v4 válido → 200", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request(`https://poll.test/jogar/seq-state?email=${encodeURIComponent(VALID_EMAIL)}&editions=260701`),
      env,
    );
    assert.equal(res.status, 200);
  });

  it("achado #3976: token forjado 'verify1840428' → 400 (endpoint é exclusivo do brand web)", async () => {
    const env = makeEnv();
    const bogusEmail = "verify1840428@web.eia.diaria.local";
    const res = await worker.fetch(
      new Request(`https://poll.test/jogar/seq-state?email=${encodeURIComponent(bogusEmail)}&editions=260701`),
      env,
    );
    assert.equal(res.status, 400);
  });

  it("token UUID v4 válido mas domínio errado → 400", async () => {
    const env = makeEnv();
    const email = `${VALID_TOKEN}@evil.com`;
    const res = await worker.fetch(
      new Request(`https://poll.test/jogar/seq-state?email=${encodeURIComponent(email)}&editions=260701`),
      env,
    );
    assert.equal(res.status, 400);
  });
});
