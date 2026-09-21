/**
 * test/site-worker-apoiar-7915.test.ts (#7915, reescrito no #8498)
 *
 * Cobre o wiring de `/apoiar/ir` e `/apoiar` no router de `workers/site`
 * (mesmo `env.ASSETS` fake e mesma disciplina de `test/site-worker-confirmado-7737.test.ts`):
 *
 *   - GET /apoiar/ir incrementa o contador de CLIQUE e redireciona (302)
 *     pro apoia.se com o UTM do menu, preservando a query string — nunca
 *     chega no ASSETS (não existe arquivo nesse path).
 *   - GET /apoiar (página removida, #8498) é 301 PERMANENTE pro mesmo
 *     destino — nunca 404, nunca serve asset.
 *   - O contador de VISUALIZAÇÃO saiu junto com a página: nenhuma chave
 *     `counter:apoiar:view:*` é escrita.
 *   - KV ausente nunca derruba o redirect — fail-soft.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_STATIC_SITEMAP_PATHS } from "../scripts/lib/site-home-page.ts";

import worker from "../workers/site/src/index.ts";
import type { Env } from "../workers/site/src/index.ts";
import { apoiarClickCounterKey, apoiarLegacyCounterKey } from "../scripts/lib/shared/apoiar-counters.ts";
import { DIARIA_APOIASE_URL } from "../scripts/lib/canonical-urls.ts";
import {
  APOIAR_REDIRECT_UTM_SOURCE,
  APOIAR_REDIRECT_UTM_MEDIUM,
  APOIAR_REDIRECT_UTM_CAMPAIGN,
} from "../scripts/lib/shared/utm-registry.ts";

const DEFAULT_TARGET = `${DIARIA_APOIASE_URL}?utm_source=${APOIAR_REDIRECT_UTM_SOURCE}&utm_medium=${APOIAR_REDIRECT_UTM_MEDIUM}&utm_campaign=${APOIAR_REDIRECT_UTM_CAMPAIGN}`;

function makeFakeKv(): { kv: KVNamespace; puts: Record<string, string> } {
  const puts: Record<string, string> = {};
  const kv = {
    get: async (key: string) => puts[key] ?? null,
    put: async (key: string, value: string) => {
      puts[key] = value;
    },
    delete: async () => {},
  } as unknown as KVNamespace;
  return { kv, puts };
}

function fakeEnv(kv?: KVNamespace): { env: Env; assetCalls: Request[] } {
  const assetCalls: Request[] = [];
  const env: Env = {
    ASSETS: {
      fetch: async (req: Request) => {
        assetCalls.push(req);
        return new Response("<html>fake asset</html>", { status: 200 });
      },
    } as unknown as Env["ASSETS"],
    POLL: { get: async () => null },
    ...(kv ? { CURSOS_SUBSCRIBERS: kv } : {}),
  };
  return { env, assetCalls };
}

describe("GET /apoiar/ir (#7915/#8498) — clique de apoio, nunca pagamento confirmado", () => {
  it("redireciona (302) pro apoia.se com o UTM do menu e incrementa o contador de CLIQUE — nunca chega no ASSETS", async () => {
    const { kv, puts } = makeFakeKv();
    const { env, assetCalls } = fakeEnv(kv);
    const res = await worker.fetch(new Request("https://diar.ia.br/apoiar/ir"), env);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("Location"), DEFAULT_TARGET);
    assert.equal(assetCalls.length, 0, "/apoiar/ir é resolvido ANTES do asset lookup");
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(puts[apoiarClickCounterKey(day)], "1");
  });

  it("preserva a query string do request e não sobrescreve UTM explícito do chamador", async () => {
    const { kv } = makeFakeKv();
    const { env } = fakeEnv(kv);
    const res = await worker.fetch(new Request("https://diar.ia.br/apoiar/ir?utm_source=home&ref=x"), env);
    const location = new URL(res.headers.get("Location") ?? "");
    assert.equal(location.origin + location.pathname, DIARIA_APOIASE_URL);
    assert.equal(location.searchParams.get("utm_source"), "home", "UTM explícito vence o default");
    assert.equal(location.searchParams.get("ref"), "x");
    assert.equal(location.searchParams.get("utm_medium"), APOIAR_REDIRECT_UTM_MEDIUM, "ausente → default");
    assert.equal(location.searchParams.get("utm_campaign"), APOIAR_REDIRECT_UTM_CAMPAIGN, "ausente → default");
  });

  it("KV ausente (binding não propagado) não impede o redirect — fail-soft", async () => {
    const { env } = fakeEnv(undefined);
    const res = await worker.fetch(new Request("https://diar.ia.br/apoiar/ir"), env);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("Location"), DEFAULT_TARGET);
  });

  it("POST não é a rota de clique — cai no asset lookup normal, não é redirect", async () => {
    const { kv } = makeFakeKv();
    const { env, assetCalls } = fakeEnv(kv);
    const res = await worker.fetch(new Request("https://diar.ia.br/apoiar/ir", { method: "POST" }), env);
    assert.notEqual(res.status, 302);
    assert.equal(assetCalls.length, 1);
  });
});

describe("GET /apoiar (#8498) — página removida, 301 permanente pro Apoia.se", () => {
  for (const path of ["/apoiar", "/apoiar/"]) {
    it(`${path} → 301 pro destino com UTM, sem tocar no ASSETS`, async () => {
      const { kv, puts } = makeFakeKv();
      const { env, assetCalls } = fakeEnv(kv);
      const res = await worker.fetch(new Request(`https://diar.ia.br${path}`), env);
      assert.equal(res.status, 301);
      assert.equal(res.headers.get("Location"), DEFAULT_TARGET);
      assert.equal(assetCalls.length, 0);
      const day = new Date().toISOString().slice(0, 10);
      assert.equal(puts[apoiarLegacyCounterKey(day)], "1", "301 legado conta em chave separada");
      assert.equal(puts[apoiarClickCounterKey(day)], undefined, "nunca mistura com o clique do menu");
    });
  }

  it("/apoiar/ com UTM completo + query já presentes: nada é sobrescrito, query preservada", async () => {
    const { env } = fakeEnv(undefined);
    const res = await worker.fetch(
      new Request("https://diar.ia.br/apoiar/?utm_source=a&utm_medium=b&utm_campaign=c&x=1"),
      env,
    );
    const q = new URL(res.headers.get("Location") ?? "").searchParams;
    assert.deepEqual([q.get("utm_source"), q.get("utm_medium"), q.get("utm_campaign"), q.get("x")], ["a", "b", "c", "1"]);
  });

  it("/apoiar/ir com só utm_medium/utm_campaign explícitos: source cai no default", async () => {
    const { env } = fakeEnv(undefined);
    const res = await worker.fetch(new Request("https://diar.ia.br/apoiar/ir?utm_medium=b&utm_campaign=c"), env);
    const q = new URL(res.headers.get("Location") ?? "").searchParams;
    assert.deepEqual([q.get("utm_source"), q.get("utm_medium"), q.get("utm_campaign")], [APOIAR_REDIRECT_UTM_SOURCE, "b", "c"]);
  });

  it("preserva a query string no 301", async () => {
    const { env } = fakeEnv(undefined);
    const res = await worker.fetch(new Request("https://diar.ia.br/apoiar?utm_source=gsc"), env);
    assert.equal(res.status, 301);
    assert.equal(new URL(res.headers.get("Location") ?? "").searchParams.get("utm_source"), "gsc");
  });

  it("nenhuma chave de VISUALIZAÇÃO é escrita — contador saiu com a página", async () => {
    const { kv, puts } = makeFakeKv();
    const { env } = fakeEnv(kv);
    await worker.fetch(new Request("https://diar.ia.br/apoiar"), env);
    assert.deepEqual(Object.keys(puts).filter((k) => k.includes(":view:")), []);
  });

  it("outro path (ex: /apoiar-outra-coisa) não é redirecionado", async () => {
    const { kv } = makeFakeKv();
    const { env, assetCalls } = fakeEnv(kv);
    const res = await worker.fetch(new Request("https://diar.ia.br/apoiar-outra-coisa"), env);
    assert.equal(res.status, 200);
    assert.equal(assetCalls.length, 1);
  });
});

describe("página /apoiar removida (#8498) — nada a resgatar do sitemap nem do disco", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  it("/apoiar e /apoiar/ ausentes de KNOWN_STATIC_SITEMAP_PATHS", () => {
    for (const p of ["/apoiar", "/apoiar/"]) {
      assert.ok(!KNOWN_STATIC_SITEMAP_PATHS.includes(p), `${p} ainda em KNOWN_STATIC_SITEMAP_PATHS`);
    }
  });

  it("sitemap.xml commitado não lista /apoiar", () => {
    const xml = readFileSync(resolve(root, "workers/site/public/sitemap.xml"), "utf8");
    assert.doesNotMatch(xml, /diar\.ia\.br\/apoiar/);
  });

  it("workers/site/public/apoiar/ não existe", () => {
    assert.equal(existsSync(resolve(root, "workers/site/public/apoiar")), false);
  });
});
