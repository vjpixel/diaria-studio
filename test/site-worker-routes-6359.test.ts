/**
 * test/site-worker-routes-6359.test.ts (#6359, pré-requisito duro do #467)
 *
 * `workers/site` é um Worker de static assets puro ([assets], sem `main` —
 * ver `workers/site/wrangler.toml`), então não há `fetch` handler pra
 * invocar em teste com uma Request sintética (mesmo idioma de
 * `test/curadoria-sitemap-robots.test.ts` pros Workers `cursos`/`livros`).
 * A cobertura aqui é sobre o CONTEÚDO COMMITTED de `public/` — o "smoke
 * test de rotas" que a issue pede é, na prática, garantir que cada rota que
 * o apex serve hoje (medição ao vivo 26/08/2026, comentário da issue) tem
 * um arquivo/regra correspondente aqui, pra nenhuma delas regredir em
 * silêncio antes do cutover de DNS (#467).
 *
 * Rotas cobertas (as 2 que a medição ao vivo confirmou como buraco real —
 * `/forms/*` saiu de escopo, não existe no apex hoje):
 *   - `/`            → public/index.html (título + description = tagline oficial)
 *   - `/subscribe`   → public/_redirects (302 pro perfil hospedado da Kit,
 *                      única superfície de cadastro PÚBLICA que a conta Kit
 *                      já expõe — ver comentário do próprio `_redirects`)
 *   - `/robots.txt` e `/sitemap.xml` — já serviam certo (#467); guard de
 *     regressão pedido explicitamente pela issue #6359 ("há teste? se não
 *     houver, considere adicionar um que trave as duas").
 *   - `/p/{slug}` de exemplo — já coberto por `test/gen-archive-pages.test.ts`
 *     (miolo puro) e `test/site-worker-html-handling-467.test.ts` (routing
 *     sem barra); aqui só confirma que o acervo committed tem ao menos 1
 *     página gerada com os metadados esperados, fechando o inventário de
 *     rotas desta issue num só arquivo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSitemap } from "../scripts/lib/fetch-sitemap.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = resolve(ROOT, "workers", "site", "public");

/**
 * Parser mínimo do formato Netlify-like que o Cloudflare `_redirects`
 * documenta (`[source] [destination] [code?]`, comentário com `#`, 1 regra
 * por linha) — só o suficiente pra este teste, não um parser geral.
 * https://developers.cloudflare.com/workers/static-assets/redirects/
 */
function parseRedirectsFile(content: string): Array<{ source: string; destination: string; code: number }> {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const parts = line.split(/\s+/);
      const [source, destination, codeRaw] = parts;
      return { source, destination, code: codeRaw ? Number(codeRaw) : 302 };
    });
}

describe("workers/site/public — / (#6359)", () => {
  const indexPath = resolve(PUBLIC_DIR, "index.html");

  it("index.html existe", () => {
    assert.ok(existsSync(indexPath), `${indexPath} ausente — apex ficaria 404 em / pós-cutover`);
  });

  it("declara <title>diar.ia.br</title> — mesmo title medido ao vivo no apex hoje (comentário da issue)", () => {
    const html = readFileSync(indexPath, "utf8");
    assert.match(html, /<title>diar\.ia\.br<\/title>/);
  });

  it("meta description é a tagline oficial — mesma medida ao vivo no apex hoje", () => {
    const html = readFileSync(indexPath, "utf8");
    assert.match(
      html,
      /<meta name="description" content="5 minutos diários pra se manter atualizado e usar melhor as IAs\.">/,
    );
  });

  it("tem link pra /subscribe (CTA de assinatura na home)", () => {
    const html = readFileSync(indexPath, "utf8");
    assert.match(html, /href="\/subscribe"/);
  });
});

describe("workers/site/public/_redirects — /subscribe (#6359)", () => {
  const redirectsPath = resolve(PUBLIC_DIR, "_redirects");

  it("_redirects existe", () => {
    assert.ok(existsSync(redirectsPath), `${redirectsPath} ausente — /subscribe ficaria 404 pós-cutover`);
  });

  it("redireciona /subscribe pra um destino https:// com status de redirect válido (300-399)", () => {
    const rules = parseRedirectsFile(readFileSync(redirectsPath, "utf8"));
    const rule = rules.find((r) => r.source === "/subscribe");
    assert.ok(rule, "nenhuma regra /subscribe em _redirects");
    assert.match(rule!.destination, /^https:\/\//, "destino deveria ser uma URL absoluta https://");
    assert.ok(
      rule!.code >= 300 && rule!.code < 400,
      `code ${rule!.code} não é um status de redirect (300-399)`,
    );
  });

  it("não redireciona pra um Worker/host nosso indisponível hoje — destino é o domínio da Kit (backend ativo, platform.config.json)", () => {
    const rules = parseRedirectsFile(readFileSync(redirectsPath, "utf8"));
    const rule = rules.find((r) => r.source === "/subscribe");
    assert.match(rule!.destination, /kit\.com/, "destino esperado é a conta Kit — backend ativo desde o switchover #6114");
  });
});

describe("workers/site/public — robots.txt + sitemap.xml (guard de regressão, #6359)", () => {
  const robotsPath = resolve(PUBLIC_DIR, "robots.txt");
  const sitemapPath = resolve(PUBLIC_DIR, "sitemap.xml");

  it("robots.txt existe, permite crawling geral e declara Sitemap: do próprio host", () => {
    assert.ok(existsSync(robotsPath), `${robotsPath} ausente`);
    const body = readFileSync(robotsPath, "utf8");
    assert.match(body, /User-agent: \*/);
    assert.match(body, /Allow: \//);
    assert.match(body, /Sitemap: https:\/\/diar\.ia\.br\/sitemap\.xml/);
  });

  it("sitemap.xml existe e é XML válido com ao menos 1 <loc> de /p/{slug}", () => {
    assert.ok(existsSync(sitemapPath), `${sitemapPath} ausente`);
    const xml = readFileSync(sitemapPath, "utf8");
    const entries = parseSitemap(xml);
    assert.ok(entries.length > 0, "sitemap.xml não tem nenhuma <url>");
    assert.ok(
      entries.every((e) => /^https:\/\/diar\.ia\.br\/p\/[^/]+$/.test(e.loc)),
      "toda entrada do sitemap deveria ser https://diar.ia.br/p/{slug}",
    );
  });
});

describe("workers/site/public/p/{slug} — amostra do acervo (#6359)", () => {
  it("existe ao menos 1 página gerada com <html lang=\"pt-BR\"> e <link rel=\"canonical\">", () => {
    const pDir = resolve(PUBLIC_DIR, "p");
    assert.ok(existsSync(pDir), `${pDir} ausente`);
    const slugs = readdirSync(pDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    assert.ok(slugs.length > 0, "nenhum slug gerado em public/p/");
    const samplePath = resolve(pDir, slugs[0].name, "index.html");
    assert.ok(existsSync(samplePath), `${samplePath} ausente`);
    const html = readFileSync(samplePath, "utf8");
    assert.match(html, /<html lang="pt-BR"/);
    assert.match(html, /<link rel="canonical" href="https:\/\/diar\.ia\.br\/p\//);
  });
});
