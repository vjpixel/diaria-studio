/**
 * test/site-img-same-origin-7657.test.ts (#7657)
 *
 * Regressão do bug: as capas da home vinham de `eia.diar.ia.br/img/{key}` —
 * host DIFERENTE do documento. Um bloqueador de conteúdo no navegador do
 * leitor que corte o subdomínio derruba as 7 capas da home de uma vez, e a
 * falha é 100% client-side (não gera log nosso, não dá pra medir quantos
 * leitores veem a home quebrada). Reproduzido ao vivo no Chrome do editor em
 * 08/09/2026: requisições morrendo em 4-10 ms com `transferSize: 0` e
 * `nextHopProtocol: ""`, enquanto `poll.diaria.workers.dev/img/{a MESMA
 * imagem}` respondia 200 no mesmo segundo e o analytics da zona registrava
 * ZERO 403 em `/img/` no período.
 *
 * O que estes testes travam:
 *   1. a home referencia `/img/{key}` (mesma origem), nunca o host do É IA?;
 *   2. `workers/site` serve `/img/{key}` do KV com os MESMOS contratos que
 *      `workers/poll` já servia (allowlist #4112, ETag/304 #5136,
 *      Cache-Control por classe de key #5136, CORS em 404 #1132);
 *   3. o binding do KV está declarado no wrangler.toml apontando pro MESMO
 *      namespace do poll — sem isso o Worker deploya e serve 404 em tudo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import worker from "../workers/site/src/index.ts";
import type { Env } from "../workers/site/src/index.ts";
import { sameOriginImageUrl } from "../scripts/lib/site-home-page.ts";
import { imageKeyFromPath, isPublicImageKey, imageCacheControlFor } from "../scripts/lib/shared/kv-image.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Bytes reais não importam — só precisam ser estáveis pro ETag ser estável. */
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).buffer;

function fakeEnv(kv: Record<string, ArrayBuffer>): { env: Env; assetCalls: string[] } {
  const assetCalls: string[] = [];
  const env: Env = {
    ASSETS: {
      // @ts-expect-error — só o método `fetch` importa pro teste.
      fetch: async (req: Request) => {
        assetCalls.push(new URL(req.url).pathname);
        return new Response("not found", { status: 404 });
      },
    },
    POLL: { get: async (key: string) => kv[key] ?? null },
  };
  return { env, assetCalls };
}

describe("sameOriginImageUrl (puro, #7657)", () => {
  it("reescreve a capa do É IA? pra caminho relativo (mesma origem)", () => {
    assert.equal(
      sameOriginImageUrl("https://eia.diar.ia.br/img/img-260908-04-d1-2x1-984d45b7.jpg"),
      "/img/img-260908-04-d1-2x1-984d45b7.jpg",
    );
  });

  it("preserva query string e fragmento", () => {
    assert.equal(sameOriginImageUrl("https://eia.diar.ia.br/img/img-260908-a.jpg?v=2"), "/img/img-260908-a.jpg?v=2");
  });

  it("aceita http além de https (edições antigas)", () => {
    assert.equal(sameOriginImageUrl("http://eia.diar.ia.br/img/img-260101-x.jpg"), "/img/img-260101-x.jpg");
  });

  it("aceita protocol-relative //host/img/ — senão o bug volta em silêncio", () => {
    assert.equal(sameOriginImageUrl("//eia.diar.ia.br/img/img-260908-a.jpg"), "/img/img-260908-a.jpg");
  });

  it("NÃO casa porta explícita — o host de produção não usa, e este Worker não a escuta", () => {
    const comPorta = "https://eia.diar.ia.br:8443/img/img-260908-a.jpg";
    assert.equal(sameOriginImageUrl(comPorta), comPorta);
  });

  it("NÃO toca src de outro host — reescrever daria imagem morta", () => {
    // `workers/site` não sabe servir esses bytes: não estão no KV `POLL`.
    for (const src of [
      "https://media.beehiiv.com/cdn-cgi/image/fit=scale-down/uploads/asset/file/x/y.png",
      "https://poll.diaria.workers.dev/img/img-260908-04-d1-2x1-984d45b7.jpg",
      "https://diar-ia-poll.diaria.workers.dev/img/img-260101-a.jpg",
    ]) {
      assert.equal(sameOriginImageUrl(src), src);
    }
  });

  it("NÃO toca outros paths do host do É IA? — só /img/", () => {
    assert.equal(sameOriginImageUrl("https://eia.diar.ia.br/jogar"), "https://eia.diar.ia.br/jogar");
    assert.equal(sameOriginImageUrl("https://eia.diar.ia.br/leaderboard"), "https://eia.diar.ia.br/leaderboard");
  });

  it("não casa host que apenas TERMINA em eia.diar.ia.br", () => {
    const evil = "https://evil-eia.diar.ia.br/img/img-260908-a.jpg";
    assert.equal(sameOriginImageUrl(evil), evil);
  });
});

