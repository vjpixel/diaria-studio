import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractHtmlLang,
  extractCanonicalHref,
  extractMetaDescription,
  checkArchivePostPage,
  countSitemapUrls,
  sitemapHasArchivePost,
  checkRobotsTxt,
  evaluateLegacyRedirect,
  renderApexCutoverReportMarkdown,
  allChecksPassed,
  type ApexCutoverReportInput,
} from "../scripts/lib/apex-cutover-verify.ts";

const OK_POST_HTML =
  '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">' +
  '<title>Empresas recontratam quem demitiu por IA</title>' +
  '<meta name="description" content="Empresas recontratam quem demitiu por IA. Infraestrutura trava 1 em cada 3 startups de IA">' +
  '<link rel="canonical" href="https://diar.ia.br/p/empresas-recontratam-quem-demitiu-por-ia">' +
  "</head><body></body></html>";

test("extractHtmlLang lê o atributo lang da tag html", () => {
  assert.equal(extractHtmlLang(OK_POST_HTML), "pt-BR");
  assert.equal(extractHtmlLang('<html lang="en">'), "en");
  assert.equal(extractHtmlLang("<html>"), null);
});

test("extractCanonicalHref lê o href do link canonical", () => {
  assert.equal(
    extractCanonicalHref(OK_POST_HTML),
    "https://diar.ia.br/p/empresas-recontratam-quem-demitiu-por-ia",
  );
  assert.equal(extractCanonicalHref("<html></html>"), null);
});

test("extractMetaDescription lê o content da meta description", () => {
  assert.equal(
    extractMetaDescription(OK_POST_HTML),
    "Empresas recontratam quem demitiu por IA. Infraestrutura trava 1 em cada 3 startups de IA",
  );
  assert.equal(extractMetaDescription("<html></html>"), null);
});

test("checkArchivePostPage: página conforme passa nas 3 checagens", () => {
  const result = checkArchivePostPage(
    OK_POST_HTML,
    "https://diar.ia.br/p/empresas-recontratam-quem-demitiu-por-ia",
  );
  assert.equal(result.langPtBr, true);
  assert.equal(result.selfCanonical, true);
  assert.equal(result.hasMetaDescription, true);
});

test("checkArchivePostPage: lang=en (bug de plataforma da Beehiiv) reprova", () => {
  const html = OK_POST_HTML.replace('lang="pt-BR"', 'lang="en"');
  const result = checkArchivePostPage(html, "https://diar.ia.br/p/x");
  assert.equal(result.langPtBr, false);
});

test("checkArchivePostPage: canonical apontando pro host legado reprova selfCanonical", () => {
  const html = OK_POST_HTML.replace(
    "https://diar.ia.br/p/empresas-recontratam-quem-demitiu-por-ia",
    "https://diaria.beehiiv.com/p/empresas-recontratam-quem-demitiu-por-ia",
  );
  const result = checkArchivePostPage(
    html,
    "https://diar.ia.br/p/empresas-recontratam-quem-demitiu-por-ia",
  );
  assert.equal(result.selfCanonical, false);
  assert.equal(result.canonicalUrl, "https://diaria.beehiiv.com/p/empresas-recontratam-quem-demitiu-por-ia");
});

test("checkArchivePostPage: meta description ausente/vazia reprova", () => {
  const noMeta = OK_POST_HTML.replace(/<meta name="description"[^>]*>/, "");
  assert.equal(checkArchivePostPage(noMeta, "x").hasMetaDescription, false);

  const emptyMeta = OK_POST_HTML.replace(
    /<meta name="description" content="[^"]*">/,
    '<meta name="description" content="">',
  );
  assert.equal(checkArchivePostPage(emptyMeta, "x").hasMetaDescription, false);
});

test("countSitemapUrls conta as tags <url>", () => {
  const xml = `<?xml version="1.0"?><urlset><url><loc>a</loc></url><url><loc>b</loc></url></urlset>`;
  assert.equal(countSitemapUrls(xml), 2);
  assert.equal(countSitemapUrls("<urlset></urlset>"), 0);
});

