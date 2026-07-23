/**
 * test/build-link-ctr.test.ts (#1567 audit, findings C + G)
 *
 * C — matchClick deve SOMAR cliques de variantes per-subscriber do mesmo link
 *     (baseUrl colapsa a query, Beehiiv emite 1 row por variante; o .find()
 *     antigo só pegava a primeira e subcontava o CTR editorial real).
 * G — isEditorial deve filtrar links de infra própria / utilitários
 *     (poll Workers, Google Meet, Creative Commons) que vazavam como "Outro".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchClick, isEditorial, classifyOrigin, postKey, shouldSkipPost, extractLinks } from "../scripts/build-link-ctr.ts";
import { renderKicker } from "../scripts/lib/newsletter-render-html.ts";

describe("matchClick — soma variantes split do mesmo base_url (#1567 finding C)", () => {
  it("soma unique_verified/verified/unique de todas as rows que colapsam pro mesmo base", () => {
    // 3 variantes per-subscriber (query diferente) → baseUrl colapsa todas pra https://x.com/a
    const clicks = [
      { url: "https://x.com/a?bhcl_id=1", email: { verified_clicks: 2, unique_verified_clicks: 1, unique_clicks: 2 } },
      { url: "https://x.com/a?bhcl_id=2", email: { verified_clicks: 0, unique_verified_clicks: 1, unique_clicks: 0 } },
      { url: "https://x.com/a?bhcl_id=3", email: { verified_clicks: 1, unique_verified_clicks: 1, unique_clicks: 1 } },
    ];
    const r = matchClick("https://x.com/a", clicks);
    // antes (.find): pegava só a 1ª → uvc=1. agora soma → uvc=3.
    assert.equal(r.unique_verified_clicks, 3);
    assert.equal(r.verified_clicks, 3);
    assert.equal(r.unique_clicks, 3);
  });

  it("bucket exato tem precedência sobre o fuzzy (não soma os dois)", () => {
    const clicks = [
      { base_url: "https://x.com/a", email: { verified_clicks: 5, unique_verified_clicks: 4, unique_clicks: 5 } },
      // mesma URL normalizada (fuzzy), NÃO deve ser somada quando há match exato
      { url: "HTTP://x.com/a/", email: { verified_clicks: 9, unique_verified_clicks: 9, unique_clicks: 9 } },
    ];
    const r = matchClick("https://x.com/a", clicks);
    assert.equal(r.unique_verified_clicks, 4); // só o bucket exato
  });

  it("sem match → zeros; array vazio → zeros", () => {
    const clicks = [{ url: "https://other.com/z", email: { verified_clicks: 3, unique_verified_clicks: 3, unique_clicks: 3 } }];
    assert.deepEqual(matchClick("https://x.com/a", clicks), {
      verified_clicks: 0, unique_verified_clicks: 0, unique_clicks: 0,
    });
    assert.deepEqual(matchClick("https://x.com/a", []), {
      verified_clicks: 0, unique_verified_clicks: 0, unique_clicks: 0,
    });
  });
});

describe("isEditorial — filtra infra própria / utilitários (#1567 finding G)", () => {
  it("rejeita poll Workers, Google Meet e Creative Commons", () => {
    assert.equal(isEditorial("https://poll.diaria.workers.dev/vote"), false);
    assert.equal(isEditorial("https://diar-ia-poll.diaria.workers.dev/vote"), false);
    assert.equal(isEditorial("http://meet.google.com/afe-tynp-qst"), false);
    assert.equal(isEditorial("https://creativecommons.org/licenses/by-sa/4.0"), false);
  });

  it("#3904: rejeita eia.diar.ia.br (domínio de marca do worker poll) — mesma classe do finding G acima", () => {
    // Regressão: a migração do link de voto pro domínio de marca (#3904) não
    // pode fazer o clique vazar como "editorial" no Top-15 de domínios —
    // mesmo bug que .workers.dev já é allowlistado pra prevenir, só que pro
    // hostname novo.
    assert.equal(isEditorial("https://eia.diar.ia.br/vote?email=x@x.com&edition=260722&choice=A"), false);
    assert.equal(isEditorial("https://eia.diar.ia.br/leaderboard"), false);
  });

  it("mantém links editoriais reais (não over-filtra)", () => {
    assert.equal(
      isEditorial("https://techcrunch.com/2026/05/19/openai-co-founder-joins-anthropic"),
      true,
    );
    assert.equal(
      isEditorial("https://g1.globo.com/tecnologia/noticia/2026/04/25/x.ghtml"),
      true,
    );
    // google.com com path editorial continua válido (só a raiz é filtrada)
    assert.equal(isEditorial("https://blog.google/technology/ai/gemini-update"), true);
  });
});

describe("classifyOrigin — origem por-link, sem vazamento do título (#1567 finding B)", () => {
  it("link internacional NÃO herda o ângulo BR do lead do post (title não é mais passado)", () => {
    // anchor/section/context do próprio link (US funding), domínio estrangeiro → INT.
    // Antes, o title "Brasil investe R$ 23 bi" era concatenado e forçava BR.
    assert.equal(
      classifyOrigin("LayerX levanta US$ 100 milhões em rodada Série B", "techcrunch.com"),
      "INT",
    );
    assert.equal(classifyOrigin("OpenAI releases GPT-5", "openai.com"), "INT");
  });

  it("domínio .br é override forte de BR", () => {
    assert.equal(classifyOrigin("OpenAI lança novo modelo", "canaltech.com.br"), "BR");
    assert.equal(classifyOrigin("qualquer texto", "gov.br"), "BR");
    // .com de outlet estrangeiro continua INT sem keyword BR
    assert.equal(classifyOrigin("AI startup raises funding", "theverge.com"), "INT");
  });

  it("keyword BR no texto do próprio link classifica BR", () => {
    assert.equal(classifyOrigin("IA no Brasil avança em 2026", "x.com"), "BR");
    assert.equal(classifyOrigin("Investimento de R$ 23 bilhões em IA", "x.com"), "BR");
    assert.equal(classifyOrigin("Senado Federal aprova marco da IA", "x.com"), "BR");
  });

  it("tokens ambíguos endurecidos: senador americano / r$ sem dígito → INT", () => {
    assert.equal(classifyOrigin("US senator / senador americano propõe lei de IA", "reuters.com"), "INT");
    assert.equal(classifyOrigin("earn 100 r$ values inside the app", "producthunt.com"), "INT");
    // 'usp' cru não dispara mais BR (colidia com unique selling proposition)
    assert.equal(classifyOrigin("the main usp of this product is speed", "producthunt.com"), "INT");
  });
});

describe("extractLinks — sectionTitle reconhece o kicker <td> real do Beehiiv (#3043)", () => {
  it("captura o label do renderKicker() real (fixture construída com a função canônica, não HTML digitado à mão)", () => {
    // Espelha como renderKicker() é usado de verdade (ex: renderDivulgacaoSeparator,
    // renderSectionItem): embrulhado num <tr><td class="pad">...</td></tr>.
    const html = `
      <tr><td class="pad">${renderKicker("USE MELHOR")}</td></tr>
      <table><tr><td><a href="https://example.com/ferramenta-legal">Ferramenta legal</a></td></tr></table>
    `;
    const links = extractLinks(html);
    assert.equal(links.length, 1);
    assert.equal(links[0].sectionTitle, "USE MELHOR");
  });

  it("reproduz literalmente o HTML capturado no cache real (post_22f25875, edição 260630) — <td> estilizado, não <b>", () => {
    // String confirmada pelo coordenador contra data/beehiiv-cache/posts/post_22f25875-....json.
    const realHtml =
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
      '<td style="font-family:sans-serif;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#00A0A0;white-space:nowrap;padding-right:12px;">' +
      '<span style="color:#00A0A0;">&#9679;</span>&nbsp;USE MELHOR</td>' +
      '<td style="width:100%;border-bottom:1px solid #EBE5D0;font-size:0;line-height:0;">&nbsp;</td>' +
      '</tr></table>' +
      '<a href="https://tool.example.com/x">link de teste</a>';
    const links = extractLinks(realHtml);
    assert.equal(links.length, 1);
    assert.equal(links[0].sectionTitle, "USE MELHOR");
  });

  it("não confunde outro <td> em negrito qualquer (sem a assinatura completa) com um heading de seção", () => {
    const html = `
      ${renderKicker("LANÇAMENTOS")}
      <a href="https://x.com/a">primeiro link</a>
      <table><tr><td style="font-weight:bold;">Texto qualquer em negrito, não é kicker (sem letter-spacing/uppercase)</td></tr></table>
      <a href="https://y.com/b">segundo link</a>
    `;
    const links = extractLinks(html);
    assert.equal(links.length, 2);
    // O <td> bold genérico (sem a assinatura completa) não deve sobrescrever a seção.
    assert.equal(links[0].sectionTitle, "LANÇAMENTOS");
    assert.equal(links[1].sectionTitle, "LANÇAMENTOS");
  });

  it("heading muda pro link seguinte quando um novo kicker aparece no meio", () => {
    const html = `
      ${renderKicker("RADAR")}
      <a href="https://a.com/1">link A</a>
      ${renderKicker("NOTÍCIAS")}
      <a href="https://b.com/2">link B</a>
    `;
    const links = extractLinks(html);
    assert.equal(links.length, 2);
    assert.equal(links[0].sectionTitle, "RADAR");
    assert.equal(links[1].sectionTitle, "NOTÍCIAS");
  });
});

describe("shouldSkipPost — incremental skip por identidade (#1567 finding H)", () => {
  const processedKeys = new Set<string>([
    postKey("2026-05-20", "Edição A de 20/05"), // irmã A já no CSV
  ]);
  const base = { isBootstrap: false, lastDate: "2026-05-20", processedKeys };

  it("bootstrap nunca pula", () => {
    assert.equal(shouldSkipPost({ ...base, isBootstrap: true, date: "2026-05-20", title: "qualquer" }), false);
  });
  it("date < lastDate ⇒ pula (run anterior)", () => {
    assert.equal(shouldSkipPost({ ...base, date: "2026-05-10", title: "Velha" }), true);
  });
  it("date > lastDate ⇒ não pula (nova)", () => {
    assert.equal(shouldSkipPost({ ...base, date: "2026-05-21", title: "Nova" }), false);
  });
  it("MESMA data + já no CSV ⇒ pula (irmã A já processada)", () => {
    assert.equal(shouldSkipPost({ ...base, date: "2026-05-20", title: "Edição A de 20/05" }), true);
  });
  it("MESMA data + NÃO no CSV ⇒ NÃO pula (o fix: irmã B de mesma data)", () => {
    // Antes (date <= lastDate) isto era pulado pra sempre, perdendo os links da edição B.
    assert.equal(shouldSkipPost({ ...base, date: "2026-05-20", title: "Edição B de 20/05" }), false);
  });
});
