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
    // Formulário só abre com link assinado: nada a listar num sitemap.
    assert.doesNotMatch(body, /Sitemap:/);
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
