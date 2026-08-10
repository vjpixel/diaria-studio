/**
 * test/build-link-ctr.test.ts (#1567 audit, findings C + G)
 *
 * C — matchClick deve SOMAR cliques de variantes per-subscriber do mesmo link
 *     (baseUrl colapsa a query, Beehiiv emite 1 row por variante; o .find()
 *     antigo só pegava a primeira e subcontava o CTR editorial real).
 * G — isEditorial deve filtrar links de infra própria / utilitários
 *     (poll Workers, Google Meet, Creative Commons) que vazavam como "Outro".
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { matchClick, isEditorial, classifyOrigin, postKey, shouldSkipPost, extractLinks } from "../scripts/build-link-ctr.ts";
import { renderKicker, mdInlineToHtml } from "../scripts/lib/newsletter-render-html.ts";
import { resolveNewsletterSection } from "../scripts/lib/link-ctr-categorize.ts";
import { spawnNpx } from "./_helpers/spawn-npx.ts";

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

// #4835: renderKicker() emite o bullet como entidade HTML (`&#9679;`, via
// tealDot()) — cleanText() já removia essa forma. Mas a Beehiiv re-serve o
// HTML CACHEADO com o CARACTERE LITERAL ● (U+25CF), não a entidade — fixture
// abaixo espelha exatamente o que o cache real contém (mesmo shape do <td>
// estilizado testado acima, só trocando a entidade pelo char literal),
// reproduzindo o bug ao vivo (260810): 82% das seções do CSV de CTR saíam
// mal-rotuladas como 'Destaque'.
describe("extractLinks + resolveNewsletterSection — bullet ● literal do cache Beehiiv (#4835)", () => {
  it("kicker com ● literal (não &#9679;): sectionTitle preserva o bullet, resolveNewsletterSection ainda resolve 'Radar'", () => {
    const realHtmlWithLiteralBullet =
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
      '<td style="font-family:sans-serif;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#00A0A0;white-space:nowrap;padding-right:12px;">' +
      '<span style="color:#00A0A0;">●</span>&nbsp;RADAR</td>' +
      '<td style="width:100%;border-bottom:1px solid #EBE5D0;font-size:0;line-height:0;">&nbsp;</td>' +
      '</tr></table>' +
      '<a href="https://noticia.example.com/x">link de teste</a>';
    const links = extractLinks(realHtmlWithLiteralBullet);
    assert.equal(links.length, 1);
    // cleanText só remove a entidade &#9679;, não o char literal — o bullet
    // chega intacto no sectionTitle bruto (comportamento inalterado por este fix).
    assert.equal(links[0].sectionTitle, "● RADAR");
    // ANTES do fix: resolveNewsletterSection('● RADAR') => 'Destaque' (errado).
    assert.equal(resolveNewsletterSection(links[0].sectionTitle), "Radar");
  });

  it("mesma fixture pra USE MELHOR com ● literal", () => {
    const realHtmlWithLiteralBullet =
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
      '<td style="font-family:sans-serif;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#00A0A0;white-space:nowrap;padding-right:12px;">' +
      '<span style="color:#00A0A0;">●</span>&nbsp;USE MELHOR</td>' +
      '<td style="width:100%;border-bottom:1px solid #EBE5D0;font-size:0;line-height:0;">&nbsp;</td>' +
      '</tr></table>' +
      '<a href="https://tool.example.com/x">link de teste</a>';
    const links = extractLinks(realHtmlWithLiteralBullet);
    assert.equal(links.length, 1);
    assert.equal(links[0].sectionTitle, "● USE MELHOR");
    assert.equal(resolveNewsletterSection(links[0].sectionTitle), "Use Melhor");
  });
});

describe("extractLinks — <b> que embrulha <a href> não é heading (#4834)", () => {
  it("repro literal da issue: link some quando embrulhado em <b>, mas passa direto sem <b>", () => {
    // Antes do fix: extractLinks('<b><a href="...">t</a></b>') retornava [].
    const semB = extractLinks('<a href="https://example.com/abc">t</a>');
    assert.equal(semB.length, 1);
    assert.equal(semB[0].baseUrl, "https://example.com/abc");

    const comB = extractLinks('<b><a href="https://example.com/abc">t</a></b>');
    assert.equal(comB.length, 1, "o link não pode sumir só por estar dentro de <b>");
    assert.equal(comB[0].baseUrl, "https://example.com/abc");
    assert.equal(comB[0].anchor, "t");
  });

  it("cenário real de produção: mdInlineToHtml('**[texto](url)**') gera <b><a>...</a></b> (o `**` roda DEPOIS da linkificação)", () => {
    // Mecanismo real do bug (SORTEIO/PARA ENCERRAR, mdInlineToHtml): o regex de
    // bold `**...**` roda por último sobre a string JÁ linkificada, então
    // markdown bold em volta de um link markdown produz literalmente
    // <b><a href="...">texto</a></b> — não é um caso sintético.
    const html = mdInlineToHtml("Confira **[a novidade](https://exemplo.com/novidade)** hoje.");
    assert.match(html, /<b><a[^>]*href="https:\/\/exemplo\.com\/novidade"[^>]*>a novidade<\/a><\/b>/);

    const links = extractLinks(html);
    assert.equal(links.length, 1, "o link bold-wrapped precisa ser extraído");
    assert.equal(links[0].baseUrl, "https://exemplo.com/novidade");
    assert.equal(links[0].anchor, "a novidade");
  });

  it("<h1><b><a>manchete</a></b></h1> (forma citada na issue): link extraído, section heading não vira o texto da manchete", () => {
    const html = `
      ${renderKicker("DESTAQUE")}
      <h1><b><a href="https://exemplo.com/manchete">Manchete de destaque</a></b></h1>
      <a href="https://exemplo.com/segundo-link">segundo link</a>
    `;
    const links = extractLinks(html);
    assert.equal(links.length, 2);
    assert.equal(links[0].baseUrl, "https://exemplo.com/manchete");
    assert.equal(links[0].anchor, "Manchete de destaque");
    // A seção continua "DESTAQUE" (do kicker) — o <b><a> não deveria ter
    // sobrescrito currentSection com o texto da manchete.
    assert.equal(links[0].sectionTitle, "DESTAQUE");
    assert.equal(links[1].sectionTitle, "DESTAQUE");
  });

  it("<b> SEM <a> dentro continua funcionando como heading (comportamento pré-existente preservado)", () => {
    const html = `
      <b>Rodada De Investimento Bilionária</b>
      <a href="https://exemplo.com/x">link</a>
    `;
    const links = extractLinks(html);
    assert.equal(links.length, 1);
    assert.equal(links[0].sectionTitle, "Rodada De Investimento Bilionária");
  });

  it("dois links bold-wrapped em sequência: ambos extraídos, dedup por baseUrl continua valendo", () => {
    const html =
      '<b><a href="https://exemplo.com/a">um</a></b>' +
      '<b><a href="https://exemplo.com/a">um de novo</a></b>' + // mesmo baseUrl → dedup
      '<b><a href="https://exemplo.com/b">dois</a></b>';
    const links = extractLinks(html);
    assert.equal(links.length, 2);
    assert.deepEqual(links.map(l => l.baseUrl), ["https://exemplo.com/a", "https://exemplo.com/b"]);
  });
});

describe("build-link-ctr CLI — ctr_pct fica vazio quando unique_opens=0 (#4834 item 2)", () => {
  let tmpRoot: string;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "link-ctr-open0-"));
  });

  after(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("post confirmado com unique_opens=0 grava ctr_pct='' (não '0.00' — denominador ausente, não taxa zero medida)", () => {
    const dir = tmpRoot;
    fs.mkdirSync(path.join(dir, "data", "beehiiv-cache", "posts"), { recursive: true });

    const post = {
      id: "p-sem-opens",
      title: "Edição sem opens registrados",
      status: "confirmed",
      // publicado bem no passado, satisfaz o cutoff de estabilização de cliques
      publish_date: Math.floor(Date.parse("2026-05-01T00:00:00Z") / 1000),
      content: { free: { email: '<a href="https://exemplo.com/sem-opens">Matéria</a>' } },
      stats: { email: { unique_opens: 0 }, clicks: [] },
    };
    fs.writeFileSync(
      path.join(dir, "data", "beehiiv-cache", "posts", "p-sem-opens.json"),
      JSON.stringify(post),
      "utf8",
    );

    const script = path.resolve(import.meta.dirname, "..", "scripts", "build-link-ctr.ts");
    const r = spawnNpx(["tsx", script], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `esperado exit 0. stderr: ${r.stderr}`);

    const csv = fs.readFileSync(path.join(dir, "data", "link-ctr-table.csv"), "utf8");
    const lines = csv.trim().split("\n");
    const header = lines[0].split(",");
    const dataLine = lines.find(l => l.includes("sem-opens"));
    assert.ok(dataLine, `linha do link não encontrada no CSV: ${csv}`);
    const cells = dataLine!.split(",");
    const ctrIdx = header.indexOf("ctr_pct");
    assert.equal(cells[ctrIdx], "", "ctr_pct deve ficar vazio, não '0.00', quando unique_opens=0");
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
