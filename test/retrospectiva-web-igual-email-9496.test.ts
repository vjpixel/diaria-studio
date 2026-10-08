/**
 * test/retrospectiva-web-igual-email-9496.test.ts (#9496)
 *
 * A Retrospectiva na web (`retrospectiva.diar.ia.br/{AAMM}`, atrás do gate de
 * apoiador) é a versão web do e-mail que o apoiador recebe — mesmo conteúdo
 * editorial. Até o #9496 a página renderizava o `draft.md` CRU do envio
 * Clarice, e o apoiador via na web o que o e-mail dele não tinha:
 * APRESENTAÇÃO "newsletter mensal da Clarice", boxes "Desconto exclusivo"
 * (cupons NEWS25/NEWS50), o tutorial Clarice e "Assine agora e ganhe até 63%".
 * E o bloco É IA? divergia: a página mostrava o corpo escrito no draft ("52%
 * dos 48 leitores…"), o e-mail a legenda do `01-eia.md` (crédito da foto +
 * "Resultado da última edição: 61%…").
 *
 * O teste compara SEGMENTOS DE TEXTO dos dois renders a partir do MESMO draft
 * — não HTML, porque o visual web (CSS mobile #9492, rodapé sem descadastro,
 * UTM `artigo-web`) diverge de propósito. Invariantes:
 *
 *   1. nenhum segmento Clarice-only chega à página (completa nem trecho);
 *   2. todo segmento editorial do e-mail está na página — o que fica de fora
 *      é só chrome de imagem (a página só pluga as fotos do É IA?, #9864) e o
 *      parágrafo com merge tag, que a web remove por construção (#7580);
 *   3. o É IA? da página é o do e-mail (legenda do `01-eia.md`), não o corpo
 *      do draft;
 *   4. draft sem nada Clarice-only (ciclos antigos) não perde conteúdo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArticleHtml, buildArticleTeaserHtml } from "../scripts/lib/mensal/build-article-page.ts";
import { articleBuildOptionsForCycle } from "../scripts/build-article-page.ts";
import { draftToEmailApoiadoresKit } from "../scripts/lib/mensal/monthly-apoiadores-kit-render.ts";

/** Segmentos de texto visíveis: um por bloco (p/h*, td, li…), entidades e espaços normalizados. */
function textSegments(html: string): string[] {
  const body = html
    .replace(/<head[\s\S]*?<\/head>/i, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  return body
    .split(/<\/?(?:p|h[1-6]|td|tr|table|div|li|ul|ol|br)\b[^>]*>/i)
    .map((s) =>
      s
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

const CICLO = "2609-10";
const YYMM = "2609";
const CAPTION = "Criada com ChatGPT";
const EIA_CREDIT = [
  "Reservatório de Bab Louta, [Parque Nacional de Tazekka](https://pt.wikipedia.org/wiki/Tazekka), Marrocos — [Timothy A. Gonsalves](https://commons.wikimedia.org/wiki/User:Tagooty) / [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0).",
  "",
  "Resultado da última edição: 61% das pessoas acertaram.",
].join("\n");

/** Trechos que só existem no envio Clarice — nenhum pode aparecer na página. */
const CLARICE_ONLY = [
  "Esta é a newsletter mensal da Clarice",
  "Desconto exclusivo",
  "NEWS25",
  "Simplificar um trecho difícil",
  "Parafrasear sem repetir",
  "Assine agora e ganhe até 63% de desconto",
  "Recomendação da equipe da Clarice",
];

const enche = (s: string) => `${s} ${"Texto editorial de enchimento com tamanho realista. ".repeat(10)}`;

const DRAFT = [
  "**ASSUNTO (3 OPÇÕES)**",
  "",
  "1. diar.ia.br | Setembro 2026 — Agentes saem do teste",
  "",
  "**PREVIEW**",
  "",
  "Uma linha de preview.",
  "",
  "**APRESENTAÇÃO**",
  "",
  "Esta é a newsletter mensal da Clarice, em parceria com a diar.ia.br: uma curadoria do mês.",
  "",
  "**INTRO**",
  "",
  enche("Setembro foi o mês em que os agentes saíram do teste."),
  "",
  "---",
  "",
  "**DESTAQUE 1 | AGENTES**",
  "",
  "Agentes saem do teste e invadem governos",
  "",
  enche("Corpo do primeiro destaque com [fonte](https://exemplo.com/a1)."),
  "",
  "O fio condutor: o fecho do primeiro destaque.",
  "",
  "---",
  "",
  "**CLARICE — DIVULGAÇÃO**",
  "",
  "**Desconto exclusivo**",
  "",
  "Leitores desta newsletter usam os cupons NEWS25 ou NEWS50.",
  "",
  "→ [Assine agora e ganhe até 63% de desconto](https://clarice.ai/?via=diaria)",
  "",
  "---",
  "",
  "**DESTAQUE 2 | BRASIL**",
  "",
  "O Brasil tira a IA do piloto",
  "",
  enche("Corpo do segundo destaque."),
  "",
  "Recomendação da equipe da Clarice",
  "",
  "Você recebe esta curadoria uma vez por mês. A diar.ia.br publica uma edição diária.",
  "",
  "→ [Assinar a edição diária](https://diar.ia.br/?utm_source=clarice)",
  "",
  "---",
  "",
  "**CLARICE — TUTORIAL**",
  "",
  "Simplificar um trecho difícil",
  "",
  "1. Cole o texto na área de revisão.",
  "",
  "---",
  "",
  "**Laboratório Clarice**",
  "",
  "Parafrasear sem repetir você mesmo",
  "",
  "1. Cole o texto e clique em Parafrasear.",
  "",
  "---",
  "",
  "**DESTAQUE 3 | MERCADO**",
  "",
  "Um terceiro título",
  "",
  enche("Corpo do terceiro destaque."),
  "",
  "---",
  "",
  "**É IA? — DESTAQUE**",
  "",
  "Na edição de 25 de setembro, 52% dos 48 leitores que votaram acertaram.",
  "",
  "---",
  "",
  "**PARA ENCERRAR**",
  "",
  "Obrigado por ler até aqui.",
].join("\n");

/** O e-mail como o canal REALMENTE envia: com imagens de destaque, legenda e É IA?. */
function emailReal(draft: string): string {
  return draftToEmailApoiadoresKit(
    draft,
    null,
    YYMM,
    "https://img.exemplo/eia-a.jpg",
    "https://img.exemplo/eia-b.jpg",
    EIA_CREDIT,
    { 1: "https://img.exemplo/d1.jpg", 2: "https://img.exemplo/d2.jpg", 3: "https://img.exemplo/d3.jpg" },
    CAPTION,
  ).html;
}

/** Chrome que legitimamente difere: imagens (a página não as pluga) e merge tag (a web a remove). */
function ehChromeDeEmail(seg: string): boolean {
  return seg === CAPTION || /^Imagem [AB]$/.test(seg) || seg.includes("{{");
}

describe("#9496 — a página é a mesma versão do e-mail dos apoiadores", () => {
  const pagina = buildArticleHtml(DRAFT, CICLO, { eiaCredit: EIA_CREDIT }).html;
  const segsPagina = new Set(textSegments(pagina));

  it("nenhum segmento Clarice-only chega à página completa", () => {
    for (const trecho of CLARICE_ONLY) {
      assert.ok(!pagina.includes(trecho), `a página não pode ter "${trecho}"`);
    }
  });

  it("todo segmento editorial do e-mail está na página", () => {
    const faltando = textSegments(emailReal(DRAFT)).filter((s) => !ehChromeDeEmail(s) && !segsPagina.has(s));
    assert.deepEqual(faltando, [], "segmentos do e-mail ausentes na página");
  });

  it("e a página não tem segmento editorial que o e-mail não tenha", () => {
    const segsEmail = new Set(textSegments(emailReal(DRAFT)));
    const sobrando = [...segsPagina].filter((s) => !ehChromeDeEmail(s) && !segsEmail.has(s));
    assert.deepEqual(sobrando, [], "segmentos só na página");
  });

  it("É IA?: a página mostra a legenda do 01-eia.md (foto + resultado), não o corpo do draft", () => {
    assert.match(pagina, /Reservatório de Bab Louta/, "crédito da foto, como no e-mail");
    assert.match(pagina, /CC BY-SA 4\.0/);
    assert.match(pagina, /Resultado da última edição: 61% das pessoas acertaram/);
    assert.ok(!pagina.includes("52% dos 48 leitores"), "o corpo do draft é substituído, como no e-mail");
  });

  it("o trecho público passa pelo mesmo filtro", () => {
    const trecho = buildArticleTeaserHtml(DRAFT, CICLO, { eiaCredit: EIA_CREDIT }).html;
    assert.match(trecho, /Agentes saem do teste e invadem governos/);
    for (const t of CLARICE_ONLY) assert.ok(!trecho.includes(t), `o trecho não pode ter "${t}"`);
  });

  it("o pós-processo do HTML de e-mail (relink) roda ANTES das transformações web", () => {
    const html = buildArticleHtml(DRAFT, CICLO, {
      postProcessEmailHtml: (h) => h.replace("https://exemplo.com/a1", "https://diar.ia.br/p/relinkada?utm_medium=email"),
    }).html;
    assert.match(html, /diar\.ia\.br\/p\/relinkada\?utm_medium=artigo-web/, "o link relinkado também é retagueado");
  });
});

describe("#9496 — o CLI pluga os insumos do e-mail nas duas chamadas", () => {
  it("articleBuildOptionsForCycle lê a legenda do 01-eia.md e o relink é fail-soft", () => {
    const dir = mkdtempSync(join(tmpdir(), "ret-9496-"));
    try {
      writeFileSync(join(dir, "01-eia.md"), `---\neia_answer:\n  A: ia\n---\n\n**É IA?**\n\n${EIA_CREDIT}\n`);
      const opts = articleBuildOptionsForCycle(dir);
      assert.match(opts.eiaCredit ?? "", /Resultado da última edição: 61%/);
      // Sem `_internal/raw-destaques.json` o relink avisa e devolve o HTML intacto.
      assert.equal(opts.postProcessEmailHtml?.("<p>x</p>"), "<p>x</p>");
      assert.match(buildArticleHtml(DRAFT, CICLO, opts).html, /Reservatório de Bab Louta/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("main() passa as opções para o artigo E para o trecho", () => {
    const src = readFileSync("scripts/build-article-page.ts", "utf8");
    assert.match(src, /buildArticleHtml\(draftMd, cycle, articleBuildOptionsForCycle\(/);
    assert.match(src, /buildArticleTeaserHtml\(draftMd, cycle, articleBuildOptionsForCycle\(/);
  });
});

describe("#9864 — o É IA? da página tem as fotos, como o e-mail", () => {
  const URL_A = "https://img.exemplo/eia-a.jpg";
  const URL_B = "https://img.exemplo/eia-b.jpg";
  const mk = (withJpg: boolean, manifest?: object) => {
    const dir = mkdtempSync(join(tmpdir(), "ret-9864-"));
    mkdirSync(join(dir, "_internal"));
    if (withJpg) writeFileSync(join(dir, "01-eia-A.jpg"), "x");
    if (manifest) writeFileSync(join(dir, "_internal", "public-images.json"), JSON.stringify(manifest));
    return dir;
  };

  it("página e e-mail mostram as mesmas <img> do É IA? e sem placeholder", () => {
    const dir = mk(true, { images: { eia_a: { url: URL_A }, eia_b: { url: URL_B } } });
    try {
      const opts = articleBuildOptionsForCycle(dir);
      assert.equal(opts.eiaImageUrlA, URL_A);
      const pagina = buildArticleHtml(DRAFT, CICLO, opts).html;
      const imgs = (h: string) => [URL_A, URL_B].filter((u) => h.includes(u));
      assert.deepEqual(imgs(pagina), [URL_A, URL_B]);
      assert.deepEqual(imgs(pagina), imgs(emailReal(DRAFT)));
      assert.ok(!textSegments(pagina).some((s) => /^Imagem [AB]$/.test(s)), "sem placeholder");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("guard: foto no disco sem eia_a no manifest falha", () => {
    const dir = mk(true, { images: { eia_b: { url: URL_B } } });
    try {
      assert.throws(() => articleBuildOptionsForCycle(dir), /eia_a\/eia_b/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ciclo sem foto do É IA? não falha", () => {
    const dir = mk(false);
    try {
      assert.deepEqual(articleBuildOptionsForCycle(dir).eiaImageUrlA, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#9496 — ciclos antigos, sem nada Clarice-only, não perdem conteúdo", () => {
  const ANTIGO = [
    "**ASSUNTO (3 OPÇÕES)**",
    "",
    "1. diar.ia.br | Maio 2026 — Um título",
    "",
    "**INTRO**",
    "",
    enche("Introdução de um ciclo antigo."),
    "",
    "**DESTAQUE 1 | INDÚSTRIA**",
    "",
    "Um título antigo",
    "",
    enche("Corpo do destaque antigo."),
    "",
    "**RADAR DO MÊS**",
    "",
    "[Um link do radar](https://exemplo.com/r1)",
    "",
    "**É IA?**",
    "",
    "Legenda escrita no próprio draft.",
  ].join("\n");

  it("sem eiaCredit, o É IA? cai no corpo do draft — como no e-mail", () => {
    const html = buildArticleHtml(ANTIGO, "2605-06").html;
    assert.match(html, /Legenda escrita no próprio draft\./);
  });

  it("todo segmento editorial do draft continua na página", () => {
    const segsPagina = new Set(textSegments(buildArticleHtml(ANTIGO, "2605-06").html));
    const email = draftToEmailApoiadoresKit(ANTIGO, null, "2605").html;
    const faltando = textSegments(email).filter((s) => !ehChromeDeEmail(s) && !segsPagina.has(s));
    assert.deepEqual(faltando, []);
    for (const t of ["Introdução de um ciclo antigo.", "Um título antigo", "Um link do radar"]) {
      assert.ok([...segsPagina].some((s) => s.includes(t)), `"${t}" precisa continuar na página`);
    }
  });
});
