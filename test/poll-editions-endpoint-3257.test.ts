/**
 * test/poll-editions-endpoint-3257.test.ts (#3257)
 *
 * Regressão (#633) para o endpoint novo `GET /editions` do worker `poll` —
 * lista as edições/ciclos com stats registrados (`stats:{edition}` no KV),
 * derivado dos mesmos dados que `/stats?edition=X` já expõe.
 *
 * Contexto: a issue #3257 pedia um botão "Atualizar" pros votos do É IA? na
 * aba Engajamento do clarice-dashboard — mas `build-poll-eia-data.ts` decide
 * QUAIS edições consultar via `data/editions/`/`data/monthly/`, diretórios
 * locais inacessíveis a um Worker Cloudflare. `/editions` resolve isso: o
 * worker `poll` já sabe quais edições têm votos (fonte de verdade real), e
 * expõe a lista via HTTP — sem duplicar `data/` no runtime do Worker.
 *
 * Cobertura:
 *  - handleEditions (unit): filtra formato válido (AAMMDD/YYMM-MM), ordena
 *    desc, ignora keys `stats:` malformadas/corrompidas.
 *  - isolamento por brand: `stats:` sob prefixo `clarice:` não vaza pra
 *    brand=diaria e vice-versa (mesmo padrão de #1905 pro resto do worker).
 *  - integração via router: `GET /editions` (com e sem `?brand=`) retorna o
 *    shape esperado e não exige nenhum secret (rota pública, como /stats).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleEditions } from "../workers/poll/src/vote.ts";
import { brandedNamespace, type Env } from "../workers/poll/src/index.ts";
import worker from "../workers/poll/src/index.ts";

// ── Mock KV backed por Map (mesmo padrão de worker-poll-brand.test.ts) ──────
function makeMapKV(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial));
  const kv = {
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
  return kv;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    POLL: makeMapKV() as unknown as Env["POLL"],
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
    ...overrides,
  };
}

describe("handleEditions (#3257) — unit", () => {
  it("lista edições AAMMDD válidas a partir de chaves stats:*, ordenadas desc", async () => {
    const env = makeEnv({
      POLL: makeMapKV({
        "stats:260601": "{}",
        "stats:260615": "{}",
        "stats:260603": "{}",
      }) as unknown as Env["POLL"],
    });
    const res = await handleEditions(env, "diaria");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { brand: string; editions: string[] };
    assert.equal(body.brand, "diaria");
    assert.deepEqual(body.editions, ["260615", "260603", "260601"]);
  });

  it("aceita ciclo mensal YYMM-MM (formato clarice)", async () => {
    const env = makeEnv({
      POLL: makeMapKV({
        "stats:2606-07": "{}",
        "stats:2605-06": "{}",
      }) as unknown as Env["POLL"],
    });
    const res = await handleEditions(env, "clarice");
    const body = (await res.json()) as { editions: string[] };
    assert.deepEqual(body.editions, ["2606-07", "2605-06"]);
  });

  it("ignora keys stats: com edition malformado/vazio (defesa contra KV corrompido)", async () => {
    const env = makeEnv({
      POLL: makeMapKV({
        "stats:260601": "{}",
        "stats:": "{}", // edition vazio
        "stats:evil:injected": "{}", // formato lixo
        "stats:26060": "{}", // 5 dígitos — não é AAMMDD válido
      }) as unknown as Env["POLL"],
    });
    const res = await handleEditions(env, "diaria");
    const body = (await res.json()) as { editions: string[] };
    assert.deepEqual(body.editions, ["260601"]);
  });

  it("sem nenhuma stats: → editions vazio (não erro)", async () => {
    const env = makeEnv();
    const res = await handleEditions(env, "diaria");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { editions: string[] };
    assert.deepEqual(body.editions, []);
  });

  it("respeita o namespace já embrulhado por brand — não precisa filtrar aqui (isolamento vem de brandedNamespace)", async () => {
    // env.POLL já vem embrulhado (como brandedEnv faria em index.ts) —
    // handleEditions não sabe/precisa saber do prefixo.
    const rawKv = makeMapKV({
      "clarice:stats:2606-07": "{}",
      "stats:260601": "{}", // diaria (legado, sem prefixo)
    });
    const clariceKv = brandedNamespace(rawKv as unknown as Env["POLL"], "clarice:");
    const res = await handleEditions(makeEnv({ POLL: clariceKv }), "clarice");
    const body = (await res.json()) as { editions: string[] };
    assert.deepEqual(body.editions, ["2606-07"], "só a edição clarice, sem vazar a diária");
  });
});

describe("GET /editions — integração via router (#3257)", () => {
  const makeRouterEnv = (): Env & { POLL: ReturnType<typeof makeMapKV> } => ({
    POLL: makeMapKV({
      "stats:260601": "{}",
      "stats:260615": "{}",
      "clarice:stats:2606-07": "{}",
    }),
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
  });

  it("GET /editions (sem brand → diaria) retorna as edições diárias, sem vazar clarice", async () => {
    const env = makeRouterEnv();
    const res = await worker.fetch(new Request("https://poll.test/editions"), env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { brand: string; editions: string[] };
    assert.equal(body.brand, "diaria");
    assert.deepEqual(body.editions, ["260615", "260601"]);
  });

  it("GET /editions?brand=clarice retorna só os ciclos mensais da clarice", async () => {
    const env = makeRouterEnv();
    const res = await worker.fetch(new Request("https://poll.test/editions?brand=clarice"), env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { brand: string; editions: string[] };
    assert.equal(body.brand, "clarice");
    assert.deepEqual(body.editions, ["2606-07"]);
  });

  it("rota pública — não exige nenhum secret (mesmo padrão de /stats)", async () => {
    const env: Env = {
      POLL: makeMapKV({ "stats:260601": "{}" }) as unknown as Env["POLL"],
      POLL_SECRET: undefined as unknown as string,
      ADMIN_SECRET: undefined as unknown as string,
      ALLOWED_ORIGINS: "*",
    };
    const res = await worker.fetch(new Request("https://poll.test/editions"), env);
    assert.equal(res.status, 200, "não deve cair no guard 503 de missingSecretsForRoute");
  });

  it("endpoint listado no 404 fallback (descoberta de rota)", async () => {
    const env = makeRouterEnv();
    const res = await worker.fetch(new Request("https://poll.test/rota-inexistente"), env);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { endpoints: string[] };
    assert.ok(body.endpoints.includes("/editions"), "/editions deve aparecer na lista de endpoints do 404");
  });
});
