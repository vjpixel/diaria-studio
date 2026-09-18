/**
 * test/site-worker-archive-cache-validators-8355.test.ts (#8355)
 *
 * `/p/{slug}` no Worker `site` (apex diar.ia.br) respondia `Cache-Control:
 * public, max-age=0, must-revalidate` SEM `ETag`/`Last-Modified` — não há
 * como revalidar, então toda revisita de crawler rebaixa a página inteira
 * (270 páginas, média 61 KB, nunca podendo responder 304). Este teste trava
 * o fix: ETag fraco + Last-Modified (extraído do JSON-LD `datePublished`
 * que `buildArchiveNewsArticleJsonLd`, #8336, grava em cada página) + 304
 * condicional — mesmo padrão já em produção em `workers/arquivo`.
 *
 * Padrão de teste idêntico ao dos irmãos (`site-worker-kit-fallback-6429`):
 * `env.ASSETS` fake que registra as chamadas, sem depender do runtime real
 * de Workers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker, { extractDatePublishedFromArchivePage } from "../workers/site/src/index.ts";
import type { Env } from "../workers/site/src/index.ts";
import { weakEtag, toHttpDate } from "../scripts/lib/shared/http-conditional.ts";

/** Corpo de página do acervo com o JSON-LD `NewsArticle` real que
 * `buildArchiveNewsArticleJsonLd` grava (#8336) — `datePublished` é a data
 * EDITORIAL já resolvida (honra overrides), não `publish_date` cru. */
function archivePageBody(datePublished: string): string {
  return (
    `<html><head><script type="application/ld+json">` +
    `{"@context":"https://schema.org","@type":"NewsArticle","headline":"Título",` +
    `"description":"Descrição","url":"https://diar.ia.br/p/slug",` +
    `"mainEntityOfPage":"https://diar.ia.br/p/slug","datePublished":"${datePublished}",` +
    `"dateModified":"${datePublished}","author":{"@type":"Person","name":"x","url":"https://x"},` +
    `"publisher":{"@type":"Organization","name":"diar.ia.br","url":"https://diar.ia.br"},` +
    `"inLanguage":"pt-BR"}</script></head><body>conteúdo</body></html>`
  );
}

function fakeEnv(
  assetHandler: (req: Request) => Response,
): { env: Env; calls: Request[] } {
  const calls: Request[] = [];
  const env: Env = {
    ASSETS: {
      fetch: async (req: Request) => {
        calls.push(req);
        return assetHandler(req);
      },
    },
    POLL: { get: async () => null },
  };
  return { env, calls };
}

function assetResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "public, max-age=0, must-revalidate", ...headers },
  });
}

describe("extractDatePublishedFromArchivePage (puro, #8355)", () => {
  it("extrai datePublished do JSON-LD NewsArticle", () => {
    assert.equal(extractDatePublishedFromArchivePage(archivePageBody("2025-08-27")), "2025-08-27");
  });

  it("devolve undefined quando a página não tem o JSON-LD (estado atual das 270 páginas antes da #8358 regenerar)", () => {
    assert.equal(extractDatePublishedFromArchivePage("<html><body>sem dateline</body></html>"), undefined);
  });

  it("devolve undefined pra JSON-LD de outro @type (nunca casa datePublished de outro node)", () => {
    const body = `<script type="application/ld+json">{"@type":"Organization","datePublished":"2025-08-27"}</script>`;
    assert.equal(extractDatePublishedFromArchivePage(body), undefined);
  });
});

