import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readArtigoMeta, parseArtigoMetaHtml, extractLeadParagraphs } from "../scripts/lib/artigo-especial-meta.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENGENHARIA_PATH = resolve(
  ROOT,
  "workers/artigos/public/2026/engenharia-de-ilusao/index.html",
);
const O_AGENTE_PATH = resolve(ROOT, "workers/artigos/public/2026/o-agente/index.html");

describe("readArtigoMeta / parseArtigoMetaHtml (#5979)", () => {
  it("extrai title/description/url/image/datePublished do artigo com nota de apresentação", () => {
    const meta = readArtigoMeta(ENGENHARIA_PATH);
    assert.equal(meta.title, "Engenharia de ilusão: jailbreak de IA não arromba, encena");
    assert.match(meta.description, /atacante assume um papel/);
    assert.equal(meta.url, "https://especial.diar.ia.br/2026/engenharia-de-ilusao/");
    assert.equal(meta.image, "https://especial.diar.ia.br/2026/engenharia-de-ilusao/capa.jpg");
    assert.equal(meta.datePublished, "2026-08-18");
    assert.equal(meta.dateModified, "2026-08-22");
    assert.equal(meta.h1, "Engenharia de ilusão: jailbreak de IA não arromba, encena");
  });

  it("leadParagraphs: 1o item eh o lede, nota de apresentacao (2o <p> sem classe antes do 1o h3.sect) fica de fora", () => {
    const meta = readArtigoMeta(ENGENHARIA_PATH);
    assert.equal(meta.leadParagraphs.length, 3);
    // O lede real (fingiu ser alguem a quem a regra nao se aplica).
    assert.match(meta.leadParagraphs[0], /jailbreak/i);
    assert.match(meta.leadParagraphs[0], /fingiu ser alguém/);
    // A nota de apresentacao ("Este artigo explica o mecanismo... Patrono Murilo
    // Sarno") nunca aparece em nenhum dos 3 paragrafos.
    for (const p of meta.leadParagraphs) {
      assert.ok(!p.includes("Murilo Sarno"), `nota de apresentação vazou: "${p}"`);
      assert.ok(!p.includes("Este artigo explica o mecanismo"));
    }
    // Os 2 paragrafos seguintes sao conteudo real, na ordem do documento.
    assert.match(meta.leadParagraphs[1], /Em agosto, a/);
    assert.match(meta.leadParagraphs[2], /Isso já diz algo sobre a natureza/);
  });

  it("leadParagraphs sem tags HTML residuais (links/strong removidos, texto preservado)", () => {
    const meta = readArtigoMeta(ENGENHARIA_PATH);
    for (const p of meta.leadParagraphs) {
      assert.ok(!p.includes("<"), `tag HTML vazou: "${p}"`);
    }
    assert.match(meta.leadParagraphs[1], /usou o Claude para conduzir quase toda uma invasão/);
  });

  it("artigo SEM nota de apresentacao (o-agente: h3.sect logo apos o lede) ainda produz leadParagraphs corretos", () => {
    const meta = readArtigoMeta(O_AGENTE_PATH);
    assert.ok(meta.leadParagraphs.length >= 1);
    assert.match(meta.leadParagraphs[0], /Se você não sabe até onde o agente de IA/);
    // Sem nota pra pular — os proximos paragrafos vem direto do conteudo real
    // pos primeiro h3.sect.
    for (const p of meta.leadParagraphs) {
      assert.ok(p.length > 0);
    }
  });

  it("maxParagraphs customizado limita o array", () => {
    const meta = readArtigoMeta(ENGENHARIA_PATH, 1);
    assert.equal(meta.leadParagraphs.length, 1);
  });

  it("lanca ao ler arquivo inexistente", () => {
    assert.throws(() => readArtigoMeta(resolve(ROOT, "workers/artigos/public/2026/nao-existe/index.html")));
  });
});

describe("extractLeadParagraphs (#5979) — casos sintéticos", () => {
  it("sem <p class=lede> retorna array vazio", () => {
    const html = `<div class="manuscript"><p>sem lede</p></div>`;
    assert.deepEqual(extractLeadParagraphs(html), []);
  });

  it("lede vazio (só espaços/tags) retorna array vazio", () => {
    const html = `<div class="manuscript"><p class="lede">   </p></div>`;
    assert.deepEqual(extractLeadParagraphs(html), []);
  });

  it("múltiplos <p> de nota antes do h3.sect são todos descartados", () => {
    const html =
      '<div class="manuscript">' +
      '<p class="lede">Lede real.</p>' +
      "<p>Nota 1 de apresentação.</p>" +
      "<p>Nota 2 de apresentação.</p>" +
      '<h3 class="sect">01</h3>' +
      "<p>Conteúdo real 1.</p>" +
      "<p>Conteúdo real 2.</p>" +
      "</div>";
    const paras = extractLeadParagraphs(html, 3);
    assert.deepEqual(paras, ["Lede real.", "Conteúdo real 1.", "Conteúdo real 2."]);
  });

  it("decodifica entidades HTML comuns", () => {
    const html = '<div class="manuscript"><p class="lede">A &amp; B &mdash; C&#39;s &quot;quote&quot;.</p></div>';
    assert.deepEqual(extractLeadParagraphs(html, 1), [`A & B — C's "quote".`]);
  });
});

describe("parseArtigoMetaHtml — JSON-LD malformado nao quebra o resto", () => {
  it("datas ficam null mas title/description/url continuam extraidos", () => {
    const html = [
      "<title>T</title>",
      '<meta name="description" content="D">',
      '<meta property="og:url" content="https://especial.diar.ia.br/2026/x/">',
      '<script type="application/ld+json">{ invalido </script>',
      '<div class="manuscript"><p class="lede">Lede.</p></div>',
    ].join("\n");
    const meta = parseArtigoMetaHtml(html);
    assert.equal(meta.title, "T");
    assert.equal(meta.description, "D");
    assert.equal(meta.datePublished, null);
    assert.equal(meta.dateModified, null);
  });
});
