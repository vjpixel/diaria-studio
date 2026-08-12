/**
 * test/reader-facing-no-legacy-poll-domain-3904.test.ts (#3904, generalizado #5099 item 3)
 *
 * Guard anti-regressão: nenhuma superfície reader-facing (link NOVO que o
 * leitor vê/clica) deve emitir um host legado — QUALQUER `*.diaria.workers.dev`
 * (não só `poll.`, ver histórico abaixo) ou `diaria.beehiiv.com`. O domínio
 * de marca correspondente em `diar.ia.br` (`eia.`/`cursos.`/`livros.`/
 * `arquivo.`) é o destino canônico pra link NOVO desde as ondas #3698/#3701/
 * #3904/#4059. Os hosts `*.diaria.workers.dev` seguem ativos
 * (`workers_dev = true` nos respectivos `wrangler.toml`) só por compat de
 * links já embutidos em edições enviadas ANTES de cada onda — NUNCA como
 * destino de link novo.
 *
 * Histórico do escopo: nasceu (#3904) cobrindo só `poll.diaria.workers.dev`
 * — 4 superfícies. Generalizado (#5099 item 3) pra QUALQUER
 * `*.diaria.workers.dev` + `diaria.beehiiv.com` (a auditoria do #5099 achou
 * vazamento real de `cursos.`/`livros.diaria.workers.dev` e
 * `diaria.beehiiv.com` na home — fora do escopo de código deste repo, mas
 * confirma que o guard de #3904 era estreito demais só pro subdomínio
 * `poll.`), e a superfície ganhou `hub-page.ts` (renderizado via os hubs
 * REAIS de `HUB_LOADERS`, mesmo padrão de `test/hub-page-drift.test.ts`).
 *
 * Deliberadamente um teste de COMPORTAMENTO (render de verdade, com fixture
 * mínima) em vez de um grep estático do código-fonte: várias partes legítimas
 * do código (`newsletter-parse.ts` normalizeKnownUrl, `FOOTER_DOMAINS` em
 * canonical-urls.ts, testes de back-compat, `ALLOWED_BEEHIIV_PLATFORM_HOSTS`
 * em `beehiiv-home-meta-check.ts`) precisam continuar CITANDO os hosts
 * legados — pra reconhecer/aceitar/allowlistar links legados, não pra
 * emiti-los. Um grep bruto por substring geraria falso-positivo nesses
 * pontos legítimos. Este teste cobre as 5 superfícies reader-facing hoje
 * conhecidas:
 *
 *   1. Newsletter diária (`renderEIA`/`renderHTML`, newsletter-render-html.ts)
 *      — link de VOTO embutido no e-mail (merge-tag `{{email}}`).
 *   2. Digest mensal Clarice (`renderEia`, monthly-render.ts) — idem, brand=clarice.
 *   3. Rodapé cruzado Cursos/Livros/É IA? (`renderCuradoriaFooter`, curadoria-page.ts).
 *   4. `platform.config.json` (`poll.worker_url`) — base usada por scripts que
 *      geram/consultam links do jogo (build-poll-eia-data, close-poll, etc).
 *   5. Hubs temáticos (`renderHubPage`, `hub-page.ts`) — todos os slugs de
 *      `HUB_LOADERS`, com dado REAL (não fixture sintética — os hubs já são
 *      commitados e determinísticos).
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
import { renderHubPage } from "../scripts/lib/shared/hub-page.ts";
import { HUB_LOADERS, loadHubContent } from "../scripts/build-hub-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Casa QUALQUER `{subdomínio}.diaria.workers.dev` (não só `poll.`) ou
 * `diaria.beehiiv.com` — generalização do #5099 item 3 sobre o `LEGACY_DOMAIN`
 * literal original de #3904. */
const LEGACY_HOST_RE = /[a-z0-9-]+\.diaria\.workers\.dev|diaria\.beehiiv\.com/i;

/** Mensagem de asserção padronizada — reusa o nome do host casado (se houver)
 * pra facilitar debug, sem precisar de um `LEGACY_DOMAIN` fixo por chamada. */
function assertNoLegacyHost(haystack: string, surface: string): void {
  const match = haystack.match(LEGACY_HOST_RE);
  assert.equal(
    match,
    null,
    `${surface} emitiu host legado "${match?.[0]}" — regressão de #3904/#5099`,
  );
}

