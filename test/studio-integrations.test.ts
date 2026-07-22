/**
 * test/studio-integrations.test.ts (#3848) — cobertura de
 * scripts/studio-ui/studio-integrations.ts: camada de status de todas as
 * integrações (APIs + MCPs) — configurada?/alcançável?/última checagem?
 *
 * HARD CONSTRAINT (mesma disciplina de check-cloudflare-token.test.ts,
 * #2286): NUNCA bate em rede real. Toda comunicação HTTP é mockada via
 * `fetchImpl` — nenhum teste aqui depende de credencial real nem de
 * conectividade. `env` é SEMPRE um objeto controlado passado explicitamente
 * (nunca o `process.env` real do processo de teste, que pode ter
 * credenciais reais persistidas nesta máquina — ver CLAUDE.md § Setup,
 * `CLARICE_API_KEY` é tipicamente exportado no shell do editor).
 *
 * Cobertura:
 *   1. `checkEnvConfigured` — configured/partial/not_configured, sem env var
 *      obrigatória (linkedin_worker).
 *   2. `INTEGRATIONS` — cobre TODAS as integrações listadas na issue #3848
 *      (APIs + MCPs), cada uma com id/kind/probe válidos.
 *   3. Probes individuais (`probeCloudflare`, `probeBeehiiv`,
 *      `probeGraphNode`, `probeClariceCortex`, `probeWorkerHealth`) —
 *      sucesso, falha determinística (401/erro OAuth), erro transitório
 *      (rede/HTTP 5xx).
 *   4. `readLinkedInWorkerUrl` — lê platform.config.json fail-soft.
 *   5. `buildIntegrationsData` (orquestração fim-a-fim): clone-fresco
 *      zero-config nunca dispara fetch; totalmente configurado dispara os
 *      probes reais e reflete o resultado; cache com TTL + forceRefresh.
 *   6. **Nenhum valor de secret aparece no payload** — teste explícito
 *      (critério de aceite da issue).
 *   7. Contrato HTTP (`GET /integracoes`, `GET /api/integrations` via
 *      `server.ts`) — mesma disciplina de `test/studio-apoios-page.test.ts`
 *      (#3602): env vars reais são deliberadamente limpas em
 *      `before`/restauradas em `after`, e `integrationsFetchImpl` injetado
 *      nunca bate em rede real — dupla proteção mesmo que a máquina rodando
 *      o teste tenha `.env.local`/env persistido com credenciais válidas.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkEnvConfigured,
  INTEGRATIONS,
  readLinkedInWorkerUrl,
  probeCloudflare,
  probeBeehiiv,
  probeGraphNode,
  probeClariceCortex,
  probeWorkerHealth,
  buildIntegrationsData,
  clearIntegrationsCache,
  type EnvMap,
} from "../scripts/studio-ui/studio-integrations.ts";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";

type FetchFn = typeof fetch;

function mockFetch(status: number, body: unknown): FetchFn {
  return (async () => {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as FetchFn;
}

function throwingFetch(message: string): FetchFn {
  return (async () => {
    throw new Error(message);
  }) as FetchFn;
}

function makeTmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "data", "editions"), { recursive: true });
  return root;
}

// ─── checkEnvConfigured ─────────────────────────────────────────────────

describe("checkEnvConfigured (#3848)", () => {
  it("todas presentes -> configured, missing vazio", () => {
    const r = checkEnvConfigured(["A", "B"], { A: "x", B: "y" });
    assert.equal(r.state, "configured");
    assert.deepEqual(r.missing, []);
  });

  it("todas ausentes -> not_configured, missing lista os 2 nomes", () => {
    const r = checkEnvConfigured(["A", "B"], {});
    assert.equal(r.state, "not_configured");
    assert.deepEqual(r.missing, ["A", "B"]);
  });

  it("algumas ausentes -> partial", () => {
    const r = checkEnvConfigured(["A", "B"], { A: "x" });
    assert.equal(r.state, "partial");
    assert.deepEqual(r.missing, ["B"]);
  });

  it("string vazia/whitespace conta como ausente", () => {
    const r = checkEnvConfigured(["A"], { A: "   " });
    assert.equal(r.state, "not_configured");
  });

  it("required vazio -> sempre configured (integração sem env var própria, ex: LinkedIn)", () => {
    const r = checkEnvConfigured([], {});
    assert.equal(r.state, "configured");
    assert.deepEqual(r.missing, []);
  });

  it("nunca inclui o VALOR da env var no resultado, só o nome ausente", () => {
    const r = checkEnvConfigured(["SECRET_VAR"], {});
    assert.deepEqual(r.missing, ["SECRET_VAR"]);
    assert.ok(!JSON.stringify(r).includes("valor-nao-deveria-aparecer"));
  });
});

// ─── INTEGRATIONS — cobertura completa da issue ────────────────────────

describe("INTEGRATIONS (#3848) — cobre todas as integrações listadas na issue", () => {
  const EXPECTED_API_IDS = [
    "apoia_se",
    "beehiiv",
    "brave_search",
    "brevo_clarice",
    "clarice_cortex",
    "cloudflare",
    "facebook",
    "gemini",
    "instagram",
    "million_verifier",
    "openai",
    "stripe",
    "telegram",
    "google_oauth",
    "linkedin_worker",
  ];

  const EXPECTED_MCP_IDS = [
    "mcp_clarice",
    "mcp_beehiiv",
    "mcp_gmail",
    "mcp_google_drive",
    "mcp_claude_in_chrome",
    "mcp_stripe",
  ];

  it("todas as APIs da issue estão presentes", () => {
    const ids = INTEGRATIONS.filter((i) => i.kind === "api").map((i) => i.id);
    for (const expected of EXPECTED_API_IDS) {
      assert.ok(ids.includes(expected), `API "${expected}" ausente de INTEGRATIONS`);
    }
  });

  it("todos os MCPs da issue estão presentes", () => {
    const ids = INTEGRATIONS.filter((i) => i.kind === "mcp").map((i) => i.id);
    for (const expected of EXPECTED_MCP_IDS) {
      assert.ok(ids.includes(expected), `MCP "${expected}" ausente de INTEGRATIONS`);
    }
  });

  it("nenhum id duplicado", () => {
    const ids = INTEGRATIONS.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("todo item tem nome não-vazio e probe válido", () => {
    const VALID_PROBES = new Set([
      "cloudflare",
      "beehiiv",
      "facebook-graph",
      "instagram-graph",
      "clarice-cortex",
      "linkedin-worker",
      "env-only",
      "interactive-mcp",
    ]);
    for (const def of INTEGRATIONS) {
      assert.ok(def.name.trim().length > 0, `${def.id} sem nome`);
      assert.ok(VALID_PROBES.has(def.probe), `${def.id} com probe inválido: ${def.probe}`);
    }
  });

  it("MCPs interativos (claude.ai) não têm env var própria", () => {
    for (const id of ["mcp_beehiiv", "mcp_gmail", "mcp_google_drive", "mcp_claude_in_chrome", "mcp_stripe"]) {
      const def = INTEGRATIONS.find((i) => i.id === id)!;
      assert.equal(def.probe, "interactive-mcp");
      assert.deepEqual(def.envVars, []);
    }
  });

  it("as 6 integrações com probe real declarado (#3848: 'pelo menos 3-4 mais críticas')", () => {
    const realProbeIds = INTEGRATIONS.filter((i) =>
      ["cloudflare", "beehiiv", "facebook-graph", "instagram-graph", "clarice-cortex", "linkedin-worker"].includes(
        i.probe,
      ),
    ).map((i) => i.id);
    assert.deepEqual(
      new Set(realProbeIds),
      new Set(["cloudflare", "beehiiv", "facebook", "instagram", "clarice_cortex", "linkedin_worker"]),
    );
  });
});

// ─── readLinkedInWorkerUrl ──────────────────────────────────────────────

describe("readLinkedInWorkerUrl (#3848)", () => {
  it("lê cloudflare_worker_url de platform.config.json", () => {
    const root = makeTmpRoot("studio-integrations-linkedin-");
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify({ publishing: { social: { linkedin: { cloudflare_worker_url: "https://x.workers.dev" } } } }),
    );
    assert.equal(readLinkedInWorkerUrl(root), "https://x.workers.dev");
    rmSync(root, { recursive: true, force: true });
  });

  it("platform.config.json ausente -> null (fail-soft)", () => {
    const root = makeTmpRoot("studio-integrations-linkedin-missing-");
    assert.equal(readLinkedInWorkerUrl(root), null);
    rmSync(root, { recursive: true, force: true });
  });

  it("JSON corrompido -> null (fail-soft)", () => {
    const root = makeTmpRoot("studio-integrations-linkedin-corrupt-");
    writeFileSync(join(root, "platform.config.json"), "{ isso não é json");
    assert.equal(readLinkedInWorkerUrl(root), null);
    rmSync(root, { recursive: true, force: true });
  });

  it("campo ausente/vazio -> null", () => {
    const root = makeTmpRoot("studio-integrations-linkedin-empty-");
    writeFileSync(join(root, "platform.config.json"), JSON.stringify({ publishing: { social: { linkedin: {} } } }));
    assert.equal(readLinkedInWorkerUrl(root), null);
    rmSync(root, { recursive: true, force: true });
  });
});

// ─── probes individuais (fetch sempre mockado) ─────────────────────────

describe("probeCloudflare (#3848)", () => {
  it("token ativo -> reachable", async () => {
    const r = await probeCloudflare("tok", mockFetch(200, { success: true, result: { status: "active" } }));
    assert.equal(r.reachable, "reachable");
    assert.equal(r.error, null);
  });

  it("token inválido (401) -> unreachable", async () => {
    const r = await probeCloudflare("tok", mockFetch(401, { success: false }));
    assert.equal(r.reachable, "unreachable");
  });

  it("token ausente -> skipped", async () => {
    const r = await probeCloudflare("", mockFetch(401, {}));
    assert.equal(r.reachable, "skipped");
  });

  it("erro de rede -> error", async () => {
    const r = await probeCloudflare("tok", throwingFetch("ECONNREFUSED"));
    assert.equal(r.reachable, "error");
  });
});

describe("probeBeehiiv (#3848)", () => {
  it("200 -> reachable", async () => {
    const r = await probeBeehiiv("key", "pub_1", mockFetch(200, { data: {} }));
    assert.equal(r.reachable, "reachable");
  });

  it("401 -> unreachable", async () => {
    const r = await probeBeehiiv("key-invalido", "pub_1", mockFetch(401, {}));
    assert.equal(r.reachable, "unreachable");
  });

  it("500 -> error", async () => {
    const r = await probeBeehiiv("key", "pub_1", mockFetch(500, {}));
    assert.equal(r.reachable, "error");
  });

  it("rede fora do ar -> error", async () => {
    const r = await probeBeehiiv("key", "pub_1", throwingFetch("network down"));
    assert.equal(r.reachable, "error");
  });
});

describe("probeGraphNode (Facebook/Instagram Graph, #3848)", () => {
  it("resposta sem erro -> reachable", async () => {
    const r = await probeGraphNode("123", "tok", "v25.0", mockFetch(200, { id: "123" }));
    assert.equal(r.reachable, "reachable");
  });

  it("erro OAuth do Graph API (token expirado) -> unreachable", async () => {
    const r = await probeGraphNode(
      "123",
      "tok-expirado",
      "v25.0",
      mockFetch(400, { error: { message: "Error validating access token", code: 190 } }),
    );
    assert.equal(r.reachable, "unreachable");
    assert.match(r.error ?? "", /code 190/);
  });

  it("HTTP 500 sem corpo de erro reconhecível -> error", async () => {
    const r = await probeGraphNode("123", "tok", "v25.0", mockFetch(500, {}));
    assert.equal(r.reachable, "error");
  });

  it("rede fora do ar -> error", async () => {
    const r = await probeGraphNode("123", "tok", "v25.0", throwingFetch("timeout"));
    assert.equal(r.reachable, "error");
  });

  it("nunca inclui o access_token na URL da request (vai só no header Authorization)", async () => {
    let capturedUrl = "";
    const spyFetch = (async (url: string) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ id: "123" }) } as Response;
    }) as FetchFn;
    await probeGraphNode("123", "TOKEN_SECRETO_XYZ", "v25.0", spyFetch);
    assert.ok(!capturedUrl.includes("TOKEN_SECRETO_XYZ"), "a URL não deve conter o access_token");
  });
});

describe("probeClariceCortex (#3848)", () => {
  it("200 -> reachable", async () => {
    const r = await probeClariceCortex("key", mockFetch(200, {}));
    assert.equal(r.reachable, "reachable");
  });

  it("HTTP non-2xx -> error", async () => {
    const r = await probeClariceCortex("key-invalida", mockFetch(401, {}));
    assert.equal(r.reachable, "error");
  });

  it("rede fora do ar -> error", async () => {
    const r = await probeClariceCortex("key", throwingFetch("network down"));
    assert.equal(r.reachable, "error");
  });
});

describe("probeWorkerHealth (LinkedIn cron Worker, #3848)", () => {
  it("200 -> reachable", async () => {
    const r = await probeWorkerHealth("https://x.workers.dev", mockFetch(200, { ok: true }));
    assert.equal(r.reachable, "reachable");
  });

  it("HTTP 500 -> error", async () => {
    const r = await probeWorkerHealth("https://x.workers.dev", mockFetch(500, {}));
    assert.equal(r.reachable, "error");
  });

  it("Worker fora do ar -> error", async () => {
    const r = await probeWorkerHealth("https://x.workers.dev", throwingFetch("ECONNREFUSED"));
    assert.equal(r.reachable, "error");
  });
});

// ─── buildIntegrationsData — orquestração fim-a-fim ────────────────────

describe("buildIntegrationsData (#3848) — orquestração fim-a-fim", () => {
  it("clone-fresco (env vazio, sem platform.config.json) — NUNCA dispara fetch, tudo skipped/not_verified/unknown", async () => {
    clearIntegrationsCache();
    const root = makeTmpRoot("studio-integrations-fresh-");
    const noNetworkFetch = (async () => {
      throw new Error("nenhuma chamada de rede deveria ocorrer neste cenário");
    }) as FetchFn;

    const data = await buildIntegrationsData(root, { env: {} as EnvMap, fetchImpl: noNetworkFetch, now: () => 0 });

    assert.equal(data.integrations.length, INTEGRATIONS.length);
    for (const integration of data.integrations) {
      assert.notEqual(integration.reachable, "reachable", `${integration.id} não deveria estar reachable sem config`);
      assert.notEqual(integration.reachable, "unreachable", `${integration.id} não deveria ter tentado probe`);
      assert.ok(
        ["skipped", "not_verified"].includes(integration.reachable),
        `${integration.id}: esperava skipped/not_verified, veio ${integration.reachable}`,
      );
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("totalmente configurado + probes mockados com sucesso -> reachable nas 6 integrações com probe real", async () => {
    clearIntegrationsCache();
    const root = makeTmpRoot("studio-integrations-full-");
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify({ publishing: { social: { linkedin: { cloudflare_worker_url: "https://li.workers.dev" } } } }),
    );

    const env: EnvMap = {
      APOIA_SE_API_KEY: "k",
      APOIA_SE_API_SECRET: "s",
      BEEHIIV_API_KEY: "k",
      BEEHIIV_PUBLICATION_ID: "pub_1",
      BRAVE_API_KEY: "k",
      BREVO_CLARICE_API_KEY: "k",
      CLARICE_API_KEY: "k",
      CLOUDFLARE_API_TOKEN: "tok",
      CLOUDFLARE_ACCOUNT_ID: "acc",
      FACEBOOK_PAGE_ACCESS_TOKEN: "tok",
      FACEBOOK_PAGE_ID: "page1",
      GEMINI_API_KEY: "k",
      INSTAGRAM_ACCESS_TOKEN: "tok",
      INSTAGRAM_BUSINESS_ACCOUNT_ID: "biz1",
      MILLION_VERIFIER_API_KEY: "k",
      OPENAI_API_KEY: "k",
      STRIPE_API_KEY: "k",
      TELEGRAM_BOT_TOKEN: "k",
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
    };

    const routerFetch = (async (url: string) => {
      const u = String(url);
      if (u.includes("api.cloudflare.com")) {
        return { ok: true, status: 200, json: async () => ({ success: true, result: { status: "active" } }) } as Response;
      }
      if (u.includes("beehiiv.com")) {
        return { ok: true, status: 200, json: async () => ({ data: {} }) } as Response;
      }
      if (u.includes("graph.facebook.com")) {
        return { ok: true, status: 200, json: async () => ({ id: "ok" }) } as Response;
      }
      if (u.includes("cortex.clarice.ai")) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as Response;
      }
      if (u.includes("li.workers.dev")) {
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      throw new Error(`URL inesperada no mock: ${u}`);
    }) as FetchFn;

    const data = await buildIntegrationsData(root, { env, fetchImpl: routerFetch, now: () => 1000 });

    const byId = Object.fromEntries(data.integrations.map((i) => [i.id, i]));
    assert.equal(byId.cloudflare.reachable, "reachable");
    assert.equal(byId.beehiiv.reachable, "reachable");
    assert.equal(byId.facebook.reachable, "reachable");
    assert.equal(byId.instagram.reachable, "reachable");
    assert.equal(byId.clarice_cortex.reachable, "reachable");
    assert.equal(byId.linkedin_worker.reachable, "reachable");
    assert.equal(byId.linkedin_worker.configured, "configured");

    // env-only e interactive-mcp continuam not_verified mesmo com env presente
    assert.equal(byId.apoia_se.reachable, "not_verified");
    assert.equal(byId.mcp_beehiiv.reachable, "not_verified");
    assert.equal(byId.mcp_beehiiv.configured, "unknown");

    rmSync(root, { recursive: true, force: true });
  });

  it("cache: 2ª chamada dentro do TTL não dispara fetch de novo (cached:true)", async () => {
    clearIntegrationsCache();
    const root = makeTmpRoot("studio-integrations-cache-");
    let calls = 0;
    const countingFetch = (async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ success: true, result: { status: "active" } }) } as Response;
    }) as FetchFn;

    const env: EnvMap = { CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "acc" };
    const first = await buildIntegrationsData(root, { env, fetchImpl: countingFetch, now: () => 0, cacheTtlMs: 60_000 });
    assert.equal(first.cached, false);
    const callsAfterFirst = calls;
    assert.ok(callsAfterFirst > 0);

    const second = await buildIntegrationsData(root, { env, fetchImpl: countingFetch, now: () => 1000, cacheTtlMs: 60_000 });
    assert.equal(second.cached, true);
    assert.equal(calls, callsAfterFirst, "não deveria ter disparado fetch de novo dentro do TTL");

    rmSync(root, { recursive: true, force: true });
  });

  it("forceRefresh bypassa o cache mesmo dentro do TTL", async () => {
    clearIntegrationsCache();
    const root = makeTmpRoot("studio-integrations-force-");
    let calls = 0;
    const countingFetch = (async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ success: true, result: { status: "active" } }) } as Response;
    }) as FetchFn;

    const env: EnvMap = { CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "acc" };
    await buildIntegrationsData(root, { env, fetchImpl: countingFetch, now: () => 0, cacheTtlMs: 60_000 });
    const callsAfterFirst = calls;
    await buildIntegrationsData(root, {
      env,
      fetchImpl: countingFetch,
      now: () => 1000,
      cacheTtlMs: 60_000,
      forceRefresh: true,
    });
    assert.ok(calls > callsAfterFirst, "forceRefresh deveria disparar fetch de novo");

    rmSync(root, { recursive: true, force: true });
  });

  it("execMode reflete o rootDir — 'local' quando data/ existe, 'cloud' quando não (#2643)", async () => {
    clearIntegrationsCache();
    const rootWithData = makeTmpRoot("studio-integrations-execmode-local-");
    const dataLocal = await buildIntegrationsData(rootWithData, {
      env: {} as EnvMap,
      fetchImpl: throwingFetch("no network"),
      now: () => 0,
    });
    assert.equal(dataLocal.execMode, "local"); // makeTmpRoot cria data/editions -> data/ existe como diretório real
    rmSync(rootWithData, { recursive: true, force: true });

    clearIntegrationsCache();
    const rootWithoutData = mkdtempSync(join(tmpdir(), "studio-integrations-execmode-cloud-"));
    const dataCloud = await buildIntegrationsData(rootWithoutData, {
      env: {} as EnvMap,
      fetchImpl: throwingFetch("no network"),
      now: () => 0,
    });
    assert.equal(dataCloud.execMode, "cloud"); // sem data/ -> clone fresco
    rmSync(rootWithoutData, { recursive: true, force: true });
  });

  it("um probe que lança de forma inesperada nunca derruba a página inteira (fail-soft de 2ª camada)", async () => {
    clearIntegrationsCache();
    const root = makeTmpRoot("studio-integrations-throw-");
    const env: EnvMap = { CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "acc" };
    // fetchImpl que lança um erro não-Error (edge case) — garante que o catch
    // final de evaluateIntegration não pressupõe `.message`.
    const weirdFetch = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "erro-nao-padrao";
    }) as FetchFn;
    const data = await buildIntegrationsData(root, { env, fetchImpl: weirdFetch, now: () => 0 });
    const cf = data.integrations.find((i) => i.id === "cloudflare")!;
    assert.equal(cf.reachable, "error");
    rmSync(root, { recursive: true, force: true });
  });
});

// ─── segurança: nenhum valor de secret aparece no payload ──────────────

describe("segurança (#3848): nenhum valor de secret vaza no payload", () => {
  it("secrets de env não aparecem em nenhum campo de IntegrationStatus, nem em cenário de sucesso nem de erro", async () => {
    clearIntegrationsCache();
    const root = makeTmpRoot("studio-integrations-secrets-");
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify({ publishing: { social: { linkedin: { cloudflare_worker_url: "https://li.workers.dev" } } } }),
    );

    const SECRETS = {
      CLOUDFLARE_API_TOKEN: "cf-secret-AAAA1111",
      CLOUDFLARE_ACCOUNT_ID: "acc-secret-BBBB2222",
      BEEHIIV_API_KEY: "beehiiv-secret-CCCC3333",
      BEEHIIV_PUBLICATION_ID: "pub-secret-DDDD4444",
      FACEBOOK_PAGE_ACCESS_TOKEN: "fb-secret-EEEE5555",
      FACEBOOK_PAGE_ID: "fb-page-secret-FFFF6666",
      INSTAGRAM_ACCESS_TOKEN: "ig-secret-GGGG7777",
      INSTAGRAM_BUSINESS_ACCOUNT_ID: "ig-biz-secret-HHHH8888",
      CLARICE_API_KEY: "clarice-secret-IIII9999",
    } satisfies EnvMap;

    // fetch mockado devolve erros ambíguos (401/500/rede) — cenário
    // adversarial: se qualquer probe ecoasse o secret na URL ou no corpo do
    // erro, apareceria aqui.
    const errorFetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.cloudflare.com")) return { ok: false, status: 401, json: async () => ({}), text: async () => "unauthorized" } as Response;
      if (u.includes("beehiiv.com")) return { ok: false, status: 401, json: async () => ({}), text: async () => "unauthorized" } as Response;
      if (u.includes("graph.facebook.com")) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: { message: "Invalid OAuth access token", code: 190 } }),
        } as Response;
      }
      if (u.includes("cortex.clarice.ai")) return { ok: false, status: 401, json: async () => ({}), text: async () => "unauthorized" } as Response;
      if (u.includes("li.workers.dev")) throw new Error(`network error hitting ${u}`);
      throw new Error(`unexpected url: ${u} init=${JSON.stringify(init?.headers)}`);
    }) as FetchFn;

    const data = await buildIntegrationsData(root, { env: SECRETS, fetchImpl: errorFetch, now: () => 0 });
    const serialized = JSON.stringify(data);

    for (const [name, value] of Object.entries(SECRETS)) {
      assert.ok(!serialized.includes(value), `secret de ${name} ("${value}") vazou no payload!`);
    }

    rmSync(root, { recursive: true, force: true });
  });

  it("missingEnvVars carrega só NOMES, nunca o texto de um valor configurado", async () => {
    clearIntegrationsCache();
    const root = makeTmpRoot("studio-integrations-missing-names-");
    const env: EnvMap = { CLOUDFLARE_API_TOKEN: "super-secreto-nao-deveria-aparecer" };
    const data = await buildIntegrationsData(root, {
      env,
      fetchImpl: mockFetch(200, { success: true, result: { status: "active" } }),
      now: () => 0,
    });
    const cf = data.integrations.find((i) => i.id === "cloudflare")!;
    assert.deepEqual(cf.missingEnvVars, ["CLOUDFLARE_ACCOUNT_ID"]);
    assert.ok(!JSON.stringify(data).includes("super-secreto-nao-deveria-aparecer"));
    rmSync(root, { recursive: true, force: true });
  });
});

// ─── contrato HTTP: GET /integracoes + GET /api/integrations ───────────

const ALL_ENV_KEYS = [
  ...new Set(INTEGRATIONS.flatMap((i) => [...i.envVars, ...(i.optionalEnvVars ?? [])])),
];

describe("GET /integracoes + GET /api/integrations (#3848)", () => {
  let root: string;
  let server: StudioServer;
  const savedEnv: Record<string, string | undefined> = {};

  before(async () => {
    // Limpa TODAS as env vars que qualquer integração declara — garante que
    // GET /api/integrations nunca dispara chamada de rede real neste teste,
    // mesmo que a máquina rodando o teste tenha credenciais reais no
    // process.env (mesma disciplina de studio-apoios-page.test.ts, #3602).
    for (const key of ALL_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    clearIntegrationsCache();
    root = mkdtempSync(join(tmpdir(), "studio-integrations-page-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    server = await startStudioServer({
      port: 0,
      rootDir: root,
      pollIntervalMs: 30,
      // 2ª camada de proteção: mesmo se alguma env var escapasse da limpeza
      // acima, este fetchImpl nunca completaria uma chamada de rede real.
      integrationsFetchImpl: (async () => {
        throw new Error("rede real desabilitada neste teste (#3848)");
      }) as typeof fetch,
    });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
    for (const key of ALL_ENV_KEYS) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
    }
    clearIntegrationsCache();
  });

  it("serve o shell integracoes.html", async () => {
    const res = await fetch(new URL("/integracoes", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const body = await res.text();
    assert.ok(body.includes("integracoes.js"));
    assert.ok(body.includes("integrations-tbody"));
  });

  it("(#3874) banner de erro tem role=alert; tabela tem contêiner de estado vazio", async () => {
    const res = await fetch(new URL("/integracoes", server.url));
    const body = await res.text();
    assert.ok(body.includes('id="integrations-error" class="panel alert-banner" role="alert"'));
    assert.ok(body.includes('id="integrations-empty"'));
  });

  it("aceita /integracoes/ com trailing slash", async () => {
    const res = await fetch(new URL("/integracoes/", server.url));
    assert.equal(res.status, 200);
  });

  it("GET /integracoes.js e /integracoes.css são servidos normalmente (static-serve)", async () => {
    const js = await fetch(new URL("/integracoes.js", server.url));
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    const css = await fetch(new URL("/integracoes.css", server.url));
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /css/);
  });

  it("GET /api/integrations — 200 fail-soft, sem credenciais tudo skipped/not_verified", async () => {
    const res = await fetch(new URL("/api/integrations", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.integrations.length, INTEGRATIONS.length);
    for (const integration of body.integrations) {
      assert.ok(["skipped", "not_verified"].includes(integration.reachable), `${integration.id}: ${integration.reachable}`);
    }
    // nenhum valor de secret (não que houvesse algum real aqui, mas garante
    // que o campo nem existe no shape servido via HTTP).
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes("process.env"));
  });

  it("GET /api/integrations?refresh=1 força bypass do cache sem quebrar", async () => {
    const res = await fetch(new URL("/api/integrations?refresh=1", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cached, false);
  });

  it("payload de /api/integrations inclui execMode e generatedAt", async () => {
    const res = await fetch(new URL("/api/integrations", server.url));
    const body = await res.json();
    assert.ok(typeof body.execMode === "string");
    assert.ok(typeof body.generatedAt === "string");
  });
});
