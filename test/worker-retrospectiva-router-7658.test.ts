/**
 * test/worker-retrospectiva-router-7658.test.ts (#7658)
 *
 * Trava o que só existe depois da unificação: **um Worker escolhendo o GATE
 * pelo FORMATO do path**, e os hosts antigos redirecionando.
 *
 * Os dois gates em si já têm teste próprio (`worker-retrospectiva-gate.test.ts`
 * pro de cadastro, `worker-retrospectiva-gate-apoio.test.ts` pro de apoio) e a
 * classificação de path também (`retrospectiva-path-7658.test.ts`). O que
 * ninguém cobria é a JUNÇÃO — e é aí que mora o erro caro deste refactor:
 * servir `/2607` (Retrospectiva do Mês, R$25+) com o gate de cadastro grátis
 * entregaria conteúdo pago a qualquer assinante.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker, { handleGet, legacyRedirectPath, type Env } from "../workers/retrospectiva/src/index.ts";

type MockKV = Map<string, string>;

function makeEnv(articles: MockKV, allowlist: string | null, kitKey?: string): Env {
  return {
    ARTICLES: {
      async get(key: string): Promise<string | null> {
        return articles.get(key) ?? null;
      },
    },
    ALLOWLIST: {
      async get(): Promise<string | null> {
        return allowlist;
      },
    },
    KIT_API_KEY: kitKey,
  } as unknown as Env;
}

/** `fetch` fake do Kit: devolve os e-mails informados como assinantes ativos. */
function kitFetch(ativos: string[]): typeof fetch {
  return (async (url: string | URL) => {
    const email = new URL(String(url)).searchParams.get("email_address") ?? "";
    const subscribers = ativos.includes(email.toLowerCase())
      ? [{ email_address: email, state: "active" }]
      : [];
    return new Response(JSON.stringify({ subscribers }), { status: 200 });
  }) as unknown as typeof fetch;
}

const COMPLETO_MENSAL = "<html><body>Retrospectiva do Mês completa</body></html>";
const COMPLETO_ANUAL = "<html><body>Retrospectiva anual completa</body></html>";