const EIA_FIXTURE: EIA = {
  credit: "Foto: Gerado com Gemini.",
  imageA: "01-eia-A.jpg",
  imageB: "01-eia-B.jpg",
  edition: "260999",
};

describe("reader-facing NÃO emite hosts legados *.diaria.workers.dev / diaria.beehiiv.com (#3904, #5099)", () => {
  it("DIARIA_EIA_URL (fonte única) é o domínio de marca, não um host legado", () => {
    assert.equal(DIARIA_EIA_URL, "https://eia.diar.ia.br");
    assertNoLegacyHost(DIARIA_EIA_URL, "DIARIA_EIA_URL");
  });

  it("newsletter diária: renderEIA (link de VOTO) não emite host legado", () => {
    const html = renderEIA(EIA_FIXTURE);
    assert.ok(html.includes("email={{email}}&edition="), "sanity: vote link deve existir (merge-tag de e-mail cru, #4581)");
    assertNoLegacyHost(html, "renderEIA");
    assert.ok(html.includes(DIARIA_EIA_URL), "renderEIA deveria emitir o domínio de marca");
  });

  it("newsletter diária: renderHTML (composição completa) não emite host legado", () => {
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
    assertNoLegacyHost(html, "renderHTML");
  });

  it("digest mensal (Clarice): renderEia (link de VOTO brand=clarice) não emite host legado", () => {
    const originalEnv = process.env.POLL_WORKER_URL;
    delete process.env.POLL_WORKER_URL; // força o default (não uma env var de outro teste vazando)
    try {
      const html = renderMonthlyEia("[...]", "2605", "img-a.jpg", "img-b.jpg");
      assert.ok(html.includes("brand=clarice"), "sanity: vote link deve existir");
      assertNoLegacyHost(html, "renderEia (mensal)");
      assert.ok(html.includes(DIARIA_EIA_URL), "renderEia (mensal) deveria emitir o domínio de marca");
    } finally {
      if (originalEnv === undefined) delete process.env.POLL_WORKER_URL;
      else process.env.POLL_WORKER_URL = originalEnv;
    }
  });

  it("rodapé Cursos/Livros (CURADORIA_NAV_LINKS + renderCuradoriaFooter) não emite host legado", () => {
    const eiaLink = CURADORIA_NAV_LINKS.find((l) => l.label === "É IA?");
    assert.ok(eiaLink, "link 'É IA?' ausente da nav cruzada");
    assertNoLegacyHost(eiaLink!.url, "CURADORIA_NAV_LINKS");
    assert.ok(eiaLink!.url.startsWith(DIARIA_EIA_URL), "CURADORIA_NAV_LINKS deveria apontar pro domínio de marca");

    const footerHtml = renderCuradoriaFooter("crédito");
    assertNoLegacyHost(footerHtml, "renderCuradoriaFooter");
  });

  it("workers/cursos e workers/livros public/index.html (build artifacts) não emitem host legado no rodapé", () => {
    // #3904: os HTMLs estáticos servidos por workers/cursos e workers/livros
    // são build artifacts commitados (build-cursos-page.ts/build-livros-page.ts
    // --out) — regenerar via `npx tsx scripts/build-{cursos,livros}-page.ts
    // --out workers/{cursos,livros}/public/index.html` sempre que
    // CURADORIA_NAV_LINKS mudar, senão o arquivo servido em produção diverge
    // silenciosamente do que os testes acima cobrem (só a função, não o artifact).
    for (const worker of ["cursos", "livros"] as const) {
      const html = readFileSync(resolve(ROOT, `workers/${worker}/public/index.html`), "utf8");
      assertNoLegacyHost(html, `workers/${worker}/public/index.html`);
    }
  });

  it("platform.config.json: poll.worker_url é o domínio de marca, não um host legado", () => {
    const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
    const url = cfg?.poll?.worker_url;
    assert.equal(typeof url, "string");
    assertNoLegacyHost(String(url), "platform.config.json poll.worker_url");
    assert.equal(url, DIARIA_EIA_URL);
  });

  it("hubs temáticos (renderHubPage, hub-page.ts) — nenhum hub REAL de HUB_LOADERS emite host legado (#5099 item 3)", () => {
    const slugs = Object.keys(HUB_LOADERS);
    assert.ok(slugs.length > 0, "sanity: HUB_LOADERS não pode estar vazio");
    for (const slug of slugs) {
      const hub = loadHubContent(slug);
      const html = renderHubPage(hub);
      assertNoLegacyHost(html, `renderHubPage(${slug})`);
    }
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
