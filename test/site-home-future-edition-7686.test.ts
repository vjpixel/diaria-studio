/**
 * #7686 — a home não pode anunciar edição que ainda não foi enviada.
 *
 * O BUG: o Stage 6 (§6d-site) publica `/p/{slug}`, adiciona a entrada no
 * `sitemap.xml` e regenera a home NO MESMO COMMIT, na noite anterior ao
 * envio. O PR era mergeado ~21h BRT, `deploy-site.yml` disparava, e
 * `https://diar.ia.br/` passava a listar a edição de amanhã ~9h antes de
 * qualquer assinante recebê-la — incoerência visível justamente pra quem
 * chega pela campanha paga (#7575), que aponta pra home.
 *
 * A CORREÇÃO tem duas metades; esta suíte cobre a primeira (o filtro pelo
 * `<lastmod>`). A segunda — o workflow das 06:00 que faz a edição APARECER
 * na hora — é infraestrutura de CI, coberta pelo guard no fim do arquivo.
 *
 * `todayBrt` é injetado em todos os casos: um teste que dependesse do
 * relógio real passaria hoje e quebraria amanhã.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildHomeFeed, brtDateString } from "../scripts/lib/site-home-page.ts";
import { buildSitemapXml } from "../scripts/lib/site-archive-pages.ts";

function pageHtml(title: string): string {
  return `<!doctype html><html><head><title>${title}</title><meta name="description" content="desc de ${title}"></head><body><p>corpo da edição ${title}</p></body></html>`;
}

/** Reader que serve a mesma página pra qualquer slug pedido. */
const anyPage = (slug: string) => pageHtml(slug);

describe("#7686 buildHomeFeed — edição com envio no futuro fica fora da home", () => {
  it("CENÁRIO REAL: Stage 6 da noite de 08/09 publica a edição de 09/09 — a home de 08/09 não a mostra", () => {
    const sitemapXml = buildSitemapXml([
      { loc: "https://diar.ia.br/p/edicao-de-amanha", lastmod: "2026-09-09" },
      { loc: "https://diar.ia.br/p/edicao-de-hoje", lastmod: "2026-09-08" },
      { loc: "https://diar.ia.br/p/edicao-de-ontem", lastmod: "2026-09-07" },
    ]);

    const feed = buildHomeFeed(sitemapXml, anyPage, 10, { todayBrt: "2026-09-08" });

    assert.deepEqual(
      feed.map((e) => e.slug),
      ["edicao-de-hoje", "edicao-de-ontem"],
      "REGRESSÃO: a edição de amanhã voltou a aparecer na home antes de ser enviada",
    );
  });

  it("às 06:00 BRT do dia do envio a MESMA entrada passa a aparecer (é o que o regen-home.yml colhe)", () => {
    const sitemapXml = buildSitemapXml([
      { loc: "https://diar.ia.br/p/edicao-de-amanha", lastmod: "2026-09-09" },
      { loc: "https://diar.ia.br/p/edicao-de-hoje", lastmod: "2026-09-08" },
    ]);

    const feed = buildHomeFeed(sitemapXml, anyPage, 10, { todayBrt: "2026-09-09" });

    assert.equal(
      feed[0]?.slug,
      "edicao-de-amanha",
      "lastmod IGUAL a hoje precisa entrar — o corte é 'estritamente futuro', senão a edição nunca apareceria",
    );
    assert.equal(feed.length, 2);
  });

  it("entrada futura NÃO consome vaga do limite — publicar amanhã não pode encolher a home de hoje", () => {
    const sitemapXml = buildSitemapXml([
      { loc: "https://diar.ia.br/p/edicao-de-amanha", lastmod: "2026-09-09" },
      { loc: "https://diar.ia.br/p/edicao-de-hoje", lastmod: "2026-09-08" },
      { loc: "https://diar.ia.br/p/edicao-de-ontem", lastmod: "2026-09-07" },
    ]);

    const feed = buildHomeFeed(sitemapXml, anyPage, 2, { todayBrt: "2026-09-08" });

    assert.deepEqual(
      feed.map((e) => e.slug),
      ["edicao-de-hoje", "edicao-de-ontem"],
      "REGRESSÃO: a entrada futura foi descartada DEPOIS do corte por limit e roubou um card",
    );
  });

  it("entrada sem lastmod continua entrando (acervo legado / caminho Kit pré-#7437)", () => {
    const sitemapXml = buildSitemapXml([
      { loc: "https://diar.ia.br/p/sem-data" },
      { loc: "https://diar.ia.br/p/edicao-de-hoje", lastmod: "2026-09-08" },
    ]);

    const feed = buildHomeFeed(sitemapXml, anyPage, 10, { todayBrt: "2026-09-08" });

    assert.ok(
      feed.some((e) => e.slug === "sem-data"),
      "sem data não há como julgar 'já saiu?' — esconder silenciaria acervo antigo",
    );
  });

  it("acervo inteiro no passado passa intacto — o filtro não pode encolher a home em dia normal", () => {
    const sitemapXml = buildSitemapXml([
      { loc: "https://diar.ia.br/p/a", lastmod: "2026-08-26" },
      { loc: "https://diar.ia.br/p/b", lastmod: "2026-08-25" },
      { loc: "https://diar.ia.br/p/c", lastmod: "2026-08-24" },
    ]);

    const feed = buildHomeFeed(sitemapXml, anyPage, 10, { todayBrt: "2026-09-08" });

    assert.equal(feed.length, 3);
  });
});

describe("#7686 brtDateString — 'hoje' é o dia civil em BRT, nunca em UTC", () => {
  it("22:00 BRT de 08/09 (= 01:00 UTC de 09/09) ainda é 2026-09-08", () => {
    // Este é o horário em que o Stage 6 de fato roda. Se "hoje" viesse de
    // `toISOString()` o resultado seria 2026-09-09 e o filtro deixaria a
    // edição de amanhã passar — exatamente o bug que ele existe pra impedir.
    assert.equal(brtDateString(new Date("2026-09-09T01:00:00.000Z")), "2026-09-08");
  });

  it("06:00 BRT de 09/09 (= 09:00 UTC, o horário do cron) já é 2026-09-09", () => {
    assert.equal(brtDateString(new Date("2026-09-09T09:00:00.000Z")), "2026-09-09");
  });
});

describe("#7686 guard — o workflow que regenera a home existe e roda no horário do envio", () => {
  it("regen-home.yml tem cron 09:00 UTC (06:00 BRT) e faz deploy do worker site", async () => {
    const { readFileSync } = await import("node:fs");
    const yaml = readFileSync(".github/workflows/regen-home.yml", "utf8");

    assert.match(
      yaml,
      /cron:\s*'0 9 \* \* \*'/,
      "o horário das 06:00 BRT é a decisão do editor nesta issue — mudar o cron sem mudar a doc do Stage 6 volta a dessincronizar home e envio",
    );
    assert.match(
      yaml,
      /worker:\s*site/,
      "sem o job de deploy o merge entra em master e produção segue servindo a home antiga (push com GITHUB_TOKEN não dispara deploy-site.yml)",
    );
  });
});