describe("#7658 — o gate vem do FORMATO do path, não de qual Worker atendeu", () => {
  it("/2607 (mensal) usa o gate de APOIO: assinante ativo no Kit NÃO basta", async () => {
    // O erro caro deste refactor seria exatamente este: roteado pro gate de
    // cadastro, um assinante grátis leria conteúdo de Mantenedor.
    const env = makeEnv(new Map([["article:2607", COMPLETO_MENSAL]]), JSON.stringify([]), "key");
    const res = await handleGet(
      new Request("https://retrospectiva.diar.ia.br/2607?email=assinante@x.com"),
      env,
      kitFetch(["assinante@x.com"]),
    );
    const body = await res.text();
    assert.notEqual(body, COMPLETO_MENSAL, "assinante grátis não pode ler a Retrospectiva do Mês");
    assert.match(body, /exclusivo para apoiadores/i);
  });

  it("/2607 com e-mail NA allowlist → completo", async () => {
    const env = makeEnv(new Map([["article:2607", COMPLETO_MENSAL]]), JSON.stringify(["mantenedor@x.com"]), "key");
    const res = await handleGet(
      new Request("https://retrospectiva.diar.ia.br/2607?email=mantenedor@x.com"),
      env,
      kitFetch([]),
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), COMPLETO_MENSAL);
  });

  it("/2026 (anual) usa o gate de CADASTRO: assinante ativo basta, allowlist vazia não atrapalha", async () => {
    const env = makeEnv(new Map([["article:2026", COMPLETO_ANUAL]]), JSON.stringify([]), "key");
    const res = await handleGet(
      new Request("https://retrospectiva.diar.ia.br/2026?email=assinante@x.com"),
      env,
      kitFetch(["assinante@x.com"]),
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), COMPLETO_ANUAL);
  });

  it("/aniversario2026 usa o gate de CADASTRO", async () => {
    const env = makeEnv(new Map([["article:aniversario2026", COMPLETO_ANUAL]]), null, "key");
    const res = await handleGet(
      new Request("https://retrospectiva.diar.ia.br/aniversario2026?email=assinante@x.com"),
      env,
      kitFetch(["assinante@x.com"]),
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), COMPLETO_ANUAL);
  });

  it("/2026 NÃO consulta a allowlist, e /2607 NÃO consulta o Kit", async () => {
    // Cada gate toca só a sua fonte — se um dia trocarem de lugar, isto quebra
    // antes de virar vazamento.
    let allowlistLida = false;
    let kitConsultado = false;
    const env = {
      ARTICLES: { async get() { return COMPLETO_ANUAL; } },
      ALLOWLIST: { async get() { allowlistLida = true; return JSON.stringify([]); } },
      KIT_API_KEY: "key",
    } as unknown as Env;
    const kit = (async (url: string | URL) => {
      kitConsultado = true;
      const email = new URL(String(url)).searchParams.get("email_address") ?? "";
      return new Response(JSON.stringify({ subscribers: [{ email_address: email, state: "active" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    await handleGet(new Request("https://retrospectiva.diar.ia.br/2026?email=a@x.com"), env, kit);
    assert.equal(allowlistLida, false, "gate de cadastro não deve ler a allowlist");
    assert.equal(kitConsultado, true);

    kitConsultado = false;
    await handleGet(new Request("https://retrospectiva.diar.ia.br/2607?email=a@x.com"), env, kit);
    assert.equal(kitConsultado, false, "gate de apoio não deve consultar o Kit");
    assert.equal(allowlistLida, true);
  });

  it("path que não classifica → 400, nunca um gate chutado", async () => {
    const env = makeEnv(new Map(), null, "key");
    for (const p of ["/", "/qualquer-coisa", "/2607-08", "/2026-aniversario"]) {
      const res = await handleGet(new Request(`https://retrospectiva.diar.ia.br${p}?email=a@x.com`), env, kitFetch(["a@x.com"]));
      assert.equal(res.status, 400, `${p} deveria dar 400`);
    }
  });
});

describe("#7658 — fail-closed dos dois gates continua valendo depois da unificação", () => {
  it("allowlist ausente (binding não configurado) → mensal nunca sai", async () => {
    const env = { ARTICLES: { async get() { return COMPLETO_MENSAL; } } } as unknown as Env;
    const res = await handleGet(new Request("https://retrospectiva.diar.ia.br/2607?email=a@x.com"), env, kitFetch([]));
    assert.notEqual(await res.text(), COMPLETO_MENSAL);
  });

  it("KIT_API_KEY ausente → anual nunca sai, mesmo com e-mail que seria válido", async () => {
    const env = makeEnv(new Map([["article:2026", COMPLETO_ANUAL]]), null);
    const res = await handleGet(new Request("https://retrospectiva.diar.ia.br/2026?email=a@x.com"), env, kitFetch(["a@x.com"]));
    assert.notEqual(await res.text(), COMPLETO_ANUAL);
  });
});

describe("#7658 — legacyRedirectPath traduz sem inventar", () => {
  it("anual.diar.ia.br/2026-aniversario → /aniversario2026", () => {
    assert.equal(legacyRedirectPath("anual.diar.ia.br", "/2026-aniversario", ""), "/aniversario2026");
  });

  it("anual.diar.ia.br/2026-janeiro → /2026", () => {
    assert.equal(legacyRedirectPath("anual.diar.ia.br", "/2026-janeiro", ""), "/2026");
  });

  it("artigo.diar.ia.br/2607-08 → /2607", () => {
    assert.equal(legacyRedirectPath("artigo.diar.ia.br", "/2607-08", ""), "/2607");
  });

  it("preserva a query — os links antigos carregam UTM", () => {
    assert.equal(
      legacyRedirectPath("artigo.diar.ia.br", "/2607-08", "?utm_source=kit&email=a%40x.com"),
      "/2607?utm_source=kit&email=a%40x.com",
    );
  });

  it("path que não casa o formato antigo → null (caller manda pra raiz, não chuta)", () => {
    assert.equal(legacyRedirectPath("artigo.diar.ia.br", "/2026-aniversario", ""), null);
    assert.equal(legacyRedirectPath("anual.diar.ia.br", "/2607-08", ""), null);
    assert.equal(legacyRedirectPath("artigo.diar.ia.br", "/lixo", ""), null);
  });
});

describe("#7658 — os hosts antigos respondem 301, sem tocar KV nem Kit", () => {
  const envQueExplode = {
    ARTICLES: { async get() { throw new Error("KV não deveria ser consultado num redirect"); } },
    ALLOWLIST: { async get() { throw new Error("allowlist não deveria ser consultada num redirect"); } },
  } as unknown as Env;

  it("artigo.diar.ia.br/2607-08 → 301 pro path novo", async () => {
    const res = await worker.fetch(new Request("https://artigo.diar.ia.br/2607-08"), envQueExplode);
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("Location"), "https://retrospectiva.diar.ia.br/2607");
  });

  it("anual.diar.ia.br/2026-aniversario → 301 pro path novo", async () => {
    const res = await worker.fetch(new Request("https://anual.diar.ia.br/2026-aniversario"), envQueExplode);
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("Location"), "https://retrospectiva.diar.ia.br/aniversario2026");
  });

  it("path antigo intraduzível → 301 pra raiz do host novo, nunca 404 nem 500", async () => {
    const res = await worker.fetch(new Request("https://artigo.diar.ia.br/lixo"), envQueExplode);
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("Location"), "https://retrospectiva.diar.ia.br/");
  });

  it("o redirect acontece ANTES de /robots.txt e /sitemap.xml do host antigo", async () => {
    // Servir robots/sitemap no host que só redireciona manteria o host antigo
    // vivo no índice, que é o oposto do que a migração quer.
    for (const p of ["/robots.txt", "/sitemap.xml"]) {
      const res = await worker.fetch(new Request(`https://anual.diar.ia.br${p}`), envQueExplode);
      assert.equal(res.status, 301, p);
    }
  });
});
