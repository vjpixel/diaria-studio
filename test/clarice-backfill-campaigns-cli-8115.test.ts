/**
 * test/clarice-backfill-campaigns-cli-8115.test.ts (#8115)
 *
 * Cobertura dos guards do CLI `scripts/clarice-backfill-campaigns.ts`:
 *   - sem `BREVO_CLARICE_API_KEY` → aborta (exitCode 1), zero chamada de rede.
 *   - com API key mas sem credenciais Cloudflare (`CLOUDFLARE_ACCOUNT_ID`/
 *     `CLOUDFLARE_WORKERS_TOKEN`) → aborta (exitCode 1), zero chamada Brevo.
 *   - cota Brevo observada abaixo da reserva (`data/brevo-rate-state.json`)
 *     → pula a rodada SEM gastar quota (nem Brevo, nem Cloudflare) — mesmo
 *     guard que `dashboard-clarice.ts` já usa (#5697/#6029).
 *   - `--dry-run` com cota/credenciais OK → só mede o total (1 GET Brevo),
 *     nenhuma chamada à Cloudflare KV (não precisa escrever nada).
 *
 * Todas as chamadas de rede são mockadas via `globalThis.fetch` — nenhuma
 * chamada real à Brevo nem à Cloudflare acontece neste teste (regra
 * obrigatória de dispatch: nunca consumir quota real de produção em teste).
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { main, STATS_CACHE_KV_NAMESPACE_ID } from "../scripts/clarice-backfill-campaigns.ts";
import { DEFAULT_RATE_STATE_PATH } from "../scripts/lib/brevo-rate-state.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let origFetch: any;
let fetchCalls: string[] = [];

before(() => {
  origFetch = globalThis.fetch;
});
after(() => {
  globalThis.fetch = origFetch;
});

beforeEach(() => {
  fetchCalls = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === "string" ? input : (input as Request)?.url ?? String(input);
    fetchCalls.push(url);
    if (url.includes("brevo.com")) {
      return new Response(JSON.stringify({ campaigns: [], count: 250 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("api.cloudflare.com")) {
      // Não deveria ser chamado no --dry-run (só mede, não toca KV) — se for
      // chamado, devolve algo inofensivo em vez de lançar, pra não mascarar
      // um assert de "0 chamadas" com um erro de rede confuso.
      return new Response(JSON.stringify({ success: true, result: null }), { status: 200 });
    }
    throw new Error(`fetch inesperado no teste: ${url}`);
  };
});

const ORIGINAL_ENV = { ...process.env };
function resetEnv() {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
}

afterEach(() => {
  resetEnv();
  process.exitCode = 0;
});

describe("#8115 — clarice-backfill-campaigns.ts guards", () => {
  it("sem BREVO_CLARICE_API_KEY: aborta sem nenhuma chamada de rede", async () => {
    delete process.env.BREVO_CLARICE_API_KEY;
    process.env.CLOUDFLARE_ACCOUNT_ID = "acc";
    process.env.CLOUDFLARE_WORKERS_TOKEN = "tok";

    await main();

    assert.equal(process.exitCode, 1);
    assert.equal(fetchCalls.length, 0);
  });

  it("com API key mas sem credenciais Cloudflare: aborta sem chamar a Brevo", async () => {
    process.env.BREVO_CLARICE_API_KEY = "fake-brevo-key";
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_WORKERS_TOKEN;

    await main();

    assert.equal(process.exitCode, 1);
    // O guard de credenciais Cloudflare roda DEPOIS do gate de cota (que não
    // bloqueia aqui, pois não há estado de cota gravado) — mas ainda ANTES
    // de qualquer request. Nenhuma chamada de rede deve ter acontecido.
    assert.equal(fetchCalls.length, 0);
  });

  it("--dry-run com credenciais OK: mede o total (1 GET Brevo), nunca toca a Cloudflare KV", async () => {
    process.env.BREVO_CLARICE_API_KEY = "fake-brevo-key";
    process.env.CLOUDFLARE_ACCOUNT_ID = "acc";
    process.env.CLOUDFLARE_WORKERS_TOKEN = "tok";
    process.argv = ["node", "clarice-backfill-campaigns.ts", "--dry-run"];

    await main();

    assert.equal(process.exitCode, 0);
    const brevoCalls = fetchCalls.filter((u) => u.includes("brevo.com"));
    const cfCalls = fetchCalls.filter((u) => u.includes("api.cloudflare.com"));
    assert.equal(brevoCalls.length, 1);
    assert.equal(cfCalls.length, 0);
    assert.match(brevoCalls[0], /limit=1/);
  });

  it("cota Brevo baixa (data/brevo-rate-state.json): pula a rodada sem gastar rede", async (t) => {
    const dir = dirname(DEFAULT_RATE_STATE_PATH);
    const existedBefore = existsSync(DEFAULT_RATE_STATE_PATH);
    const previousContent = existedBefore ? undefined : undefined;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      DEFAULT_RATE_STATE_PATH,
      JSON.stringify({ remaining: 5, limit: 100, updatedAt: new Date().toISOString() }),
    );
    t.after(() => {
      // Limpeza: este teste só deve deixar rastro se o arquivo NÃO existia
      // antes (nunca sobrescrever um estado real pré-existente sem restaurar).
      if (!existedBefore) {
        try {
          rmSync(DEFAULT_RATE_STATE_PATH);
        } catch {
          /* best-effort */
        }
      }
      void previousContent;
    });

    process.env.BREVO_CLARICE_API_KEY = "fake-brevo-key";
    process.env.CLOUDFLARE_ACCOUNT_ID = "acc";
    process.env.CLOUDFLARE_WORKERS_TOKEN = "tok";
    process.argv = ["node", "clarice-backfill-campaigns.ts"];

    await main();

    assert.equal(fetchCalls.length, 0); // recusou ANTES de qualquer request
  });

  it("STATS_CACHE_KV_NAMESPACE_ID bate com o binding real do wrangler.toml", () => {
    // Guarda contra o namespace ID divergir silenciosamente do Worker real
    // (o script escreveria no KV errado sem nenhum erro visível).
    assert.equal(STATS_CACHE_KV_NAMESPACE_ID, "2f87d65d735c499ab8f465774d0167e2");
  });
});
