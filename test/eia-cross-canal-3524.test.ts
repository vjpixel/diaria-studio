/**
 * test/eia-cross-canal-3524.test.ts (#3524, corrigido pelo #3578)
 *
 * Última sub-issue do EPIC #3514 — fecha o loop cross-canal entre a versão
 * email (newsletter/vote do brand diaria/clarice) e a versão standalone
 * (site, brand `web`). Cobre as 3 pontes construídas nesta issue:
 *
 *   1. email → arquivo: o bloco É IA? da newsletter (`renderEIA`,
 *      scripts/lib/newsletter-render-html.ts) ganha um link persistente pro
 *      arquivo jogável (`/jogar/arquivo`, #3519) com UTM `utm_source=newsletter`.
 *   2. página pós-voto (email) → arquivo: `votePageHtml` (workers/poll/src/index.ts)
 *      ganha o mesmo link no rodapé, só para brands diaria/clarice — brand
 *      `web` já tem o equivalente no próprio `/jogar` (não duplicado aqui).
 *   3. reforço contextual de assinatura no arquivo (site): `renderJogarArchiveHtml`
 *      (workers/poll/src/jogar.ts) ganha uma frase de reforço — distinta do
 *      CTA principal pós-voto (#3518), que seria duplicação.
 *
 * Também cobre regressão: nenhuma das 3 mudanças quebra o fluxo de
 * voto/humanizador/lint existente.
 *
 * **Correção #3578** (feedback do editor 260716): a ponte 1 (email → arquivo)
 * e a metade "diaria" da ponte 2 foram REVERTIDAS — a É IA? da DIÁRIA só vota
 * no par do dia, sem arquivo/jogar edições anteriores. A ponte 2 continua
 * viva só pra brand `clarice` (mensal, que já podia voltar em edições
 * anteriores antes do #3524 e mantém isso). A ponte 3 (reforço no arquivo do
 * site) não muda — é sobre o site standalone, não sobre a diária.
 * `renderJogarArchiveLinkRow`/`buildJogarArchiveUrl` (função 1) seguem
 * exportados e testados abaixo, mas sem caller em `renderEIA` desde o #3578.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderEIA,
  renderJogarArchiveLinkRow,
  buildJogarArchiveUrl,
  type EIA,
} from "../scripts/lib/newsletter-render-html.ts";
import { votePageHtml } from "../workers/poll/src/index.ts";
import {
  jogarArchiveHref,
  EMAIL_ARCHIVE_UTM_SOURCE,
  EMAIL_ARCHIVE_UTM_MEDIUM,
  EMAIL_ARCHIVE_UTM_CAMPAIGN,
} from "../workers/poll/src/lib.ts";
import {
  renderJogarArchiveHtml,
  renderArchiveSubscribeReinforcement,
  buildSubscribeUrl,
} from "../workers/poll/src/jogar.ts";

const baseEia: EIA = {
  credit: "Foto: Author / CC BY-SA 4.0.",
  imageA: "01-eia-A.jpg",
  imageB: "01-eia-B.jpg",
  edition: "260999",
};

describe("buildJogarArchiveUrl (#3524) — URL do arquivo com UTM do funil newsletter→site", () => {
  it("aponta pro worker /jogar/arquivo", () => {
    const url = buildJogarArchiveUrl();
    assert.match(url, /^https:\/\/poll\.diaria\.workers\.dev\/jogar\/arquivo\?/);
  });

  it("carrega utm_source=newsletter (literal da issue #3524)", () => {
    const url = buildJogarArchiveUrl();
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("utm_source"), "newsletter");
    assert.equal(parsed.searchParams.get("utm_medium"), "email");
    assert.equal(parsed.searchParams.get("utm_campaign"), "eia-arquivo");
  });

  it("determinística — mesma URL em chamadas repetidas", () => {
    assert.equal(buildJogarArchiveUrl(), buildJogarArchiveUrl());
  });
});

describe("renderJogarArchiveLinkRow (#3524) — linha do bloco É IA? da newsletter", () => {
  it("linka pra buildJogarArchiveUrl() com target=_blank + rel=noopener (sem escape — mesmo padrão de renderLeaderboardLinkRow, URL sem caractere que precise escape em atributo)", () => {
    const html = renderJogarArchiveLinkRow("font-size:16px;");
    const url = buildJogarArchiveUrl();
    assert.match(html, new RegExp(`href="${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener noreferrer"/);
  });

  it("copy convida a jogar edições passadas ('arquivo')", () => {
    const html = renderJogarArchiveLinkRow("font-size:16px;");
    assert.match(html, /arquivo/i);
  });
});

describe("renderEIA NÃO embute mais o link do arquivo no rodapé do painel — diária vota só no par do dia (correção #3578 do #3524)", () => {
  it("HTML do bloco É IA? NÃO contém o link pro arquivo (diária não joga edições passadas)", () => {
    const html = renderEIA(baseEia);
    assert.doesNotMatch(html, /\/jogar\/arquivo\?/, "renderEIA (diária) não deve linkar o arquivo — #3578");
    assert.doesNotMatch(html, /utm_source=newsletter/);
  });

  it("regressão: link persistente de leaderboard (#1970) continua presente", () => {
    const html = renderEIA(baseEia);
    assert.match(html, /\/leaderboard"/);
  });

  it("regressão: painel É IA? continua com merge tag {{email}} (modo merge-tag, #1186)", () => {
    const html = renderEIA(baseEia);
    assert.match(html, /\{\{email\}\}/);
    assert.ok(!html.includes("&sig="), "sig= não deve reaparecer");
  });

  it("regressão: crédito + imagens A/B continuam intactos", () => {
    const html = renderEIA(baseEia);
    assert.match(html, /Foto: Author/);
    assert.match(html, /\{\{IMG:01-eia-A\.jpg\}\}/);
    assert.match(html, /\{\{IMG:01-eia-B\.jpg\}\}/);
  });
});

describe("jogarArchiveHref (#3524) — href do worker pro rodapé da página pós-voto", () => {
  it("path relativo /jogar/arquivo com o mesmo UTM da newsletter", () => {
    const href = jogarArchiveHref();
    assert.match(href, /^\/jogar\/arquivo\?/);
    const parsed = new URL(href, "https://poll.diaria.workers.dev");
    assert.equal(parsed.searchParams.get("utm_source"), EMAIL_ARCHIVE_UTM_SOURCE);
    assert.equal(parsed.searchParams.get("utm_medium"), EMAIL_ARCHIVE_UTM_MEDIUM);
    assert.equal(parsed.searchParams.get("utm_campaign"), EMAIL_ARCHIVE_UTM_CAMPAIGN);
  });

  it("EMAIL_ARCHIVE_UTM_SOURCE === 'newsletter' — mesmo valor do funil da newsletter (coerência exigida pelo aceite #3524)", () => {
    assert.equal(EMAIL_ARCHIVE_UTM_SOURCE, "newsletter");
  });
});

describe("votePageHtml linka o arquivo no rodapé SÓ pra brand clarice — diária não joga edições passadas (correção #3578 do #3524)", () => {
  it("brand diaria (default): footer-links NÃO inclui 'Jogar edições passadas' (#3578)", () => {
    const html = votePageHtml("Você acertou!", true, null, null, null, "diaria");
    assert.ok(!html.includes("Jogar edições passadas"), "brand diaria não deve linkar o arquivo — #3578");
  });

  it("brand clarice: link presente (mensal MANTÉM o arquivo, já podia voltar em edições anteriores antes do #3524)", () => {
    const html = votePageHtml("Você acertou!", true, null, null, null, "clarice");
    assert.match(html, /Jogar edições passadas/);
    assert.match(html, /href="\/jogar\/arquivo\?utm_source=newsletter/);
  });

  it("brand web: link NÃO duplicado (o /jogar já tem o próprio link de arquivo no rodapé)", () => {
    const html = votePageHtml("Você acertou!", true, null, null, null, "web");
    assert.ok(!html.includes("Jogar edições passadas"), "brand web não deve repetir o link — já existe em /jogar");
  });

  it("regressão: footer-links continua com 'Voltar' + 'Ver leaderboard' em todos os brands", () => {
    const html = votePageHtml("Você acertou!", true, null, null, null, "diaria");
    assert.match(html, /Voltar para a/);
    assert.match(html, /Ver leaderboard/);
  });
});

describe("renderArchiveSubscribeReinforcement (#3524) — reforço no índice do arquivo, distinto do CTA principal", () => {
  it("linka pra buildSubscribeUrl() (mesmo destino/UTM do CTA principal #3518)", () => {
    const html = renderArchiveSubscribeReinforcement();
    const url = buildSubscribeUrl();
    const escapedHref = url.replace(/&/g, "&amp;");
    assert.match(html, new RegExp(`href="${escapedHref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  });

  it("NÃO é o mesmo bloco/id do CTA principal (sem 'jogar-subscribe-cta', sem 'hidden')", () => {
    const html = renderArchiveSubscribeReinforcement();
    assert.ok(!html.includes("jogar-subscribe-cta"), "não deve reusar o id do CTA principal — seria o mesmo elemento");
    assert.ok(!html.includes("hidden"), "reforço do índice é sempre visível, não gated por voto");
  });

  it("copy menciona a cadência diária (reforço contextual, não genérico)", () => {
    const html = renderArchiveSubscribeReinforcement();
    assert.match(html, /todo dia/i);
  });
});

describe("renderJogarArchiveHtml embute o reforço de assinatura (#3524)", () => {
  it("página de índice do arquivo contém o reforço, entre a lista de edições e o rodapé", () => {
    const html = renderJogarArchiveHtml(["260101", "260102"], "2026");
    const rowsIdx = html.indexOf("/jogar?edition=260101");
    const reinforcementIdx = html.indexOf("archive-subscribe-reinforcement");
    const footerIdx = html.indexOf("Voltar pro par de hoje");
    assert.ok(rowsIdx > -1 && reinforcementIdx > -1 && footerIdx > -1);
    assert.ok(reinforcementIdx > rowsIdx, "reforço deve vir depois da lista de edições");
    assert.ok(footerIdx > reinforcementIdx, "reforço deve vir antes do rodapé");
  });

  it("regressão: itens continuam linkando /jogar?edition= (identidade anônima, não /leaderboard/.../arquivo)", () => {
    const html = renderJogarArchiveHtml(["260101"], "2026");
    assert.match(html, /href="\/jogar\?edition=260101"/);
  });

  it("regressão: arquivo vazio ainda renderiza (sem lançar) com mensagem amigável", () => {
    const html = renderJogarArchiveHtml([], "2026");
    assert.match(html, /Nenhuma edição disponível ainda/);
    assert.match(html, /archive-subscribe-reinforcement/);
  });
});
