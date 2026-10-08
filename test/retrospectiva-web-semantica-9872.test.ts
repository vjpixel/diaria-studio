/**
 * test/retrospectiva-web-semantica-9872.test.ts (#9872, #9865)
 *
 * A página web da Retrospectiva do Mês deixou de ser o HTML do e-mail
 * (tabelas de 600px, XHTML 1.0, ~190 `style=` inline, head sem
 * description/canonical/OG) e virou HTML semântico no estilo do Artigo
 * Especial. Critérios da issue, um bloco cada:
 *
 *   1. e-mail com saída INALTERADA — golden byte a byte do e-mail Clarice e do
 *      e-mail dos apoiadores, gerado ANTES da refatoração dos parsers;
 *   2. página sem `<table>` de layout, com head completo;
 *   3. texto da página idêntico ao do e-mail (segmentos, em ordem);
 *   4. trecho + paywall com o mesmo comportamento;
 *   5. #9865: o "Ver ranking" da página aponta para `brand=clarice`, e o
 *      e-mail dos apoiadores mantém o próprio brand.
 *
 * A fixture `retrospectiva-web-9872/draft.md` é sintética e cobre todas as
 * seções que o render conhece (destaque com e sem "O fio condutor", caixas com
 * imagem/lista/CTA, Livro, Livros, Use Melhor com CTA, Radar com CTA de fecho,
 * É IA?, pills do Para encerrar, parágrafo com `{{ unsubscribe }}`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { draftToEmail } from "../scripts/lib/mensal/monthly-render.ts";
import {
  APOIADORES_KIT_UTM_PROFILE,
  draftToEmailApoiadoresKit,
} from "../scripts/lib/mensal/monthly-apoiadores-kit-render.ts";
import { filterDraftForApoiadores } from "../scripts/lib/mensal/monthly-draft-filter.ts";
import { draftToWebArticle, WEB_EIA_TITLE } from "../scripts/lib/mensal/monthly-web-render.ts";
import {
  buildArticleHtml,
  buildArticleTeaserHtml,
  WEB_LEADERBOARD_BRAND,
} from "../scripts/lib/mensal/build-article-page.ts";
import {
  extractMetaDescription,
  injectRetrospectivaHeadMeta,
} from "../scripts/lib/shared/retrospectiva-seo.ts";
import { renderTeaserWithPaywall } from "../workers/retrospectiva/src/render-mensal.ts";

const DIR = resolve(import.meta.dirname, "fixtures/retrospectiva-web-9872");
const DRAFT = readFileSync(resolve(DIR, "draft.md"), "utf8");
const CICLO = "2609-10";
const YYMM = "2609";

// Mesmos insumos com que o golden foi gerado (antes da refatoração, em master 0ca367100).
const EIA_A = "https://img/a.jpg";
const EIA_B = "https://img/b.jpg";
const CREDIT = "Crédito [X](https://x.org).";
const IMGS = { 1: "https://img/d1.jpg", 2: "https://img/d2.jpg", 3: "https://img/d3.jpg" };
const CAPTION = "Criada com ChatGPT";
const LIVROS_IMG = "https://img/livros.jpg";
const PREV = "Resultado da última edição: 61% acertaram.";

/** Segmentos de texto visíveis, um por bloco. Da página só conta o `<article>`
 *  (o masthead é cromo); o ● dos kickers (texto no e-mail, CSS na web) sai. */
