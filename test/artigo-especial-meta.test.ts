import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  readArtigoMeta,
  parseArtigoMetaHtml,
  extractLeadParagraphs,
  assertArtigoEspecialMeta,
  ArtigoEspecialMetaError,
} from "../scripts/lib/artigo-especial-meta.ts";

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

  it("o-agente TAMBEM tem 1 paragrafo intermediario entre lede e 1o h3.sect (#5979 review, PR #6000 — corrige claim anterior de que 'nao tinha')", () => {
    // Achado do review: o-agente tem a MESMA estrutura de engenharia-de-ilusao
    // (lede -> 1 <p> sem classe -> 1o h3.sect) — o paragrafo intermediario eh
    // uma frase de referencia a cobertura anterior ("A diar.ia.br ja havia
    // coberto..."), nao uma nota de apresentacao, mas eh descartado pela MESMA
    // regra estrutural (posicional, nao semantica) — ver docstring do modulo.
    const meta = readArtigoMeta(O_AGENTE_PATH);
    assert.equal(meta.leadParagraphs.length, 3);
    assert.match(meta.leadParagraphs[0], /Se você não sabe até onde o agente de IA/);
    // O paragrafo intermediario ("A diar.ia.br ja havia coberto esse mesmo
    // modelo...") nunca aparece — descartado pela regra estrutural.
    for (const p of meta.leadParagraphs) {
      assert.ok(!p.includes("já havia coberto"), `paragrafo intermediario vazou: "${p}"`);
    }
    // leadParagraphs[1]/[2] sao o conteudo REAL pos-1o-h3.sect, travado
    // explicitamente (sem isso a regressao do achado acima passaria batida
    // de novo — pr-test-analyzer, PR #6000).
    assert.match(meta.leadParagraphs[1], /Não é um evento isolado/);
    assert.match(meta.leadParagraphs[1], /Apollo Research documentou/);
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

describe("assertArtigoEspecialMeta (#5979 review, PR #6000)", () => {
  const VALID = { title: "T", description: "D", url: "https://x/", image: null, datePublished: null, dateModified: null, h1: "T", leadParagraphs: [] };

  it("nao lanca quando title e url estao presentes", () => {
    assert.doesNotThrow(() => assertArtigoEspecialMeta(VALID, "/path/index.html"));
  });

  it("lanca ArtigoEspecialMetaError quando title esta vazio", () => {
    assert.throws(
      () => assertArtigoEspecialMeta({ ...VALID, title: "" }, "/path/index.html"),
      (e: unknown) => e instanceof ArtigoEspecialMetaError && (e as Error).message.includes("og:title"),
    );
  });

  it("lanca quando url esta vazia, mensagem cita o path", () => {
    assert.throws(
      () => assertArtigoEspecialMeta({ ...VALID, url: "" }, "/artigos/2026/x/index.html"),
      (e: unknown) => e instanceof ArtigoEspecialMetaError && (e as Error).message.includes("/artigos/2026/x/index.html"),
    );
  });

  it("lanca com os 2 campos citados quando title E url estao vazios", () => {
    assert.throws(
      () => assertArtigoEspecialMeta({ ...VALID, title: "", url: "" }, "/path"),
      (e: unknown) => {
        if (!(e instanceof ArtigoEspecialMetaError)) return false;
        const msg = e.message;
        return msg.includes("og:title") && msg.includes("og:url");
      },
    );
  });

  it("description/image/datas vazias/null NAO disparam o guard (opcionais)", () => {
    assert.doesNotThrow(() =>
      assertArtigoEspecialMeta({ ...VALID, description: "", image: null, datePublished: null, dateModified: null }, "/path"),
    );
  });

  it("readArtigoMeta lanca ArtigoEspecialMetaError quando o HTML nao tem title nem og:title", () => {
    // Fixture sintetica sem <title>/og:title — extração falha, readArtigoMeta
    // deve abortar em vez de propagar title:"" silenciosamente (achado do
    // silent-failure-hunter, review PR #6000).
    const dir = mkdtempSync(join(tmpdir(), "artigo-meta-noTitle-"));
    try {
      const htmlPath = join(dir, "index.html");
      writeFileSync(
        htmlPath,
        '<meta property="og:url" content="https://x/"><div class="manuscript"><p class="lede">L.</p></div>',
        "utf8",
      );
      assert.throws(() => readArtigoMeta(htmlPath), ArtigoEspecialMetaError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