describe("workers/site — ETag/Last-Modified em /p/{slug} (#8355)", () => {
  it("GET 200 sem JSON-LD ainda (páginas não regeneradas pela #8358) — emite ETag, NUNCA Last-Modified", async () => {
    const body = "<html>página antiga, sem dateline</html>";
    const { env } = fakeEnv(() => assetResponse(body));
    const res = await worker.fetch(new Request("https://diar.ia.br/p/algum-slug"), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("ETag"), weakEtag(body));
    assert.equal(res.headers.get("Last-Modified"), null);
  });

  it("GET 200 com JSON-LD — Last-Modified é a data EDITORIAL do datePublished, nunca a data de import (armadilha das 6 primeiras edições)", async () => {
    // A 1ª edição real é 27/08/2025 (data editorial, já resolvida por
    // publishDateToIso/overrides na geração da página) — NÃO 04/09/2025
    // (data em que o LOTE foi importado pra Beehiiv). O Worker só lê o que
    // já está gravado no JSON-LD, então este teste garante que ele nunca
    // recalcula/confunde as duas.
    const body = archivePageBody("2025-08-27");
    const { env } = fakeEnv(() => assetResponse(body));
    const res = await worker.fetch(new Request("https://diar.ia.br/p/edicao-mais-antiga"), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Last-Modified"), toHttpDate("2025-08-27"));
    assert.notEqual(res.headers.get("Last-Modified"), toHttpDate("2025-09-04"), "nunca a data de import em lote");
    assert.equal(res.headers.get("ETag"), weakEtag(body));
  });

  it("If-None-Match com o ETag correto — devolve 304 sem corpo, preserva Cache-Control", async () => {
    const body = archivePageBody("2026-01-15");
    const { env } = fakeEnv(() => assetResponse(body));
    const etag = weakEtag(body);
    const res = await worker.fetch(
      new Request("https://diar.ia.br/p/algum-slug", { headers: { "If-None-Match": etag } }),
      env,
    );
    assert.equal(res.status, 304);
    assert.equal(await res.text(), "");
    assert.equal(res.headers.get("ETag"), etag);
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=0, must-revalidate");
  });

  it("If-None-Match com ETag errado (conteúdo mudou) — 200 normal com o corpo novo", async () => {
    const body = archivePageBody("2026-01-15");
    const { env } = fakeEnv(() => assetResponse(body));
    const res = await worker.fetch(
      new Request("https://diar.ia.br/p/algum-slug", { headers: { "If-None-Match": 'W/"deadbeef"' } }),
      env,
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), body);
  });

  it("If-Modified-Since >= Last-Modified — devolve 304", async () => {
    const body = archivePageBody("2026-01-15");
    const { env } = fakeEnv(() => assetResponse(body));
    const res = await worker.fetch(
      new Request("https://diar.ia.br/p/algum-slug", { headers: { "If-Modified-Since": toHttpDate("2026-01-16") } }),
      env,
    );
    assert.equal(res.status, 304);
  });

  it("If-Modified-Since < Last-Modified — 200 normal (mudou depois da data pedida)", async () => {
    const body = archivePageBody("2026-01-15");
    const { env } = fakeEnv(() => assetResponse(body));
    const res = await worker.fetch(
      new Request("https://diar.ia.br/p/algum-slug", { headers: { "If-Modified-Since": toHttpDate("2026-01-10") } }),
      env,
    );
    assert.equal(res.status, 200);
  });

  it("HEAD — refaz fetch como GET internamente e devolve os MESMOS ETag/Last-Modified que o GET, corpo vazio", async () => {
    const body = archivePageBody("2026-01-15");
    const { env, calls } = fakeEnv(() => assetResponse(body));
    const res = await worker.fetch(new Request("https://diar.ia.br/p/algum-slug", { method: "HEAD" }), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("ETag"), weakEtag(body));
    assert.equal(res.headers.get("Last-Modified"), toHttpDate("2026-01-15"));
    assert.equal(await res.text(), "");
    assert.equal(calls.length, 2, "HEAD original + 1 refetch como GET pro corpo");
  });

  it("HEAD com If-None-Match casando — 304 sem corpo", async () => {
    const body = archivePageBody("2026-01-15");
    const { env } = fakeEnv(() => assetResponse(body));
    const etag = weakEtag(body);
    const res = await worker.fetch(
      new Request("https://diar.ia.br/p/algum-slug", { method: "HEAD", headers: { "If-None-Match": etag } }),
      env,
    );
    assert.equal(res.status, 304);
  });

  it("path fora de /p/ (ex: home) nunca ganha ETag/Last-Modified deste mecanismo — segue como sempre", async () => {
    const { env } = fakeEnv(() => new Response("<html>home</html>", { status: 200 }));
    const res = await worker.fetch(new Request("https://diar.ia.br/"), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Last-Modified"), null);
  });

  it("404 em /p/{slug} inexistente continua caindo no fallback do Kit (#6429), não neste mecanismo", async () => {
    const { env } = fakeEnv(() => new Response("not found", { status: 404 }));
    const res = await worker.fetch(new Request("https://diar.ia.br/p/nao-existe"), env);
    assert.equal(res.status, 302);
  });
});