function textSegments(html: string): string[] {
  const article = /<article\b[^>]*>([\s\S]*)<\/article>/i.exec(html);
  const body = (article ? article[1] : html)
    .replace(/<head[\s\S]*?<\/head>/i, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  return body
    .split(/<\/?(?:p|h[1-6]|td|tr|table|div|li|ul|ol|br|section|aside|figure|figcaption)\b[^>]*>/i)
    .map((s) =>
      s
        .replace(/&#9679;/g, "")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((s) => s.length > 0);
}

/** #9916: o título do É IA? é a única divergência de texto deliberada — o
 *  e-mail manda clicar (foto é link de voto), a web pergunta (foto sem link). */
const EMAIL_EIA_TITLE = "Clique na imagem que foi gerada por IA";
const comoNaWeb = (segs: string[]): string[] => segs.map((s) => (s === EMAIL_EIA_TITLE ? WEB_EIA_TITLE : s));

function emailKit(): string {
  return draftToEmailApoiadoresKit(DRAFT, null, YYMM, EIA_A, EIA_B, CREDIT, IMGS, CAPTION, LIVROS_IMG, PREV).html;
}

describe("#9872 — o e-mail sai byte a byte igual (golden pré-refatoração)", () => {
  it("e-mail Clarice", () => {
    const html = draftToEmail(DRAFT, null, YYMM, EIA_A, EIA_B, CREDIT, IMGS, CAPTION, LIVROS_IMG, PREV).html;
    assert.equal(html, readFileSync(resolve(DIR, "email-clarice.golden.html"), "utf8"));
  });

  it("e-mail dos apoiadores (Kit)", () => {
    assert.equal(emailKit(), readFileSync(resolve(DIR, "email-kit.golden.html"), "utf8"));
  });

  it("o e-mail continua em tabelas — a mudança é só da web", () => {
    assert.match(emailKit(), /<table[^>]*class="ds-canvas"/);
  });
});

describe("#9872 — página web: HTML semântico, sem tabela de layout", () => {
  const page = buildArticleHtml(DRAFT, CICLO, { eiaCredit: CREDIT, eiaImageUrlA: EIA_A, eiaImageUrlB: EIA_B }).html;

  it("regressão: nenhuma <table> e nenhum XHTML de e-mail", () => {
    assert.doesNotMatch(page, /<table\b/i);
    assert.doesNotMatch(page, /XHTML/);
    assert.doesNotMatch(page, /ds-canvas/);
    assert.match(page, /^<!DOCTYPE html>\n<html lang="pt-BR">/);
  });

  it("estrutura do Artigo Especial: masthead + manuscript, h1, um h2 por destaque", () => {
    assert.match(page, /<header class="masthead">/);
    assert.match(page, /<article class="manuscript">/);
    assert.equal((page.match(/<h1>/g) ?? []).length, 1);
    assert.match(page, /<h1>Retrospectiva de setembro: Agentes saem do teste e invadem governos<\/h1>/);
    assert.equal((page.match(/<section class="destaque"/g) ?? []).length, 3);
    assert.match(page, /<aside class="fio"><p class="fio-tag">O fio condutor<\/p>/);
  });

  it("estilo inline praticamente zerado (só o wordmark da marca)", () => {
    const styles = page.match(/style="[^"]*"/g) ?? [];
    assert.ok(styles.every((s) => /^style="color:#00A0A0"$/i.test(s)), `estilos inline fora do wordmark: ${styles.filter((s) => !/color:#00A0A0/i.test(s)).join(" ")}`);
  });

  it("head completo: description (do PREVIEW), canonical, OG e Twitter", () => {
    const head = page.slice(0, page.indexOf("</head>"));
    const preview = "Agentes de IA saíram do laboratório e entraram em governos, bancos e escritórios.";
    assert.match(head, /<meta charset="utf-8">/);
    assert.match(head, /<title>diar\.ia\.br \| Setembro 2026 — Agentes saem do teste<\/title>/, "title = ASSUNTO (#3940/#7719)");
    assert.ok(head.includes(`<meta name="description" content="${preview}">`));
    assert.match(head, /<link rel="canonical" href="https:\/\/retrospectiva\.diar\.ia\.br\/2609">/);
    assert.match(head, /<meta property="og:type" content="article">/);
    assert.match(head, /<meta property="og:title" content="diar\.ia\.br \| Setembro 2026/);
    assert.ok(head.includes(`<meta property="og:description" content="${preview}">`));
    assert.match(head, /<meta property="og:url" content="https:\/\/retrospectiva\.diar\.ia\.br\/2609">/);
    assert.match(head, /<meta name="twitter:card" content="summary">/);
    assert.equal(extractMetaDescription(page), preview);
  });

  it("o Worker não duplica description/canonical ao injetar o JSON-LD", () => {
    const out = injectRetrospectivaHeadMeta(page, { description: "x", canonical: "https://y", jsonLd: "{}" });
    assert.equal((out.match(/rel="canonical"/g) ?? []).length, 1);
    assert.equal((out.match(/name="description"/g) ?? []).length, 1);
    assert.match(out, /application\/ld\+json/, "o JSON-LD continua entrando");
  });

  it("e continua injetando as duas tags em HTML que não as tem (anual, legado)", () => {
    const out = injectRetrospectivaHeadMeta("<html><head><title>t</title></head><body></body></html>", {
      description: "d",
      canonical: "https://c",
      jsonLd: "{}",
    });
    assert.match(out, /<meta name="description" content="d" \/>/);
    assert.match(out, /<link rel="canonical" href="https:\/\/c" \/>/);
    assert.equal(extractMetaDescription("<head></head><body><meta name=\"description\" content=\"no corpo\"></body>"), null);
  });
});

describe("#9872 — texto da página idêntico ao do e-mail", () => {
  it("render web × e-mail, mesmos insumos: os segmentos de texto são os mesmos, na mesma ordem", () => {
    const web = draftToWebArticle({
      draft: filterDraftForApoiadores(DRAFT),
      yymm: YYMM,
      utmProfile: APOIADORES_KIT_UTM_PROFILE,
      leaderboardBrand: WEB_LEADERBOARD_BRAND,
      eiaImageUrlA: EIA_A,
      eiaImageUrlB: EIA_B,
      eiaCredit: CREDIT,
      eiaPrevResultLine: PREV,
      destaqueImageUrls: IMGS,
      destaqueImageCaption: CAPTION,
      livrosImageUrl: LIVROS_IMG,
    });
    assert.deepEqual(textSegments(`<article>${web.bodyHtml}</article>`), comoNaWeb(textSegments(emailKit())));
  });

  it("página publicada × e-mail: só diferem o parágrafo com merge tag (removido na web) e a legenda das fotos de destaque (não plugadas)", () => {
    const page = buildArticleHtml(DRAFT, CICLO, { eiaCredit: CREDIT, eiaImageUrlA: EIA_A, eiaImageUrlB: EIA_B }).html;
    const email = draftToEmailApoiadoresKit(DRAFT, null, YYMM, EIA_A, EIA_B, CREDIT).html;
    const esperado = comoNaWeb(textSegments(email)).filter((s) => !s.startsWith("Você está recebendo esse e-mail"));
    assert.deepEqual(textSegments(page), esperado);
    assert.ok(!page.includes("unsubscribe"), "a merge tag e o parágrafo saem");
  });

  it("o conteúdo Clarice-only do draft não chega à página", () => {
    const page = buildArticleHtml(DRAFT, CICLO).html;
    for (const t of ["Esta é a newsletter mensal da Clarice", "Desconto exclusivo", "NEWS25"]) {
      assert.ok(!page.includes(t), `"${t}" não pode estar na página`);
    }
  });

  it("as fotos do É IA? não são link de voto na web (#9864)", () => {
    const page = buildArticleHtml(DRAFT, CICLO, { eiaImageUrlA: EIA_A, eiaImageUrlB: EIA_B }).html;
    assert.ok(page.includes(`<img src="${EIA_A}"`));
    assert.doesNotMatch(page, /\/vote\//);
  });
});

describe("#9865 — 'Ver ranking' da página aponta para o leaderboard clarice", () => {
  const verRanking = (html: string): string => {
    const m = /<a\b[^>]*href="([^"]*)"[^>]*>Ver ranking<\/a>/.exec(html);
    assert.ok(m, "link 'Ver ranking' ausente");
    return m[1].replace(/&amp;/g, "&");
  };

  it("regressão: a página usa brand=clarice (era mensal-apoiadores-kit nas 5 edições)", () => {
    const href = verRanking(buildArticleHtml(DRAFT, CICLO).html);
    assert.match(href, /^https:\/\/eia\.diar\.ia\.br\/leaderboard\/2026\?brand=clarice&/);
    assert.ok(!href.includes("brand=mensal-apoiadores-kit"));
    assert.equal(WEB_LEADERBOARD_BRAND, "clarice");
  });

  it("o e-mail dos apoiadores mantém o brand dele, e o e-mail Clarice o dele", () => {
    assert.match(verRanking(emailKit()), /\?brand=mensal-apoiadores-kit&/);
    assert.match(verRanking(draftToEmail(DRAFT, null, YYMM).html), /\?brand=clarice&/);
  });

  it("o ranking da página e o do e-mail Clarice são o MESMO leaderboard (mesmo ano, mesmo brand)", () => {
    const semUtm = (u: string) => u.split("&")[0];
    assert.equal(semUtm(verRanking(buildArticleHtml(DRAFT, CICLO).html)), semUtm(verRanking(draftToEmail(DRAFT, null, YYMM).html)));
  });
});

describe("#9872 — trecho público + paywall, mesmo comportamento", () => {
  const trecho = buildArticleTeaserHtml(DRAFT, CICLO).html;

  it("o trecho é página web completa e leva só o DESTAQUE 1", () => {
    assert.doesNotMatch(trecho, /<table\b/i);
    assert.match(trecho, /Agentes saem do teste e invadem governos/);
    assert.ok(!trecho.includes("O Brasil entra na corrida dos modelos abertos"), "o D2 é pago");
    assert.ok(!trecho.includes("A regra chega atrasada"), "o D3 é pago");
    assert.match(trecho, /<link rel="canonical" href="https:\/\/retrospectiva\.diar\.ia\.br\/2609">/);
  });

  it("o Worker injeta o bloco de conversão antes do </body>, depois do artigo", () => {
    const servido = renderTeaserWithPaywall(trecho, "2609");
    const iPaywall = servido.indexOf('id="retrospectiva-paywall"');
    assert.ok(iPaywall > servido.indexOf("</article>"), "paywall depois do artigo");
    assert.ok(iPaywall < servido.lastIndexOf("</body>"));
    assert.match(servido, /apoia\.se\/diaria/);
  });
});
