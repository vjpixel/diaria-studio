/**
 * test/artigo-especial-producao-9099.test.ts (#9099)
 *
 * Cobre a parte determinística das etapas de PRODUÇÃO de
 * `/diaria-artigo-especial`:
 *   (a) conversor draft.md → articles-src/{slug}.html + registro nos 5
 *       arquivos do Worker (`lib/artigo-especial-draft.ts`,
 *       `lib/artigo-especial-register.ts`, `render-artigo-especial-html.ts`);
 *   (b) probe da URL publicada com fetch injetado (`lib/artigo-especial-probe.ts`);
 *   (c) state das etapas no mesmo `published.json` dos canais
 *       (`lib/artigo-especial-state.ts`, `artigo-especial-producao.ts`) e a
 *       resolução do tema vencedor (`lib/artigo-especial-tema.ts`).
 *
 * A fidelidade ao template é checada contra os artigos REAIS de
 * `workers/artigos/articles-src/` (CSS base, menu global), não contra uma
 * cópia — se o template dos artigos mudar, este teste acusa.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  ArtigoEspecialDraftError,
  extractBaseStyle,
  formatDataPt,
  parseArtigoEspecialDraft,
  renderArtigoEspecialHtml,
  renderInline,
} from "../scripts/lib/artigo-especial-draft.ts";
import {
  registerInArticlesList,
  registerInGatedArticles,
  registerInIndexHtml,
  registerInSitemap,
  registerInWranglerToml,
  type RegisterArticle,
} from "../scripts/lib/artigo-especial-register.ts";
import { assessProbeResponse, probeArtigoEspecial, type ProbeFetch } from "../scripts/lib/artigo-especial-probe.ts";
import {
  artigoEspecialStatePath,
  nextProducaoEtapa,
  readArtigoEspecialState,
  withProducaoEtapa,
  buildDoneChannelState,
  buildFailedChannelState,
  type ArtigoEspecialState,
} from "../scripts/lib/artigo-especial-state.ts";
import { resolveTemaVencedor, suggestSlug, TemaVencedorError, type TemaStatsLike } from "../scripts/lib/artigo-especial-tema.ts";
import { parseArtigoMetaHtml } from "../scripts/lib/artigo-especial-meta.ts";
import { GATE_CUT_MARKER } from "../scripts/lib/shared/html-teaser-split.ts";
import { GATE_CTA_ID } from "../scripts/lib/shared/artigo-especial-gate-cta.ts";
import { buildArticleArtifacts } from "../scripts/build-artigo-especial-teaser.ts";
import { runRenderArtigoEspecialHtml, RenderArtigoGuardError } from "../scripts/render-artigo-especial-html.ts";
import { runMarkProducaoEtapa } from "../scripts/artigo-especial-producao.ts";
import { runMarkArtigoEspecialChannel } from "../scripts/mark-artigo-especial-channel.ts";

const ROOT = resolve(import.meta.dirname, "..");
const WORKER = resolve(ROOT, "workers", "artigos");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n?/g, "\n");

const DRAFT = `---
titulo: Teste: "aspas" & coisas
dek: Um dek curto que vira description.
slug: teste-x
ano: 2026
data: 2026-10-15
capa_alt: Ilustração estilo Van Gogh impasto de uma máquina.
---

Primeiro parágrafo, o lede, com **negrito** e [link](https://exemplo.com/a?b=1&c=2).

Segundo parágrafo da abertura, com \`code\` e *itálico*.

## O que é: definição

**Rótulo.** Texto com lead-in e <script>alert(1)</script> escapado.

- item um
- item dois

## Segunda seção {toc: Segunda}

<div class="placar">
  <p>bloco cru</p>

  <p>ainda dentro do bloco</p>
</div>

1. passo
2. outro

## Terceira

Texto final.

## Fontes e notas

- Fonte A
`;

describe("#9099 (a) — draft.md → HTML no template dos artigos existentes", () => {
  const base = extractBaseStyle(read("workers/artigos/articles-src/o-jev.html"));
  const draft = parseArtigoEspecialDraft(DRAFT);
  const html = renderArtigoEspecialHtml(draft, base);

  it("CSS base é o MESMO bloco que o-agente e o-jev compartilham (uma fonte só, extraída)", () => {
    assert.equal(extractBaseStyle(read("workers/artigos/articles-src/o-agente.html")), base);
    assert.ok(html.includes(base));
  });

  it("menu global idêntico ao dos artigos publicados (renderSiteNav com apexBase)", () => {
    const navOf = (h: string) => h.slice(h.indexOf("<body>") + 6, h.indexOf("</nav>") + 6).trim();
    assert.equal(navOf(html), navOf(read("workers/artigos/articles-src/o-jev.html")));
  });

  it("metadados og/canonical/JSON-LD lidos de volta pelo extrator da divulgação", () => {
    const meta = parseArtigoMetaHtml(html);
    assert.equal(meta.title, 'Teste: "aspas" & coisas');
    assert.equal(meta.url, "https://especial.diar.ia.br/2026/teste-x/");
    assert.equal(meta.image, "https://especial.diar.ia.br/2026/teste-x/capa.jpg");
    assert.equal(meta.datePublished, "2026-10-15");
    assert.equal(meta.dateModified, "2026-10-15");
    assert.equal(meta.leadParagraphs[0], "Primeiro parágrafo, o lede, com negrito e link.");
    // Mesma regra estrutural do extrator: parágrafos entre o lede e a 1ª
    // seção são pulados; o 2º lead já vem da seção 01.
    assert.equal(meta.leadParagraphs[1], "Rótulo. Texto com lead-in e <script>alert(1)</script> escapado.");
    assert.ok(html.includes('<link rel="canonical" href="https://especial.diar.ia.br/2026/teste-x/">'));
  });

  it("seções numeradas + sumário com rótulo curto ({toc:} ou trecho antes do ':')", () => {
    assert.ok(html.includes('<h3 class="sect" id="s01"><span class="sect-n">01</span>O que é: definição</h3>'));
    assert.ok(html.includes('<a href="#s01"><span class="n">01</span>O que é</a>'));
    assert.ok(html.includes('<a href="#s02"><span class="n">02</span>Segunda</a>'));
    assert.ok(html.includes('<a href="#s03"><span class="n">03</span>Terceira</a>'));
    assert.ok(!html.includes('href="#s04"'), "fontes não entram na numeração");
    assert.ok(html.includes('<section class="sources">\n    <h2>Fontes e notas</h2>'));
  });

  it("corte do teaser cai por padrão logo antes da 2ª seção, uma vez só", () => {
    assert.equal(html.split(GATE_CUT_MARKER).length - 1, 1);
    assert.ok(html.indexOf(GATE_CUT_MARKER) < html.indexOf('id="s02"'));
    assert.ok(html.indexOf(GATE_CUT_MARKER) > html.indexOf('id="s01"'));
  });

  it("o build do teaser aceita a saída: teaser sem a 2ª seção, com o bloco do gate", () => {
    const { teaser, full } = buildArticleArtifacts(html, { slug: "teste-x", year: "2026" });
    assert.ok(teaser.includes(`id="${GATE_CTA_ID}"`));
    assert.ok(!teaser.includes("Segunda seção</h3>"));
    assert.ok(!teaser.includes("Texto final."));
    assert.ok(full.includes("Texto final.") && !full.includes(GATE_CUT_MARKER));
  });

  it("escapa texto, mas copia bloco HTML cru intacto (inclusive com linha em branco dentro)", () => {
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(html.includes('<div class="placar">\n  <p>bloco cru</p>\n\n  <p>ainda dentro do bloco</p>\n</div>'));
    assert.ok(html.includes('<p><span class="lead-in">Rótulo.</span> Texto com lead-in'));
    assert.ok(html.includes('<a href="https://exemplo.com/a?b=1&amp;c=2">link</a>'));
    assert.ok(html.includes("<ol>\n    <li>passo</li>"));
  });

  it("corte explícito (<!-- corte -->) substitui o padrão", () => {
    const d = DRAFT.replace("## Terceira", "<!-- corte -->\n\n## Terceira");
    const h = renderArtigoEspecialHtml(parseArtigoEspecialDraft(d), base);
    assert.equal(h.split(GATE_CUT_MARKER).length - 1, 1);
    assert.ok(h.indexOf(GATE_CUT_MARKER) > h.indexOf('id="s02"'));
    assert.ok(h.indexOf(GATE_CUT_MARKER) < h.indexOf('id="s03"'));
  });

  it("formato inválido falha com mensagem acionável (nunca gera artigo sem gate)", () => {
    const bad: Array<[string, RegExp]> = [
      [DRAFT.replace(/^---[\s\S]*?---\n/, ""), /frontmatter/],
      [DRAFT.replace("slug: teste-x", "slug: Teste X"), /slug/],
      [DRAFT.replace("data: 2026-10-15", "data: 2025-10-15"), /não é do ano/],
      [DRAFT.replace(/capa_alt:.*\n/, ""), /capa_alt/],
      [DRAFT.replace(/## Segunda[\s\S]*?## Fontes/, "## Fontes"), /pelo menos 2/],
      [DRAFT.replace("Primeiro parágrafo", "# Título\n\nPrimeiro"), /`# `/],
      [DRAFT.replace("Texto final.", "Texto final.\n\n<!-- corte -->\n\n<!-- corte -->"), /marcadores de corte/],
      [DRAFT.replace("Primeiro parágrafo", "<!-- corte -->\n\nPrimeiro parágrafo"), /antes da 1ª seção/],
    ];
    for (const [d, re] of bad) assert.throws(() => parseArtigoEspecialDraft(d), (e: Error) => e instanceof ArtigoEspecialDraftError && re.test(e.message), String(re));
    const jsLink = parseArtigoEspecialDraft(DRAFT.replace("[link](https://exemplo.com/a?b=1&c=2)", "[link](javascript:void)"));
    assert.throws(() => renderArtigoEspecialHtml(jsLink, base), /URL não suportada/);
  });

  it("renderInline e formatDataPt", () => {
    assert.equal(renderInline("a *b* **c** `<d>`"), "a <em>b</em> <strong>c</strong> <code>&lt;d&gt;</code>");
    assert.deepEqual(formatDataPt("2026-03-01"), { longa: "1 de março de 2026", mes: "março de 2026" });
  });
});

describe("#9099 (a) — registro nos 5 arquivos do Worker (contra os arquivos reais)", () => {
  const reg: RegisterArticle = {
    slug: "teste-x", ano: "2026", titulo: "Título & cia", dek: "Dek.", autor: "Pixel", dataLonga: "15 de outubro de 2026", data: "2026-10-15",
  };

  it("ARTICLES ganha a entrada; 2ª chamada é no-op", () => {
    const r = registerInArticlesList(read("scripts/build-artigo-especial-teaser.ts"), reg);
    assert.ok(r.changed && r.text.includes('  { slug: "teste-x", year: "2026" },\n];'));
    assert.equal(registerInArticlesList(r.text, reg).changed, false);
  });

  it("GATED_ARTICLES ganha import + entrada; idempotente", () => {
    const r = registerInGatedArticles(read("workers/artigos/src/gated-articles.ts"), reg);
    assert.ok(r.text.includes('import { TESTE_X_FULL_HTML } from "./teste-x-full.generated.ts";'));
    assert.ok(r.text.includes('  { slug: "teste-x", year: "2026", fullHtml: TESTE_X_FULL_HTML },\n];'));
    assert.equal(registerInGatedArticles(r.text, reg).changed, false);
  });

  it("run_worker_first ganha os 2 paths, lidos pelo mesmo regex do teste #9226", () => {
    const r = registerInWranglerToml(read("workers/artigos/wrangler.toml"), reg);
    const m = r.text.match(/^run_worker_first\s*=\s*\[([\s\S]*?)\]/m)!;
    const paths = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    assert.ok(paths.includes("/2026/teste-x/") && paths.includes("/2026/teste-x/index.html"));
    assert.ok(paths.includes("/2026/o-jev/"), "não perde os existentes");
    assert.equal(registerInWranglerToml(r.text, reg).changed, false);
  });

  it("index.html: item novo no topo da lista, escapado; sitemap: url nova + lastmod da home", () => {
    const idx = registerInIndexHtml(read("workers/artigos/public/index.html"), reg).text;
    const firstLi = idx.indexOf("<li>", idx.indexOf('<ul class="article-list">'));
    assert.ok(idx.slice(firstLi, firstLi + 200).includes('href="/2026/teste-x/">Título &amp; cia</a>'));
    const sm = registerInSitemap(read("workers/artigos/public/sitemap.xml"), reg);
    assert.ok(sm.text.includes("<loc>https://especial.diar.ia.br/2026/teste-x/</loc>\n    <lastmod>2026-10-15</lastmod>"));
    assert.match(sm.text, /<loc>https:\/\/especial\.diar\.ia\.br\/<\/loc>\s*<lastmod>2026-10-15<\/lastmod>/);
    assert.equal(registerInSitemap(sm.text, reg).changed, false);
  });
});

describe("#9099 (a) — runRenderArtigoEspecialHtml ponta a ponta numa cópia do repo", () => {
  let root: string;
  const files = [
    "scripts/build-artigo-especial-teaser.ts",
    "workers/artigos/articles-src/o-jev.html",
    "workers/artigos/src/gated-articles.ts",
    "workers/artigos/wrangler.toml",
    "workers/artigos/public/index.html",
    "workers/artigos/public/sitemap.xml",
  ];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "render-artigo-9099-"));
    for (const f of files) {
      mkdirSync(resolve(root, f, ".."), { recursive: true });
      cpSync(resolve(ROOT, f), resolve(root, f));
    }
    mkdirSync(resolve(root, "data/artigo-especial/2026-teste-x"), { recursive: true });
    writeFileSync(resolve(root, "data/artigo-especial/2026-teste-x/draft.md"), DRAFT);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("sem capa → recusa antes de escrever qualquer coisa", () => {
    assert.throws(() => runRenderArtigoEspecialHtml({ root, ano: "2026", slug: "teste-x" }), (e: Error) => e instanceof RenderArtigoGuardError && /capa ausente/.test(e.message));
    assert.equal(existsSync(resolve(root, "workers/artigos/articles-src/teste-x.html")), false);
  });

  it("com capa: escreve fonte + teaser + generated e os 5 registros; 2ª rodada não muda nada", () => {
    mkdirSync(resolve(root, "workers/artigos/public/2026/teste-x"), { recursive: true });
    writeFileSync(resolve(root, "workers/artigos/public/2026/teste-x/capa.jpg"), "jpg");

    const dry = runRenderArtigoEspecialHtml({ root, ano: "2026", slug: "teste-x", dryRun: true });
    assert.equal(dry.changed.length, 8);
    assert.equal(existsSync(resolve(root, "workers/artigos/articles-src/teste-x.html")), false, "dry-run não escreve");

    const r = runRenderArtigoEspecialHtml({ root, ano: "2026", slug: "teste-x" });
    assert.deepEqual([...r.changed].sort(), [
      "scripts/build-artigo-especial-teaser.ts",
      "workers/artigos/articles-src/teste-x.html",
      "workers/artigos/public/2026/teste-x/index.html",
      "workers/artigos/public/index.html",
      "workers/artigos/public/sitemap.xml",
      "workers/artigos/src/gated-articles.ts",
      "workers/artigos/src/teste-x-full.generated.ts",
      "workers/artigos/wrangler.toml",
    ]);
    assert.ok(readFileSync(resolve(root, "workers/artigos/public/2026/teste-x/index.html"), "utf8").includes(GATE_CTA_ID));
    assert.deepEqual(runRenderArtigoEspecialHtml({ root, ano: "2026", slug: "teste-x" }).changed, []);
  });

  it("slug da chamada diferente do frontmatter → recusa", () => {
    assert.throws(
      () => runRenderArtigoEspecialHtml({ root, ano: "2026", slug: "outro", draftPath: resolve(root, "data/artigo-especial/2026-teste-x/draft.md") }),
      /frontmatter diz 2026\/teste-x/,
    );
  });
});

describe("#9099 (b) — probe da URL publicada (fetch injetado)", () => {
  const url = "https://especial.diar.ia.br/2026/teste-x/";
  const okHtml = `<meta property="og:url" content="${url}"><div id="${GATE_CTA_ID}"></div>`;
  const respond = (status: number, body = "") => ({ status, text: async () => body });

  it("assessProbeResponse: exige 200 + og:url certo + bloco do gate", () => {
    assert.equal(assessProbeResponse(url, 200, okHtml), null);
    assert.match(assessProbeResponse(url, 404, "")!, /HTTP 404/);
    assert.match(assessProbeResponse(url, 200, `<meta property="og:url" content="https://especial.diar.ia.br/">`)!, /og:url/);
    assert.match(assessProbeResponse(url, 200, `<meta property="og:url" content="${url}">`)!, /bloco do gate/);
  });

  it("deploy ainda rodando: 404, erro de rede, depois 200 → ok na 3ª tentativa, dormindo entre elas", async () => {
    const seq: Array<() => ReturnType<ProbeFetch>> = [
      async () => respond(404),
      async () => { throw new Error("ECONNRESET"); },
      async () => respond(200, okHtml),
    ];
    const urls: string[] = [];
    const sleeps: number[] = [];
    const v = await probeArtigoEspecial({
      url,
      attempts: 5,
      intervalMs: 7,
      sleep: async (ms) => { sleeps.push(ms); },
      fetchImpl: (u) => { urls.push(u); return seq.shift()!(); },
    });
    assert.deepEqual(v, { ok: true, status: 200, attempts: 3 });
    assert.deepEqual(sleeps, [7, 7]);
    assert.ok(urls.every((u) => u.startsWith(`${url}?probe=`)), "cache-buster no path do artigo");
  });

  it("esgota as tentativas → ok:false com o último motivo, sem lançar", async () => {
    const v = await probeArtigoEspecial({ url, attempts: 2, sleep: async () => {}, fetchImpl: async () => respond(200, "<html></html>") });
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.equal(v.attempts, 2);
      assert.match(v.reason, /og:url ausente/);
    }
  });
});

describe("#9099 (c) — state das etapas de produção", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "artigo-producao-9099-")); });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));
  const at = "2026-10-07T12:00:00.000Z";
  const empty: ArtigoEspecialState = { ano: "2026", slug: "x", channels: {} };

  it("next = 1ª etapa não-done; state sem producao (artigo feito à mão) começa em tema", () => {
    assert.equal(nextProducaoEtapa(empty), "tema");
    let s = withProducaoEtapa(empty, "tema", buildDoneChannelState(at, null), "Tema X");
    s = withProducaoEtapa(s, "briefing", buildDoneChannelState(at, null));
    assert.equal(nextProducaoEtapa(s), "rascunho");
    assert.equal(s.producao?.tema, "Tema X");
    s = withProducaoEtapa(s, "rascunho", buildFailedChannelState(at, "editor pediu outra tese"));
    assert.equal(nextProducaoEtapa(s), "rascunho", "failed é retentável");
  });

  it("done fora de ordem é recusado (nenhum PR sai de rascunho não aprovado)", () => {
    assert.throws(() => withProducaoEtapa(empty, "pr", buildDoneChannelState(at, "u")), /antes de "tema"/);
  });

  it("refazer uma etapa done invalida as posteriores", () => {
    let s = empty;
    for (const e of ["tema", "briefing", "rascunho", "html"] as const) s = withProducaoEtapa(s, e, buildDoneChannelState(at, null), e === "tema" ? "T" : undefined);
    s = withProducaoEtapa(s, "rascunho", buildDoneChannelState("2026-10-08T00:00:00.000Z", null));
    assert.equal(s.producao?.etapas.html, undefined);
    assert.equal(nextProducaoEtapa(s), "html");
  });

  it("CLI mark grava no published.json e uma escrita de CANAL não apaga a produção", () => {
    runMarkProducaoEtapa({ dataDir, ano: "2026", slug: "x", etapa: "tema", status: "done", tema: "Como usamos o Jev" });
    assert.throws(() => runMarkProducaoEtapa({ dataDir, ano: "2026", slug: "x", etapa: "briefing", status: "failed" }), /exige --reason/);
    assert.throws(() => runMarkProducaoEtapa({ dataDir, ano: "2026", slug: "y", etapa: "tema", status: "done" }), /exige --tema/);
    runMarkArtigoEspecialChannel({ ano: "2026", slug: "x", channel: "apoiase", status: "done", url: "https://apoia.se/p/1", dataDir });
    const s = readArtigoEspecialState(artigoEspecialStatePath(dataDir, "2026", "x"), "2026", "x");
    assert.equal(s.channels.apoiase?.status, "done");
    assert.equal(s.producao?.tema, "Como usamos o Jev");
    assert.equal(s.producao?.etapas.tema?.status, "done");
    assert.equal(nextProducaoEtapa(s), "briefing");
  });
});

describe("#9099 (c) — tema vencedor da votação", () => {
  const opcoes = [{ n: 1, titulo: "Agentes" }, { n: 2, titulo: "Como estamos usando Jev na diar.ia.br" }];
  const stats: TemaStatsLike = { ciclo: "2609", fechado: true, vencedor: 2, empate: false, opcoes };

  it("fechada com vencedor → título + descrição da cédula", () => {
    const v = resolveTemaVencedor(stats, { opcoes: [{ n: 2, titulo: opcoes[1].titulo, descricao: " Bastidores. " }] });
    assert.deepEqual(v, { ciclo: "2609", n: 2, titulo: opcoes[1].titulo, descricao: "Bastidores." });
    assert.equal(resolveTemaVencedor(stats, null).descricao, null);
  });

  it("aberta, empatada, sem voto ou cédula divergente → lança com a ação", () => {
    const cases: Array<[TemaStatsLike, RegExp]> = [
      [{ ...stats, fechado: false }, /aberta/],
      [{ ...stats, empate: true, vencedor: null }, /forcar-vencedor/],
      [{ ...stats, vencedor: null }, /sem nenhum voto/],
    ];
    for (const [s, re] of cases) assert.throws(() => resolveTemaVencedor(s, null), (e: Error) => e instanceof TemaVencedorError && re.test(e.message));
    assert.throws(() => resolveTemaVencedor(stats, { opcoes: [{ n: 2, titulo: "Outro" }] }), /difere da cédula/);
  });

  it("suggestSlug: sem acento, sem stopword, até 5 palavras", () => {
    assert.equal(suggestSlug("Engenharia de ilusão: jailbreak não tem senha"), "engenharia-ilusao-jailbreak-nao-tem");
    assert.equal(suggestSlug("O agente"), "agente");
  });
});
