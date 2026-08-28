/**
 * test/site-worker-kit-fallback-6429.test.ts (#6429)
 *
 * `workers/site` era um Worker de static assets PURO (sem `main`, ver
 * `test/site-worker-routes-6359.test.ts`) até esta issue — ganhou um script
 * mínimo que intercepta só o 404 de `/p/{slug}` e redireciona (302) pro
 * permalink hospedado no Kit, mesmo padrão dos testes irmãos
 * `test/livros-worker.test.ts`/`test/cursos-worker-first.test.ts`: um
 * `env.ASSETS` fake que registra as chamadas, sem depender do Worker
 * runtime real.
 *
 * Causa raiz que este teste trava: edição publicada só pelo Kit (desde o
 * switchover de ENVIO do #6114) nunca entra no cache que
 * `scripts/gen-archive-pages.ts` lê, então a página estática de `/p/{slug}`
 * nunca é gerada e o link de compartilhamento do WhatsApp embutido no
 * e-mail (que aponta pro nosso domínio) vira um 404 pro contato de quem
 * compartilhou.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import worker, { matchArchiveSlug } from "../workers/site/src/index.ts";
import type { Env } from "../workers/site/src/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = resolve(ROOT, "workers", "site", "wrangler.toml");

function fakeEnv(assetStatus: number, assetBody = "<html>fake asset</html>"): { env: Env; calls: Request[] } {
  const calls: Request[] = [];
  const env: Env = {
    ASSETS: {
      // @ts-expect-error — só o método `fetch` importa pro teste.
      fetch: async (req: Request) => {
        calls.push(req);
        return new Response(assetBody, { status: assetStatus });
      },
    },
  };
  return { env, calls };
}

describe("matchArchiveSlug (puro, #6429)", () => {
  it("extrai o slug de /p/{slug} sem barra final", () => {
    assert.equal(matchArchiveSlug("/p/openai-lanca-gpt-5-6-mais-rapido-e-barato"), "openai-lanca-gpt-5-6-mais-rapido-e-barato");
  });

  it("extrai o slug de /p/{slug}/ com barra final", () => {
    assert.equal(matchArchiveSlug("/p/seu-chatbot-pode-ter-lido-propaganda-israelense/"), "seu-chatbot-pode-ter-lido-propaganda-israelense");
  });

  it("não casa / nem /subscribe nem qualquer outro path fora de /p/", () => {
    assert.equal(matchArchiveSlug("/"), null);
    assert.equal(matchArchiveSlug("/subscribe"), null);
    assert.equal(matchArchiveSlug("/sitemap.xml"), null);
  });

  it("não casa /p/ vazio nem /p/{slug}/algo-a-mais", () => {
    assert.equal(matchArchiveSlug("/p/"), null);
    assert.equal(matchArchiveSlug("/p/slug/algo-a-mais"), null);
  });
});

describe("workers/site fetch handler — fallback pro Kit (#6429)", () => {
  it("asset existe (200) — delega pro ASSETS normalmente, nunca redireciona", async () => {
    const { env, calls } = fakeEnv(200);
    const res = await worker.fetch(new Request("https://diar.ia.br/p/openai-lanca-gpt-5-6-mais-rapido-e-barato"), env);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1, "sempre chama o ASSETS primeiro");
  });

  it("404 em /p/{slug} inexistente — redireciona 302 pro permalink do Kit", async () => {
    const { env } = fakeEnv(404);
    const res = await worker.fetch(
      new Request("https://diar.ia.br/p/seu-chatbot-pode-ter-lido-propaganda-israelense"),
      env,
    );
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("Location"), "https://diar-ia-br.kit.com/posts/seu-chatbot-pode-ter-lido-propaganda-israelense");
  });

  it("404 em /p/{slug}/ com barra final — mesmo redirect, slug sem a barra", async () => {
    const { env } = fakeEnv(404);
    const res = await worker.fetch(new Request("https://diar.ia.br/p/edicao-nova/"), env);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("Location"), "https://diar-ia-br.kit.com/posts/edicao-nova");
  });

  it("preserva a query string (UTM do link de compartilhamento) no redirect", async () => {
    const { env } = fakeEnv(404);
    const res = await worker.fetch(
      new Request("https://diar.ia.br/p/seu-chatbot-pode-ter-lido-propaganda-israelense?utm_source=whatsapp&utm_medium=share&utm_campaign=260827"),
      env,
    );
    assert.equal(res.status, 302);
    assert.equal(
      res.headers.get("Location"),
      "https://diar-ia-br.kit.com/posts/seu-chatbot-pode-ter-lido-propaganda-israelense?utm_source=whatsapp&utm_medium=share&utm_campaign=260827",
    );
  });

  it("404 fora de /p/ (ex: rota inexistente qualquer) — NUNCA redireciona, devolve o 404 original", async () => {
    const { env, calls } = fakeEnv(404);
    const res = await worker.fetch(new Request("https://diar.ia.br/nao-existe"), env);
    assert.equal(res.status, 404);
    assert.equal(calls.length, 1);
  });

  it("500 do ASSETS não vira redirect — só 404 dispara o fallback", async () => {
    const { env } = fakeEnv(500);
    const res = await worker.fetch(new Request("https://diar.ia.br/p/algum-slug"), env);
    assert.equal(res.status, 500);
  });
});

describe("wrangler.toml — main + run_worker_first (#6429)", () => {
  const toml = readFileSync(WRANGLER, "utf8");

  it("declara main = \"src/index.ts\" — sem isso o fetch handler acima nunca roda em produção", () => {
    assert.match(toml, /^main\s*=\s*"src\/index\.ts"/m);
  });

  it("run_worker_first = true — sem isso o asset ganha a request antes do script, mesmo invariante do #4052", () => {
    assert.match(toml, /^run_worker_first\s*=\s*true/m);
  });

  it("[assets].binding = \"ASSETS\" — nome que o fetch handler espera em Env", () => {
    assert.match(toml, /^binding\s*=\s*"ASSETS"/m);
  });
});
