/**
 * test/onboarding-form-robots-txt-10809.test.ts (#10809)
 *
 * Regressão (#633): o #10797 deu `custom_domain` (formulario.diar.ia.br) ao
 * Worker `onboarding-form` sem rota `/robots.txt` — o host nascia servindo o
 * default da Cloudflare e o guard `worker-robots-txt-guard-4777` deixou o
 * master vermelho. Exercita a rota real via `worker.fetch`, mesmo padrão de
 * `test/poll-robots-txt-4777.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "../workers/onboarding-form/src/index.ts";
import { robotsTxtAllowsGeneralCrawling } from "../scripts/lib/shared/robots-txt.ts";
import { evaluateRobotsDrift } from "../scripts/lib/robots-txt-drift-check.ts";

const URL_ROBOTS = "https://formulario.diar.ia.br/robots.txt";

describe("GET /robots.txt no Worker onboarding-form (#10809)", () => {
  it("200 text/plain com Allow: / e /enviar e /api/ fora do rastreamento", async () => {
    const env = { ONBOARDING_FORM: {} as unknown as KVNamespace, ONBOARDING_FORM_LINK_SECRET: "x".repeat(40) } as Env;
    const res = await worker.fetch(new Request(URL_ROBOTS), env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
    const body = await res.text();
    assert.ok(robotsTxtAllowsGeneralCrawling(body), body);
    assert.match(body, /Disallow: \/enviar/);
    assert.match(body, /Disallow: \/api\//);
    // #10871: Sitemap: PRÓPRIO do host (nunca o do site principal).
    assert.match(body, /^Sitemap: https:\/\/formulario\.diar\.ia\.br\/sitemap\.xml$/m);
  });

  it("#10871: o robots.txt servido passa no alarme robots-txt-drift-check (sem 'sem linha Sitemap')", async () => {
    const res = await worker.fetch(new Request(URL_ROBOTS), {} as Env);
    const body = await res.text();
    const result = evaluateRobotsDrift({
      host: "formulario.diar.ia.br",
      url: URL_ROBOTS,
      robotsTxt: body,
      httpStatus: res.status,
      fetchError: null,
    });
    assert.equal(result.status, "ok", result.message);
  });

  it("#10871: GET /sitemap.xml declarado responde 200 com <urlset> vazio, sem KV", async () => {
    const res = await worker.fetch(new Request("https://formulario.diar.ia.br/sitemap.xml"), {} as Env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/xml/);
    const xml = await res.text();
    assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"><\/urlset>/);
    assert.doesNotMatch(xml, /<url>/);
  });

  it("não depende do KV nem do secret (responde antes do 503 not_configured)", async () => {
    const res = await worker.fetch(new Request(URL_ROBOTS), {} as Env);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /User-agent: \*/);
  });

  it("POST /robots.txt não cai na rota", async () => {
    const res = await worker.fetch(new Request(URL_ROBOTS, { method: "POST" }), {} as Env);
    assert.notEqual(res.status, 200);
  });
});
