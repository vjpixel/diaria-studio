/**
 * test/gsc-submit-sitemaps.test.ts (#4546 passo 3)
 *
 * `submitSitemap`/`submitAll` recebem um `fetchImpl` injetável — os testes
 * nunca chamam `gFetch` de verdade (que exigiria `data/.credentials.json`
 * real, ausente em CI/sessão cloud). Mesma disciplina de
 * `test/seo-index-check.test.ts`: as funções puras/injetáveis são cobertas,
 * a autenticação de verdade não.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  submitSitemap,
  submitAll,
  CURADORIA_SITEMAPS,
} from "../scripts/gsc-submit-sitemaps.ts";

function fakeResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

describe("CURADORIA_SITEMAPS (#4546)", () => {
  it("são exatamente os 3 sitemaps próprios de cursos/livros/arquivo — sem o do host principal nem o de artigo.", () => {
    assert.deepEqual(CURADORIA_SITEMAPS, [
      "https://cursos.diar.ia.br/sitemap.xml",
      "https://livros.diar.ia.br/sitemap.xml",
      "https://arquivo.diar.ia.br/sitemap.xml",
    ]);
  });
});

describe("submitSitemap (#4546)", () => {
  it("PUT bem-sucedido (2xx) → ok:true com o status devolvido", async () => {
    const fetchImpl = async () => fakeResponse(200, "");
    const r = await submitSitemap("sc-domain:diar.ia.br", "https://cursos.diar.ia.br/sitemap.xml", fetchImpl);
    assert.deepEqual(r, { sitemapUrl: "https://cursos.diar.ia.br/sitemap.xml", ok: true, status: 200 });
  });

  it("403 → ok:false com mensagem de remediação citando oauth-setup.ts", async () => {
    const fetchImpl = async () => fakeResponse(403, "insufficientPermissions");
    const r = await submitSitemap("sc-domain:diar.ia.br", "https://livros.diar.ia.br/sitemap.xml", fetchImpl);
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.match(r.error ?? "", /oauth-setup\.ts/);
    assert.match(r.error ?? "", /webmasters/);
  });

  it("outro erro (ex: 500) → ok:false com o corpo (truncado) no error, sem mensagem de 403", async () => {
    const fetchImpl = async () => fakeResponse(500, "internal error blah");
    const r = await submitSitemap("sc-domain:diar.ia.br", "https://arquivo.diar.ia.br/sitemap.xml", fetchImpl);
    assert.equal(r.ok, false);
    assert.equal(r.status, 500);
    assert.match(r.error ?? "", /internal error blah/);
    assert.doesNotMatch(r.error ?? "", /oauth-setup/);
  });

  it("monta a URL da API com site e sitemapUrl url-encoded", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    const fetchImpl = async (url: string, opts?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = opts?.method ?? "";
      return fakeResponse(200, "");
    };
    await submitSitemap("sc-domain:diar.ia.br", "https://cursos.diar.ia.br/sitemap.xml", fetchImpl);
    assert.equal(capturedMethod, "PUT");
    assert.equal(
      capturedUrl,
      "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Adiar.ia.br/sitemaps/https%3A%2F%2Fcursos.diar.ia.br%2Fsitemap.xml",
    );
  });
});

describe("submitAll (#4546)", () => {
  it("submete cada URL em sequência e preserva a ordem no resultado", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return fakeResponse(200, "");
    };
    const results = await submitAll("sc-domain:diar.ia.br", CURADORIA_SITEMAPS, fetchImpl);
    assert.equal(results.length, 3);
    assert.ok(results.every((r) => r.ok));
    assert.deepEqual(
      results.map((r) => r.sitemapUrl),
      CURADORIA_SITEMAPS as unknown as string[],
    );
    assert.equal(calls.length, 3);
  });

  it("uma falha no meio não impede as demais de serem tentadas (nunca aborta cedo)", async () => {
    let i = 0;
    const fetchImpl = async () => {
      i++;
      return i === 2 ? fakeResponse(403, "nope") : fakeResponse(200, "");
    };
    const results = await submitAll("sc-domain:diar.ia.br", CURADORIA_SITEMAPS, fetchImpl);
    assert.equal(results.length, 3);
    assert.deepEqual(
      results.map((r) => r.ok),
      [true, false, true],
    );
  });
});
