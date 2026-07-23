/**
 * test/reader-facing-no-legacy-poll-domain-3904.test.ts (#3904)
 *
 * Guard anti-regressão: nenhuma superfície reader-facing (link NOVO que o
 * leitor vê/clica) deve emitir `poll.diaria.workers.dev` — o domínio de marca
 * `eia.diar.ia.br` (Workers Custom Domain, mesmo worker `poll`) é o destino
 * canônico desde #3904. `poll.diaria.workers.dev` segue ativo (`workers_dev =
 * true` em `workers/poll/wrangler.toml`) só por compat de links de VOTO já
 * embutidos em edições enviadas ANTES deste PR — NUNCA como destino de link
 * novo.
 *
 * Deliberadamente um teste de COMPORTAMENTO (render de verdade, com fixture
 * mínima) em vez de um grep estático do código-fonte: várias partes legítimas
 * do código (`newsletter-parse.ts` normalizeKnownUrl, `FOOTER_DOMAINS` em
 * canonical-urls.ts, testes de back-compat) precisam continuar CITANDO o
 * literal `poll.diaria.workers.dev` — pra reconhecer/aceitar/allowlistar links
 * legados, não pra emiti-los. Um grep bruto por substring geraria falso-
 * positivo nesses pontos legítimos. Este teste cobre exatamente as 4
 * superfícies reader-facing tocadas por #3904:
 *
 *   1. Newsletter diária (`renderEIA`/`renderHTML`, newsletter-render-html.ts)
 *      — link de VOTO embutido no e-mail (merge-tag `{{email}}`).
 *   2. Digest mensal Clarice (`renderEia`, monthly-render.ts) — idem, brand=clarice.
 *   3. Rodapé cruzado Cursos/Livros/É IA? (`renderCuradoriaFooter`, curadoria-page.ts).
 *   4. `platform.config.json` (`poll.worker_url`) — base usada por scripts que
 *      geram/consultam links do jogo (build-poll-eia-data, close-poll, etc).
 *
 * Análogo ao brand-gate de #3615 (comportamento renderizado, não grep de
 * arquivo-fonte) e ao princípio de #2747 (lib-boundary.test.ts) de travar uma
 * convenção arquitetural com um teste dedicado, de baixo custo de manutenção,
 * na fonte única do bug em vez de espalhar a asserção pelos testes normais de
 * cada arquivo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { renderHTML, renderEIA } from "../scripts/lib/newsletter-render-html.ts";
import type { NewsletterContent, EIA } from "../scripts/lib/newsletter-parse.ts";
import { renderEia as renderMonthlyEia } from "../scripts/lib/mensal/monthly-render.ts";
import { CURADORIA_NAV_LINKS, renderCuradoriaFooter } from "../scripts/lib/shared/curadoria-page.ts";
import { DIARIA_EIA_URL } from "../scripts/lib/canonical-urls.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEGACY_DOMAIN = "poll.diaria.workers.dev";

const EIA_FIXTURE: EIA = {
  credit: "Foto: Gerado com Gemini.",
  imageA: "01-eia-A.jpg",
  imageB: "01-eia-B.jpg",
  edition: "260999",
};

describe("reader-facing NÃO emite o domínio legado do worker poll (#3904)", () => {
  it("DIARIA_EIA_URL (fonte única) é o domínio de marca, não o legado", () => {
    assert.equal(DIARIA_EIA_URL, "https://eia.diar.ia.br");
    assert.ok(!DIARIA_EIA_URL.includes(LEGACY_DOMAIN));
  });

  it("newsletter diária: renderEIA (link de VOTO) não emite o domínio legado", () => {
    const html = renderEIA(EIA_FIXTURE);
    assert.ok(html.includes("{{email}}"), "sanity: vote link deve existir (merge-tag)");
    assert.ok(!html.includes(LEGACY_DOMAIN), `renderEIA emitiu ${LEGACY_DOMAIN} — regressão de #3904`);
    assert.ok(html.includes(DIARIA_EIA_URL), "renderEIA deveria emitir o domínio de marca");
  });

  it("newsletter diária: renderHTML (composição completa) não emite o domínio legado", () => {
    const fixture: NewsletterContent = {
      title: "t", subtitle: "s", coverImage: "04-d1-2x1.jpg",
      destaques: [{
        n: 1, category: "PESQUISA", title: "t1",
        body: "corpo", why: "importa", url: "https://example.com/a",
        emoji: "🧪", imageFile: "04-d1-2x1.jpg",
      }],
      eia: EIA_FIXTURE,
      sections: [],
      encerrar: "fim",
    };
    const html = renderHTML(fixture);
    assert.ok(!html.includes(LEGACY_DOMAIN), `renderHTML emitiu ${LEGACY_DOMAIN} — regressão de #3904`);
  });

  it("digest mensal (Clarice): renderEia (link de VOTO brand=clarice) não emite o domínio legado", () => {
    const originalEnv = process.env.POLL_WORKER_URL;
    delete process.env.POLL_WORKER_URL; // força o default (não uma env var de outro teste vazando)
    try {
      const html = renderMonthlyEia("[...]", "2605", "img-a.jpg", "img-b.jpg");
      assert.ok(html.includes("brand=clarice"), "sanity: vote link deve existir");
      assert.ok(!html.includes(LEGACY_DOMAIN), `renderEia (mensal) emitiu ${LEGACY_DOMAIN} — regressão de #3904`);
      assert.ok(html.includes(DIARIA_EIA_URL), "renderEia (mensal) deveria emitir o domínio de marca");
    } finally {
      if (originalEnv === undefined) delete process.env.POLL_WORKER_URL;
      else process.env.POLL_WORKER_URL = originalEnv;
    }
  });

  it("rodapé Cursos/Livros (CURADORIA_NAV_LINKS + renderCuradoriaFooter) não emite o domínio legado", () => {
    const eiaLink = CURADORIA_NAV_LINKS.find((l) => l.label === "É IA?");
    assert.ok(eiaLink, "link 'É IA?' ausente da nav cruzada");
    assert.ok(!eiaLink!.url.includes(LEGACY_DOMAIN), `CURADORIA_NAV_LINKS emitiu ${LEGACY_DOMAIN} — regressão de #3904`);
    assert.ok(eiaLink!.url.startsWith(DIARIA_EIA_URL), "CURADORIA_NAV_LINKS deveria apontar pro domínio de marca");

    const footerHtml = renderCuradoriaFooter("crédito");
    assert.ok(!footerHtml.includes(LEGACY_DOMAIN), `renderCuradoriaFooter emitiu ${LEGACY_DOMAIN} — regressão de #3904`);
  });

  it("workers/cursos e workers/livros public/index.html (build artifacts) não emitem o domínio legado no rodapé", () => {
    // #3904: os HTMLs estáticos servidos por workers/cursos e workers/livros
    // são build artifacts commitados (build-cursos-page.ts/build-livros-page.ts
    // --out) — regenerar via `npx tsx scripts/build-{cursos,livros}-page.ts
    // --out workers/{cursos,livros}/public/index.html` sempre que
    // CURADORIA_NAV_LINKS mudar, senão o arquivo servido em produção diverge
    // silenciosamente do que os testes acima cobrem (só a função, não o artifact).
    for (const worker of ["cursos", "livros"] as const) {
      const html = readFileSync(resolve(ROOT, `workers/${worker}/public/index.html`), "utf8");
      assert.ok(
        !html.includes(LEGACY_DOMAIN),
        `workers/${worker}/public/index.html emitiu ${LEGACY_DOMAIN} — rode ` +
          `'npx tsx scripts/build-${worker}-page.ts --out workers/${worker}/public/index.html'`,
      );
    }
  });

  it("platform.config.json: poll.worker_url é o domínio de marca, não o legado", () => {
    const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
    const url = cfg?.poll?.worker_url;
    assert.equal(typeof url, "string");
    assert.ok(!String(url).includes(LEGACY_DOMAIN), `platform.config.json poll.worker_url ainda é ${LEGACY_DOMAIN} — regressão de #3904`);
    assert.equal(url, DIARIA_EIA_URL);
  });

  it("build-link-ctr: o domínio de marca é tratado como infra própria (não editorial) — mesma classe do #1567 finding G", async () => {
    // Import dinâmico: build-link-ctr.ts não pode ser importado estaticamente
    // sem custo de módulo (lê process.cwd() no top-level) — mesmo padrão de
    // outros testes que importam este arquivo (ver test/build-link-ctr.test.ts).
    const { isEditorial } = await import("../scripts/build-link-ctr.ts");
    assert.equal(
      isEditorial(`${DIARIA_EIA_URL}/vote?email=x@x.com&edition=260722&choice=A`),
      false,
      "link de voto no domínio de marca vazou como 'editorial' no CTR — regressão de #3904",
    );
  });
});