test("sitemapHasArchivePost acha o slug no sitemap", () => {
  const xml = `<urlset><url><loc>https://diar.ia.br/p/meu-slug</loc></url></urlset>`;
  assert.equal(sitemapHasArchivePost(xml, "meu-slug"), true);
  assert.equal(sitemapHasArchivePost(xml, "outro-slug"), false);
});

test("checkRobotsTxt: política de crawlers de IA liberados", () => {
  const robots =
    "User-agent: *\nContent-Signal: search=yes,ai-train=yes,use=reference\nAllow: /\n\nSitemap: https://diar.ia.br/sitemap.xml\n";
  const result = checkRobotsTxt(robots);
  assert.equal(result.allowsAiCrawlers, true);
  assert.equal(result.declaresSitemap, true);
});

test("checkRobotsTxt: sem Content-Signal ai-train reprova allowsAiCrawlers", () => {
  const robots = "User-agent: *\nDisallow: /\n";
  const result = checkRobotsTxt(robots);
  assert.equal(result.allowsAiCrawlers, false);
  assert.equal(result.declaresSitemap, false);
});

test("evaluateLegacyRedirect: 301 pro host novo é conforme", () => {
  const result = evaluateLegacyRedirect(301, "https://diar.ia.br/p/x", "diar.ia.br");
  assert.equal(result.redirectsToNewHost, true);
});

test("evaluateLegacyRedirect: 200 (ainda serve direto, duplicidade real) reprova", () => {
  const result = evaluateLegacyRedirect(200, null, "diar.ia.br");
  assert.equal(result.redirectsToNewHost, false);
});

test("evaluateLegacyRedirect: redirect pra host errado reprova", () => {
  const result = evaluateLegacyRedirect(301, "https://outro-host.com/p/x", "diar.ia.br");
  assert.equal(result.redirectsToNewHost, false);
});

test("evaluateLegacyRedirect: status null (fetch falhou) não é 'não' — fica null", () => {
  const result = evaluateLegacyRedirect(null, null, "diar.ia.br");
  assert.equal(result.redirectsToNewHost, null);
});

function fullOkReport(): ApexCutoverReportInput {
  return {
    generatedAtIso: "2026-08-28T00:00:00.000Z",
    homeLang: "pt-BR",
    postCheck: {
      langPtBr: true,
      selfCanonical: true,
      canonicalUrl: "https://diar.ia.br/p/x",
      hasMetaDescription: true,
      metaDescription: "Descrição própria da edição.",
    },
    postUrl: "https://diar.ia.br/p/x",
    sitemapUrlCount: 254,
    sitemapHasSampledPost: true,
    robots: { allowsAiCrawlers: true, declaresSitemap: true },
    legacyRedirect: { redirectsToNewHost: true, status: 301, locationHeader: "https://diar.ia.br/p/x" },
  };
}

test("allChecksPassed: relatório totalmente conforme passa", () => {
  assert.equal(allChecksPassed(fullOkReport()), true);
});

test("allChecksPassed: um false reprova o conjunto", () => {
  const report = fullOkReport();
  report.postCheck!.langPtBr = false;
  assert.equal(allChecksPassed(report), false);
});

test("allChecksPassed: checagem null (fetch indisponível) não reprova sozinha", () => {
  const report = fullOkReport();
  report.legacyRedirect = null;
  assert.equal(allChecksPassed(report), true);
});

test("renderApexCutoverReportMarkdown: gera markdown com as seções esperadas", () => {
  const markdown = renderApexCutoverReportMarkdown(fullOkReport());
  assert.match(markdown, /# Verificação do cutover do apex — #5125/);
  assert.match(markdown, /## Home \(`\/`\)/);
  assert.match(markdown, /## Página de post amostrada/);
  assert.match(markdown, /## Sitemap/);
  assert.match(markdown, /## Robots/);
  assert.match(markdown, /## Host legado/);
  assert.match(markdown, /254/);
});

test("renderApexCutoverReportMarkdown: cobre o caso sem post amostrado (sitemap vazio)", () => {
  const report = fullOkReport();
  report.postCheck = null;
  report.postUrl = null;
  const markdown = renderApexCutoverReportMarkdown(report);
  assert.match(markdown, /nenhuma página de post amostrada/);
});