describe("imageKeyFromPath (puro, #7657)", () => {
  it("extrai a key de /img/{key}", () => {
    assert.equal(imageKeyFromPath("/img/img-260908-04-d1-2x1-984d45b7.jpg"), "img-260908-04-d1-2x1-984d45b7.jpg");
  });

  it("decodifica percent-encoding", () => {
    assert.equal(imageKeyFromPath("/img/img-260908%2Da.jpg"), "img-260908-a.jpg");
  });

  it("devolve null (nunca lança) em % malformado — #4112", () => {
    assert.equal(imageKeyFromPath("/img/%"), null);
  });

  it("devolve null pra path fora de /img/ e pra /img/ vazio", () => {
    assert.equal(imageKeyFromPath("/"), null);
    assert.equal(imageKeyFromPath("/p/slug"), null);
    assert.equal(imageKeyFromPath("/img/"), null);
  });
});

describe("isPublicImageKey — allowlist do #4112 vale no host novo", () => {
  it("aceita as keys que a pipeline grava", () => {
    assert.equal(isPublicImageKey("img-260908-04-d1-2x1-984d45b7.jpg"), true);
    assert.equal(isPublicImageKey("img-260908-01-eia-A.jpg"), true);
    assert.equal(isPublicImageKey("img-monthly-2608-d1.jpg"), true);
  });

  it("recusa TODA key de estado do KV — é o buraco que o #4112 fechou", () => {
    for (const key of [
      "correct:260908",
      "leaderboard-snapshot:2026-09",
      "score:leitor@exemplo.com",
      "vote:260908:leitor@exemplo.com",
      "nickname:fulano",
      "valid_editions",
      "img-algo:secreto",
    ]) {
      assert.equal(isPublicImageKey(key), false, `deveria recusar ${key}`);
    }
  });
});

