/**
 * test/site-worker-guia-agente-ia.test.ts
 *
 * `diar.ia.br/guia/agente-ia` — página de vendas do guia em PDF "Seu primeiro
 * agente de IA em uma tarde, sem programar" (R$ 27, Hotmart 8689044). Asset
 * ESTÁTICO em `workers/site/public/guia/agente-ia/`, sem rota no Worker (cai no
 * `env.ASSETS.fetch` padrão, como `/evento/agente-ia`).
 *
 * Guard de regressão dos arquivos commitados, no mesmo padrão de
 * `site-worker-evento-agente-ia-8563.test.ts`: medição idêntica à da página do
 * evento, checkout com `checkoutMode=10` (sem ele a Hotmart esconde o order
 * bump), caminhos absolutos e regras de copy da casa (#9721: nada de seta).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { visitorIdBootstrapJs } from "../scripts/lib/shared/visitor-id.ts";
import { metaFbcBootstrapJs } from "../scripts/lib/shared/meta-fbc-bootstrap.ts";
import { GTM_CONTAINER_ID, renderAnalyticsHead } from "../scripts/lib/shared/seo-meta.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE_DIR = resolve(ROOT, "workers", "site", "public", "guia", "agente-ia");
const CHECKOUT = "https://pay.hotmart.com/A107949130U?checkoutMode=10";

const html = readFileSync(resolve(PAGE_DIR, "index.html"), "utf8");
const css = readFileSync(resolve(PAGE_DIR, "styles.css"), "utf8");
const js = readFileSync(resolve(PAGE_DIR, "script.js"), "utf8");

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("public/guia/agente-ia — página de vendas do guia", () => {
  it("referencia os próprios arquivos por caminho absoluto (a página é servida sem barra final)", () => {
    assert.match(html, /href="\/guia\/agente-ia\/styles\.css"/);
    assert.match(html, /src="\/guia\/agente-ia\/script\.js"/);
    const relativos = [...html.matchAll(/(?:href|src)="([^"]*)"/g)]
      .map((m) => m[1])
      .filter((val) => !/^(?:https?:|mailto:|tel:|#|\/|data:)/i.test(val));
    assert.deepEqual(relativos, [], `referências relativas: ${relativos.join(", ")}`);
  });

  it("bootstraps _dia_vid e _fbc idênticos aos helpers, GTM uma vez depois deles e um único init/PageView do pixel", () => {
    assert.match(html, new RegExp(`<script>${escapeRe(visitorIdBootstrapJs())}</script>`));
    assert.match(html, new RegExp(`<script>${escapeRe(metaFbcBootstrapJs())}</script>`));
    const loader = renderAnalyticsHead().match(/<script>\(function\(w,d,s,l,i\)[\s\S]*?<\/script>/)?.[0];
    assert.ok(loader && loader.includes(`'${GTM_CONTAINER_ID}'`));
    assert.equal(countOccurrences(html, loader), 1);
    assert.ok(html.indexOf(loader) > html.indexOf(`<script>${visitorIdBootstrapJs()}</script>`));
    assert.match(html, /fbq\('init', '1285191740325112', \{ external_id: window\.__DIA_VID__ \}\);/);
    assert.equal(countOccurrences(html, "fbq('init', '"), 1);
    assert.equal(countOccurrences(html, "fbq('track', 'PageView')"), 1);
  });

  it("FAQ: quem usar o Claude Code é avisado de que a imagem é feita à parte (o guia usa o gerador de imagens do Codex)", () => {
    assert.ok(html.includes("Se preferir, você também pode usar o Claude Code, criando a imagem à parte."));
  });

  it("pixel da Meta só dispara em diar.ia.br (teste local não entra no dataset)", () => {
    const m = html.match(/<!-- Meta Pixel[\s\S]*?<script>([\s\S]*?)<\/script>/);
    assert.ok(m, "bloco do pixel não encontrado");
    assert.ok(m[1].includes(String.raw`if (/(^|\.)diar\.ia\.br$/.test(window.location.hostname)) {`), "pixel sem a condição de domínio");
    assert.match(m[1], /fbq\('track', 'PageView'\);\s*\}\s*$/);
  });

  it("botões de compra apontam para o checkout com checkoutMode=10, e só a oferta e o CTA final compram", () => {
    const links = [...html.matchAll(/<a class="[^"]*checkout-link[^"]*" href="([^"]+)" data-posicao="([^"]+)"/g)];
    assert.deepEqual(links.map((m) => m[2]).sort(), ["final", "oferta"]);
    for (const m of links) assert.equal(m[1], CHECKOUT);
    assert.ok(js.includes(`"${CHECKOUT}"`), "script.js usa outra URL de checkout");
    assert.equal(new URL(CHECKOUT).searchParams.get("checkoutMode"), "10");
  });

  it("#8982: o clique comum segura a navegação antes de ir ao checkout (senão o fbq é cancelado e o clique some)", () => {
    assert.match(js, /ev\.preventDefault\(\)/);
    assert.match(js, /setTimeout\(\(\) => \{\s*window\.location\.href = link\.href;\s*\}, NAV_DELAY_MS\)/);
    assert.match(js, /const NAV_DELAY_MS = 300;/);
  });

  it("não depende de arquivos da página do evento (que pode ser limpa depois de 17/10)", () => {
    assert.doesNotMatch(html, /\/evento\/agente-ia\//);
    assert.doesNotMatch(css, /\/evento\/agente-ia\//);
  });

  it("sem botão de compra na primeira dobra e botão flutuante só rola até a oferta", () => {
    const hero = html.slice(html.indexOf('<section class="hero"'), html.indexOf("</section>"));
    assert.doesNotMatch(hero, /checkout-link|class="button/);
    assert.match(html, /<a class="float-cta" href="#oferta"[^>]*hidden>/);
    assert.match(html, /id="oferta"/);
  });

  it("copy segue as regras da casa: sem seta (#9721), sem 'critério' e com o nome do produto na grafia da Hotmart", () => {
    const visible = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<!--[\s\S]*?-->/g, "");
    assert.doesNotMatch(visible, /→|&rarr;/);
    assert.doesNotMatch(visible, /crit[ée]rio/i);
    assert.match(html, /<title>Seu primeiro agente de IA em uma tarde, sem programar<\/title>/);
  });

  it("descreve o passo 5 do guia atual: agendamento no Buffer com a imagem, não rascunho sem imagem", () => {
    assert.ok(html.includes("Passo 5 | Agende os posts no Buffer, com a imagem (opcional)"));
    assert.ok(html.includes("agendamento opcional dos posts no Buffer, com a imagem"));
    assert.doesNotMatch(html, /Leve os posts ao Buffer|integração opcional com o Buffer/);
  });

  it("todas as imagens locais referenciadas existem em disco", () => {
    const refs = new Set<string>();
    for (const m of [html, css].join("\n").matchAll(/\/(guia|evento)\/agente-ia\/assets\/[a-z0-9_-]+\.(?:png|webp|svg)/gi)) refs.add(m[0]);
    assert.ok(refs.size > 0);
    for (const ref of refs) {
      assert.ok(existsSync(resolve(ROOT, "workers", "site", "public", `.${ref}`)), `asset ausente: ${ref}`);
    }
  });
});
