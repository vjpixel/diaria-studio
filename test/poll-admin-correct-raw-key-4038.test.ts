/**
 * test/poll-admin-correct-raw-key-4038.test.ts (#4038)
 *
 * `handleAdminCorrect` (POST /admin/correct) grava `correct:{edition}` — o
 * gabarito, um fato COMPARTILHADO entre brands (mesmo racional já
 * estabelecido em vote.ts pro lado da LEITURA, #3600: `handleVote` lê
 * `correct:{edition}` via `rawEnv`, nunca via `env` branded).
 *
 * Achado (self-review do PR #4037): `handleAdminCorrect` gravava a chave
 * através do `env` recebido do router, que é o `bEnv` BRANDED — pra
 * `?brand=web`, isso escrevia `web:correct:{edition}` em vez da chave crua
 * que `handleVote`/`jogar.ts`/`leaderboard-routes.ts` leem. Mascarado em
 * produção porque `close-poll.ts` sempre grava a chave crua correta na
 * chamada SEM `&brand=` (fecha a diária) antes do mirror `&brand=web` — mas
 * era uma escrita morta com risco real de virar bug ativo, mesma classe do
 * #3600/#4035.
 *
 * Fix: `handleAdminCorrect` ganhou um 4º parâmetro `rawEnv` (mesmo padrão de
 * `handleVote`, #3600) — usado só pra `correct:{edition}`; o backfill de
 * scores (`vote:{edition}:*`) continua via `env` branded, que É correto pra
 * essa parte (score é brand-scoped).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker, { hmacSign, type Env } from "../workers/poll/src/index.ts";

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

function makeEnv(seed: Record<string, string> = {}): Env & { POLL: ReturnType<typeof makeMapKV> } {
  return {
    POLL: makeMapKV(seed),
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret-test",
    ALLOWED_ORIGINS: "*",
  } as Env & { POLL: ReturnType<typeof makeMapKV> };
}

async function postAdminCorrect(env: Env, edition: string, answer: string, brand?: string): Promise<Response> {
  const sig = await hmacSign(env.ADMIN_SECRET, `${brand ?? "diaria"}:${edition}:${answer}`);
  const brandQ = brand ? `&brand=${brand}` : "";
  const req = new Request(
    `https://poll.test/admin/correct?edition=${edition}&answer=${answer}&sig=${encodeURIComponent(sig)}${brandQ}`,
    { method: "POST" },
  );
  return worker.fetch(req, env, {} as ExecutionContext);
}

describe("POST /admin/correct — correct:{edition} sempre na chave CRUA, mesmo com ?brand= (#4038)", () => {
  it("brand=web: grava correct:{edition} SEM prefixo — não web:correct:{edition}", async () => {
    const env = makeEnv();
    const res = await postAdminCorrect(env, "260601", "A", "web");
    assert.equal(res.status, 200);
    assert.equal(await env.POLL.get("correct:260601"), "A", "chave crua deve ter o gabarito");
    assert.equal(await env.POLL.get("web:correct:260601"), null, "chave branded NÃO deve existir — era o bug");
  });

  it("brand=clarice: mesma garantia — correct:{edition} crua, não clarice:correct:{edition}", async () => {
    const env = makeEnv();
    const res = await postAdminCorrect(env, "2606-07", "B", "clarice");
    assert.equal(res.status, 200);
    assert.equal(await env.POLL.get("correct:2606-07"), "B");
    assert.equal(await env.POLL.get("clarice:correct:2606-07"), null);
  });

  it("brand default (diaria, sem ?brand=): continua gravando na chave crua — comportamento pré-existente preservado", async () => {
    const env = makeEnv();
    const res = await postAdminCorrect(env, "260601", "A");
    assert.equal(res.status, 200);
    assert.equal(await env.POLL.get("correct:260601"), "A");
  });

  it("backfill de score continua BRANDED — vote:{edition}:{email} de um voto web só é re-pontuado sob o prefixo web:", async () => {
    const env = makeEnv({
      "web:vote:260601:ana@web.eia.diaria.local": JSON.stringify({ choice: "A", correct: false }),
    });
    const res = await postAdminCorrect(env, "260601", "A", "web");
    assert.equal(res.status, 200);
    const updated = JSON.parse((await env.POLL.get("web:vote:260601:ana@web.eia.diaria.local"))!);
    assert.equal(updated.correct, true, "backfill deve continuar operando no namespace branded correto");
  });

  it("coerência write/read fim-a-fim: gabarito gravado via /admin/correct?brand=web é lido corretamente por handleVote (brand web) na MESMA chave", async () => {
    const env = makeEnv();
    const correctRes = await postAdminCorrect(env, "260601", "A", "web");
    assert.equal(correctRes.status, 200);
    const voteRes = await worker.fetch(
      new Request("https://poll.test/vote?edition=260601&brand=web&email=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa@web.eia.diaria.local&choice=A"),
      env,
    );
    const html = await voteRes.text();
    assert.match(html, /✅ Acertou!/, "handleVote deve encontrar o gabarito gravado por /admin/correct?brand=web na chave crua");
  });
});
