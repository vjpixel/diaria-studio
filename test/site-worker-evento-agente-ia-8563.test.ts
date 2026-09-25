/**
 * test/site-worker-evento-agente-ia-8563.test.ts (#8563)
 *
 * `diar.ia.br/evento/agente-ia` — página do workshop "Crie seu primeiro
 * agente de IA sem programar", esconde o domínio real (chatgpt.site) do
 * link divulgado. Hospedada como asset ESTÁTICO em
 * `workers/site/public/evento/agente-ia/` (arquivos originais fornecidos
 * pelo editor) — sem código de rota no Worker, cai no `env.ASSETS.fetch`
 * padrão (mesmo path de qualquer página do site, `html_handling =
 * drop-trailing-slash` já resolve `/evento/agente-ia` → `index.html`, mesmo
 * padrão de `/p/{slug}`). Substituiu uma 1ª versão em proxy reverso
 * (fetch ao vivo pro chatgpt.site) do mesmo commit — arquivos reais do
 * editor tornaram o proxy desnecessário e removem o risco de asset relativo
 * quebrado.
 *
 * Este teste cobre só os arquivos COMMITTED (guard de regressão, mesmo
 * padrão de `site-worker-routes-6359.test.ts`) — o roteamento em si
 * (`env.ASSETS.fetch`/`html_handling`) já é coberto pelos testes existentes
 * do fallback do acervo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE_DIR = resolve(ROOT, "workers", "site", "public", "evento", "agente-ia");

describe("public/evento/agente-ia — página do workshop (#8563)", () => {
  it("index.html existe e referencia os próprios arquivos por caminho absoluto", () => {
    const p = resolve(PAGE_DIR, "index.html");
    assert.ok(existsSync(p), "index.html ausente em public/evento/agente-ia/");
    const html = readFileSync(p, "utf8");
    // Nenhum href/src pra chatgpt.site (o ponto inteiro é esconder esse domínio).
    assert.doesNotMatch(html, /chatgpt\.site/i);
    assert.match(html, /href="\/evento\/agente-ia\/styles\.css"/);
    assert.match(html, /src="\/evento\/agente-ia\/config\.js"/);
    assert.match(html, /src="\/evento\/agente-ia\/script\.js"/);
  });

  it("index.html não usa caminho RELATIVO pros próprios arquivos (regressão: CSS não carregava em produção)", () => {
    // A página é servida em `/evento/agente-ia` SEM barra final
    // (`html_handling = drop-trailing-slash` redireciona `/evento/agente-ia/`
    // pra cá). Sem a barra, o navegador resolve `href="styles.css"` como
    // `/evento/styles.css` — 404, e a página abria sem estilo, sem script e
    // sem o botão de compra. Todo href/src local precisa ser absoluto.
    // (`url(assets/...)` dentro do styles.css pode continuar relativo: ele
    // resolve contra o próprio CSS, que mora em /evento/agente-ia/.)
    const html = readFileSync(resolve(PAGE_DIR, "index.html"), "utf8");
    const relativos = [...html.matchAll(/(?:href|src)="([^"]*)"/g)]
      .map((m) => m[1])
      .filter((v) => !/^(?:https?:|mailto:|tel:|#|\/|data:)/i.test(v));
    assert.deepEqual(relativos, [], `referências relativas: ${relativos.join(", ")}`);
  });

  it("config.js declara EVENT_CHECKOUT_URL como HTTPS (contrato que script.js espera)", () => {
    const p = resolve(PAGE_DIR, "config.js");
    assert.ok(existsSync(p), "config.js ausente");
    const js = readFileSync(p, "utf8");
    assert.match(js, /window\.EVENT_CHECKOUT_URL\s*=\s*"https:\/\//);
  });

  it("styles.css e script.js existem", () => {
    assert.ok(existsSync(resolve(PAGE_DIR, "styles.css")));
    assert.ok(existsSync(resolve(PAGE_DIR, "script.js")));
  });

  it("todas as imagens referenciadas em styles.css/index.html (assets/*.png) existem em disco", () => {
    const html = readFileSync(resolve(PAGE_DIR, "index.html"), "utf8");
    const css = readFileSync(resolve(PAGE_DIR, "styles.css"), "utf8");
    const refs = new Set<string>();
    for (const m of (html + css).matchAll(/assets\/[a-z0-9_-]+\.png/gi)) refs.add(m[0]);
    assert.ok(refs.size > 0, "nenhuma referência assets/*.png encontrada — regex desatualizada?");
    for (const ref of refs) {
      assert.ok(existsSync(resolve(PAGE_DIR, ref)), `asset referenciado ausente: ${ref}`);
    }
  });
});
