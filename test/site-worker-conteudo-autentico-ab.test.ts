/**
 * test/site-worker-conteudo-autentico-ab.test.ts
 *
 * `/produto/conteudo-autentico` passou a ter versões em subpastas (`/a`, a
 * página de 18/10/2026; `/b`, a corrigida em 27/10/2026). A URL principal,
 * que está nos anúncios, na home e nos cursos, redireciona (302) no Worker
 * para a versão ativa, levando a query string (UTMs e fbclid) — nunca chega
 * no ASSETS. As versões em si continuam servidas pelo ASSETS.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import worker, { CONTEUDO_AUTENTICO_PATH, CONTEUDO_AUTENTICO_VERSAO_ATIVA } from "../workers/site/src/index.ts";
import type { Env } from "../workers/site/src/index.ts";

const PAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../workers/site/public/produto/conteudo-autentico");

function fakeEnv(): { env: Env; assetCalls: Request[] } {
  const assetCalls: Request[] = [];
  const env: Env = {
    ASSETS: {
      fetch: async (req: Request) => {
        assetCalls.push(req);
        return new Response("<html>fake asset</html>", { status: 200 });
      },
    } as unknown as Env["ASSETS"],
    POLL: { get: async () => null },
  } as Env;
  return { env, assetCalls };
}

describe("/produto/conteudo-autentico redireciona para a versão ativa", () => {
  it("302 para a versão ativa, com UTMs e fbclid, sem passar pelo ASSETS", async () => {
    const { env, assetCalls } = fakeEnv();
    const res = await worker.fetch(
      new Request("https://diar.ia.br/produto/conteudo-autentico?utm_source=meta&utm_content=AD24&fbclid=abc"),
      env,
    );
    assert.equal(res.status, 302);
    assert.equal(
      res.headers.get("Location"),
      `https://diar.ia.br/produto/conteudo-autentico/${CONTEUDO_AUTENTICO_VERSAO_ATIVA}?utm_source=meta&utm_content=AD24&fbclid=abc`,
    );
    assert.equal(assetCalls.length, 0);
  });

  it("com barra final e sem query também redireciona", async () => {
    const { env } = fakeEnv();
    const res = await worker.fetch(new Request("https://diar.ia.br/produto/conteudo-autentico/"), env);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("Location"), `https://diar.ia.br${CONTEUDO_AUTENTICO_PATH}/${CONTEUDO_AUTENTICO_VERSAO_ATIVA}`);
  });

  it("as versões e os arquivos delas continuam no ASSETS", async () => {
    for (const path of ["/produto/conteudo-autentico/a", "/produto/conteudo-autentico/b", "/produto/conteudo-autentico/assets/cafe-bolo.webp"]) {
      const { env, assetCalls } = fakeEnv();
      const res = await worker.fetch(new Request(`https://diar.ia.br${path}`), env);
      assert.equal(res.status, 200, path);
      assert.equal(assetCalls.length, 1, path);
    }
  });

  it("a versão ativa existe em disco, e a URL principal não tem index.html próprio", () => {
    assert.ok(existsSync(resolve(PAGE_DIR, CONTEUDO_AUTENTICO_VERSAO_ATIVA, "index.html")));
    assert.ok(!existsSync(resolve(PAGE_DIR, "index.html")), "um index.html na raiz seria servido em vez do redirecionamento");
  });

  it("a A fica fora do Google e aponta a canônica para a B; a B é a canônica", () => {
    const a = readFileSync(resolve(PAGE_DIR, "a/index.html"), "utf8");
    const b = readFileSync(resolve(PAGE_DIR, "b/index.html"), "utf8");
    assert.match(a, /<meta name="robots" content="noindex" \/>/);
    assert.match(a, /<link rel="canonical" href="https:\/\/diar\.ia\.br\/produto\/conteudo-autentico\/b" \/>/);
    assert.doesNotMatch(b, /noindex/);
    assert.match(b, /<link rel="canonical" href="https:\/\/diar\.ia\.br\/produto\/conteudo-autentico\/b" \/>/);
  });

  it("cada versão carrega o próprio CSS e JS e marca a versão nos eventos e no sck", () => {
    for (const v of ["a", "b"]) {
      const html = readFileSync(resolve(PAGE_DIR, v, "index.html"), "utf8");
      const js = readFileSync(resolve(PAGE_DIR, v, "script.js"), "utf8");
      assert.ok(html.includes(`/produto/conteudo-autentico/${v}/styles.css`), v);
      assert.ok(html.includes(`/produto/conteudo-autentico/${v}/script.js`), v);
      assert.ok(js.includes(`const VERSAO = "${v}";`), v);
      assert.ok(js.includes('["lp", "conteudo-autentico", VERSAO, content]'), v);
      assert.ok(js.includes("versao: VERSAO"), v);
    }
  });

  it("todo link que sai da página, inclusive o checkout, abre em nova aba", () => {
    for (const v of ["a", "b"]) {
      const html = readFileSync(resolve(PAGE_DIR, v, "index.html"), "utf8");
      const js = readFileSync(resolve(PAGE_DIR, v, "script.js"), "utf8");
      const links = [...html.matchAll(/<a\s[^>]*href="(?!#)[^"]*"[^>]*>/g)].map((m) => m[0]);
      assert.ok(links.length > 0, v);
      for (const a of links) {
        assert.match(a, /target="_blank"/, `${v}: ${a}`);
        assert.match(a, /rel="[^"]*noopener/, `${v}: ${a}`);
      }
      assert.doesNotMatch(js, /window\.location\.href =/, v);
    }
  });
});