describe("workers/site — GET /img/{key} (#7657)", () => {
  it("serve os bytes do KV com Content-Type, CORS e Cache-Control da classe da key", async () => {
    const key = "img-260908-04-d1-2x1-984d45b7.jpg";
    const { env, assetCalls } = fakeEnv({ [key]: JPEG_BYTES });
    const res = await worker.fetch(new Request(`https://diar.ia.br/img/${key}`), env);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "image/jpeg");
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    // Key content-addressed (hash de 8 hex) → immutable de 1 ano (#5136).
    assert.equal(res.headers.get("Cache-Control"), imageCacheControlFor(key));
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
    assert.ok(res.headers.get("ETag"));
    assert.equal((await res.arrayBuffer()).byteLength, JPEG_BYTES.byteLength);
    // Nunca desce pro asset lookup — não existe public/img/ nenhum.
    assert.deepEqual(assetCalls, []);
  });

  it("key de convenção fixa (É IA? A/B) recebe max-age curto, não immutable", async () => {
    const key = "img-260908-01-eia-A.jpg";
    const { env } = fakeEnv({ [key]: JPEG_BYTES });
    const res = await worker.fetch(new Request(`https://diar.ia.br/img/${key}`), env);
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=3600");
  });

  it("If-None-Match com o mesmo ETag → 304 sem corpo", async () => {
    const key = "img-260908-04-d1-2x1-984d45b7.jpg";
    const { env } = fakeEnv({ [key]: JPEG_BYTES });
    const first = await worker.fetch(new Request(`https://diar.ia.br/img/${key}`), env);
    const etag = first.headers.get("ETag")!;

    const second = await worker.fetch(
      new Request(`https://diar.ia.br/img/${key}`, { headers: { "If-None-Match": etag } }),
      env,
    );
    assert.equal(second.status, 304);
    assert.equal(second.headers.get("ETag"), etag);
    assert.equal(second.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(await second.text(), "");
  });

  it("key ausente no KV → 404 COM header de CORS (#1132 P2.4)", async () => {
    const { env } = fakeEnv({});
    const res = await worker.fetch(new Request("https://diar.ia.br/img/img-260908-nao-existe.jpg"), env);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("key de estado do KV → 404, nunca vaza o valor (#4112 no host novo)", async () => {
    const { env } = fakeEnv({ "correct:260908": JPEG_BYTES });
    const res = await worker.fetch(new Request("https://diar.ia.br/img/correct:260908"), env);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), "not found");
  });

  it("método de escrita não passa pelo KV — cai no fluxo de asset de sempre", async () => {
    const key = "img-260908-04-d1-2x1-984d45b7.jpg";
    const { env, assetCalls } = fakeEnv({ [key]: JPEG_BYTES });
    const res = await worker.fetch(new Request(`https://diar.ia.br/img/${key}`, { method: "POST" }), env);
    assert.equal(res.status, 404);
    assert.deepEqual(assetCalls, [`/img/${key}`]);
  });

  it("HEAD devolve os mesmos headers do GET (ramo aceito no dispatch, antes sem cobertura)", async () => {
    const key = "img-260908-04-d1-2x1-984d45b7.jpg";
    const { env, assetCalls } = fakeEnv({ [key]: JPEG_BYTES });
    const get = await worker.fetch(new Request(`https://diar.ia.br/img/${key}`), env);
    const head = await worker.fetch(new Request(`https://diar.ia.br/img/${key}`, { method: "HEAD" }), env);

    assert.equal(head.status, 200);
    assert.equal(head.headers.get("Content-Type"), "image/jpeg");
    assert.equal(head.headers.get("Cache-Control"), get.headers.get("Cache-Control"));
    assert.equal(head.headers.get("ETag"), get.headers.get("ETag"));
    assert.equal(head.headers.get("Access-Control-Allow-Origin"), "*");
    // Nunca cai no asset lookup — HEAD é servido pelo KV como o GET.
    assert.deepEqual(assetCalls, []);
  });

  it("KV lançando → 503 COM CORS, nunca exceção crua nem 404 (que seria cacheável)", async () => {
    const env: Env = {
      ASSETS: {
        // @ts-expect-error — só o método `fetch` importa pro teste.
        fetch: async () => new Response("not found", { status: 404 }),
      },
      POLL: {
        get: async () => {
          throw new Error("KV indisponível");
        },
      },
    };
    const errs: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errs.push(args);
    try {
      const res = await worker.fetch(
        new Request("https://diar.ia.br/img/img-260908-04-d1-2x1-984d45b7.jpg"),
        env,
      );
      // 503 e não 404: falha de KV é transitória, 404 é definitivo e cacheável.
      assert.equal(res.status, 503);
      // Sem o catch, a exceção subiria e o leitor receberia a página de erro
      // da Cloudflare — que não emite CORS, furando o invariante do #1132 P2.4.
      assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
      assert.equal(errs.length, 1, "a falha precisa aparecer no Workers Logs");
      assert.match(String(errs[0][0]), /img-260908-04-d1-2x1-984d45b7\.jpg/);
    } finally {
      console.error = original;
    }
  });

  it("path fora de /img/ segue intocado pelo caminho novo", async () => {
    const { env, assetCalls } = fakeEnv({});
    await worker.fetch(new Request("https://diar.ia.br/sitemap.xml"), env);
    assert.deepEqual(assetCalls, ["/sitemap.xml"]);
  });
});

describe("workers/site/wrangler.toml — binding do KV (#7657)", () => {
  const siteToml = readFileSync(resolve(ROOT, "workers", "site", "wrangler.toml"), "utf8");
  const pollToml = readFileSync(resolve(ROOT, "workers", "poll", "wrangler.toml"), "utf8");

  it("declara o binding POLL", () => {
    assert.match(siteToml, /\[\[kv_namespaces\]\][\s\S]*?binding\s*=\s*"POLL"/);
  });

  it("aponta pro MESMO namespace que workers/poll — id divergente serviria 404 em tudo", () => {
    const idOf = (toml: string) => {
      const block = toml.match(/\[\[kv_namespaces\]\][\s\S]*?binding\s*=\s*"POLL"[\s\S]*?id\s*=\s*"([0-9a-f]+)"/);
      return block?.[1] ?? null;
    };
    const siteId = idOf(siteToml);
    assert.ok(siteId, "workers/site não declara id do KV POLL");
    assert.equal(siteId, idOf(pollToml));
  });

  it("mantém run_worker_first — sem isso o script nunca roda e /img/ fica morto", () => {
    assert.match(siteToml, /^run_worker_first\s*=\s*true$/m);
  });
});
