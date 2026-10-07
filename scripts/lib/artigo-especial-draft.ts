/**
 * artigo-especial-draft.ts (#9099)
 *
 * Conversor PURO do rascunho de um Artigo Especial
 * (`data/artigo-especial/{ano}-{slug}/draft.md`, iterado com o editor no
 * chat) para a FONTE do artigo no Worker
 * (`workers/artigos/articles-src/{slug}.html`) — o mesmo documento que até
 * o #9099 era escrito à mão (último caso: `o-jev.html`, PR #9225).
 *
 * O HTML gerado segue o template dos artigos existentes, peça por peça:
 *   - `<head>` com title/description/canonical/favicon/og:* /twitter:* —
 *     os campos que `artigo-especial-meta.ts::parseArtigoMetaHtml` lê depois
 *     na divulgação (og:url, og:image, datePublished do JSON-LD);
 *   - a folha de estilo BASE, extraída de um artigo de referência já
 *     publicado (`extractBaseStyle`) em vez de copiada aqui — os 527 linhas
 *     de CSS que `o-agente.html` e `o-jev.html` compartilham byte a byte
 *     continuam tendo uma fonte só;
 *   - menu global (`renderSiteNav`, #8497), barra de progresso, masthead
 *     (kicker com o mês, h1, dek, meta-row), capa 2:1, sumário, manuscrito
 *     com `<p class="lede">` + seções `<h3 class="sect">` numeradas, seção
 *     de fontes, rodapé e JSON-LD `Article` (#5126);
 *   - o marcador `<!-- ESPECIAL:GATE_CUT -->` (`GATE_CUT_MARKER`) — por
 *     padrão logo antes da 2ª seção nomeada (convenção do README do
 *     Worker: teaser = abertura + 1ª seção), ou onde o rascunho pedir com
 *     uma linha `<!-- corte -->`.
 *
 * Formato do `draft.md` — frontmatter simples `chave: valor` (sem YAML
 * aninhado) + corpo em markdown restrito:
 *
 *   ---
 *   titulo: O Jev na diar.ia.br: como testei uma IA diferente
 *   dek: Um classificador que responde perguntas fechadas...
 *   slug: o-jev
 *   ano: 2026
 *   data: 2026-09-30
 *   autor: Pixel                 (opcional, default Pixel)
 *   capa_alt: Ilustração estilo Van Gogh impasto: ...
 *   capa: capa.jpg               (opcional, default capa.jpg)
 *   leitura: 9                   (opcional, minutos; default = palavras/200)
 *   atualizado: 2026-10-02       (opcional, dateModified; default = data)
 *   ---
 *
 *   1º parágrafo = lede.
 *
 *   ## O que é o Jev
 *   ## Onde ele começou: lançamento ou notícia? {toc: Onde ele começou}
 *   <!-- corte -->               (opcional — força o ponto do teaser)
 *   ## Fontes e notas de método  (heading que começa com "Fontes" vira a
 *                                 seção de fontes, fora da numeração)
 *
 * Markdown aceito no corpo: parágrafo, `- `/`1. ` (listas), `**negrito**`,
 * `*itálico*`, `` `código` ``, `[texto](url)`, e parágrafo que abre com
 * `**Rótulo.**` vira `<span class="lead-in">`. Bloco que começa com `<` é
 * HTML CRU, copiado sem escape — é a porta pra tabela/infográfico próprio
 * do artigo (o o-jev tem tabela de placar, o o-agente tem infográficos);
 * o CSS desses componentes vai num bloco `<style>` cru no próprio rascunho.
 * Todo o resto é escapado. Rótulo do sumário: `{toc: ...}` no fim do
 * heading, ou o trecho antes do 1º `:` do heading.
 */

import { escHtml } from "./html-escape.ts";
import { FAVICON_DATA_URI } from "./shared/seo-meta.ts";
import { renderSiteNav, DIARIA_APEX_URL } from "./shared/site-nav.ts";
import { GATE_CUT_MARKER } from "./shared/html-teaser-split.ts";

export const ESPECIAL_BASE_URL = "https://especial.diar.ia.br";
export const DEFAULT_AUTOR = "Pixel";
export const DEFAULT_CAPA = "capa.jpg";
/** Linha que, sozinha num bloco do rascunho, marca o ponto de corte do teaser. */
export const DRAFT_CUT_LINES = ["<!-- corte -->", GATE_CUT_MARKER] as const;
const WORDS_PER_MINUTE = 200;
const AUTHOR_URL = "https://www.linkedin.com/in/vjpixel/";

const MESES = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
] as const;

export class ArtigoEspecialDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtigoEspecialDraftError";
  }
}

export interface DraftFrontmatter {
  titulo: string;
  dek: string;
  slug: string;
  ano: string;
  /** `AAAA-MM-DD` — datePublished. */
  data: string;
  autor: string;
  capa: string;
  capaAlt: string;
  /** Minutos de leitura; `null` = calcular pelas palavras. */
  leitura: number | null;
  /** `AAAA-MM-DD` — dateModified. */
  atualizado: string;
}

export type DraftBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "raw"; html: string }
  | { kind: "cut" };

export interface DraftSection {
  /** Heading completo, como escrito (sem o `{toc: ...}`). */
  heading: string;
  tocLabel: string;
  blocks: DraftBlock[];
}

export interface ParsedDraft {
  meta: DraftFrontmatter;
  /** Blocos antes da 1ª seção — o 1º parágrafo é o lede. */
  intro: DraftBlock[];
  sections: DraftSection[];
  /** Seção de fontes (heading que começa com "Fontes"), fora da numeração. */
  sources: DraftSection | null;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── parse ──────────────────────────────────────────────────────────────

function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new ArtigoEspecialDraftError("draft.md sem frontmatter (bloco entre linhas `---` no topo).");
  const fields: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) throw new ArtigoEspecialDraftError(`frontmatter: linha sem "chave: valor" — "${line}"`);
    const key = line.slice(0, idx).trim().toLowerCase();
    fields[key] = line.slice(idx + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { fields, body: m[2] };
}

function requireField(fields: Record<string, string>, key: string): string {
  const v = fields[key];
  if (!v) throw new ArtigoEspecialDraftError(`frontmatter: campo obrigatório "${key}" ausente ou vazio.`);
  return v;
}

function validDate(value: string, key: string): string {
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T12:00:00Z`))) {
    throw new ArtigoEspecialDraftError(`frontmatter: "${key}" precisa ser AAAA-MM-DD (veio "${value}").`);
  }
  return value;
}

function toFrontmatter(fields: Record<string, string>): DraftFrontmatter {
  const slug = requireField(fields, "slug");
  if (!SLUG_RE.test(slug)) {
    throw new ArtigoEspecialDraftError(`frontmatter: slug "${slug}" inválido — só minúsculas, dígitos e hífen (ex: o-jev).`);
  }
  const ano = requireField(fields, "ano");
  if (!/^\d{4}$/.test(ano)) throw new ArtigoEspecialDraftError(`frontmatter: ano "${ano}" precisa ter 4 dígitos.`);
  const data = validDate(requireField(fields, "data"), "data");
  if (!data.startsWith(`${ano}-`)) {
    throw new ArtigoEspecialDraftError(`frontmatter: data ${data} não é do ano ${ano} — o path público é /${ano}/${slug}/.`);
  }
  let leitura: number | null = null;
  if (fields.leitura) {
    leitura = Number(fields.leitura);
    if (!Number.isInteger(leitura) || leitura <= 0) {
      throw new ArtigoEspecialDraftError(`frontmatter: leitura "${fields.leitura}" precisa ser um inteiro positivo (minutos).`);
    }
  }
  return {
    titulo: requireField(fields, "titulo"),
    dek: requireField(fields, "dek"),
    slug,
    ano,
    data,
    autor: fields.autor || DEFAULT_AUTOR,
    capa: fields.capa || DEFAULT_CAPA,
    capaAlt: requireField(fields, "capa_alt"),
    leitura,
    atualizado: fields.atualizado ? validDate(fields.atualizado, "atualizado") : data,
  };
}

function splitBlocks(body: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let inRaw = false;
  for (const line of body.split("\n")) {
    // Bloco HTML cru segue até a próxima linha em branco que NÃO esteja
    // dentro de um <style>/<table>/<div>... aberto — simplificação: um
    // bloco cru termina na 1ª linha em branco depois que as tags de abertura
    // e fechamento de nível de bloco se equilibram.
    if (line.trim() === "" && !inRaw) {
      if (current.length) blocks.push(current.join("\n"));
      current = [];
      continue;
    }
    if (current.length === 0 && line.trimStart().startsWith("<") && !isCutLine(line)) inRaw = true;
    current.push(line);
    if (inRaw && rawBalanced(current.join("\n"))) inRaw = false;
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}

const BLOCK_TAGS = ["style", "table", "div", "figure", "section", "aside", "ul", "ol", "svg", "blockquote", "details"];

function rawBalanced(html: string): boolean {
  for (const tag of BLOCK_TAGS) {
    const open = (html.match(new RegExp(`<${tag}(\\s|>)`, "gi")) ?? []).length;
    const close = (html.match(new RegExp(`</${tag}>`, "gi")) ?? []).length;
    if (open !== close) return false;
  }
  return true;
}

function isCutLine(line: string): boolean {
  return (DRAFT_CUT_LINES as readonly string[]).includes(line.trim());
}

function parseBlock(block: string): DraftBlock {
  const trimmed = block.trim();
  if (isCutLine(trimmed)) return { kind: "cut" };
  if (trimmed.startsWith("<")) return { kind: "raw", html: block.replace(/\s+$/, "") };
  const lines = trimmed.split("\n");
  if (lines.every((l) => /^[-*] /.test(l.trim()))) {
    return { kind: "ul", items: lines.map((l) => l.trim().replace(/^[-*] /, "")) };
  }
  if (lines.every((l) => /^\d+[.)] /.test(l.trim()))) {
    return { kind: "ol", items: lines.map((l) => l.trim().replace(/^\d+[.)] /, "")) };
  }
  return { kind: "paragraph", text: lines.map((l) => l.trim()).join(" ") };
}

function parseHeading(line: string): { heading: string; tocLabel: string } {
  let heading = line.replace(/^##\s+/, "").trim();
  let tocLabel: string | null = null;
  const tocMatch = heading.match(/\s*\{toc:\s*([^}]+)\}\s*$/i);
  if (tocMatch) {
    tocLabel = tocMatch[1].trim();
    heading = heading.slice(0, tocMatch.index).trim();
  }
  if (!heading) throw new ArtigoEspecialDraftError(`heading de seção vazio: "${line}"`);
  if (!tocLabel) {
    const colon = heading.indexOf(":");
    tocLabel = colon > 0 ? heading.slice(0, colon).trim() : heading;
  }
  return { heading, tocLabel };
}

/** Pura: lê o `draft.md` inteiro. Lança `ArtigoEspecialDraftError` com mensagem acionável em qualquer formato inválido. */
export function parseArtigoEspecialDraft(raw: string): ParsedDraft {
  const { fields, body } = parseFrontmatter(raw);
  const meta = toFrontmatter(fields);

  if (/^#\s/m.test(body)) {
    throw new ArtigoEspecialDraftError("draft.md: não use `# ` no corpo — o título vem do frontmatter (`titulo:`); seções são `## `.");
  }
  if (/^###\s/m.test(body)) {
    throw new ArtigoEspecialDraftError("draft.md: subseção `### ` não é suportada — use `## ` (seção numerada) ou um rótulo em negrito.");
  }

  const intro: DraftBlock[] = [];
  const sections: DraftSection[] = [];
  let sources: DraftSection | null = null;
  let target: DraftBlock[] = intro;

  // Separa por headings `## ` mantendo a ordem.
  const chunks = body.split(/^(?=##\s)/m);
  for (const chunk of chunks) {
    let content = chunk;
    if (/^##\s/.test(chunk)) {
      const nl = chunk.indexOf("\n");
      const headingLine = nl === -1 ? chunk : chunk.slice(0, nl);
      content = nl === -1 ? "" : chunk.slice(nl + 1);
      const { heading, tocLabel } = parseHeading(headingLine);
      const section: DraftSection = { heading, tocLabel, blocks: [] };
      if (/^fontes\b/i.test(heading)) {
        if (sources) throw new ArtigoEspecialDraftError("draft.md: mais de uma seção de fontes.");
        sources = section;
      } else {
        if (sources) throw new ArtigoEspecialDraftError(`draft.md: seção "${heading}" depois das fontes — as fontes fecham o artigo.`);
        sections.push(section);
      }
      target = section.blocks;
    }
    for (const b of splitBlocks(content)) target.push(parseBlock(b));
  }

  const firstIntro = intro.find((b) => b.kind !== "raw");
  if (!firstIntro || firstIntro.kind !== "paragraph") {
    throw new ArtigoEspecialDraftError("draft.md: o artigo precisa abrir com um parágrafo (o lede) antes da 1ª seção `## `.");
  }
  if (sections.length < 2) {
    throw new ArtigoEspecialDraftError(
      `draft.md: ${sections.length} seção(ões) numerada(s) — o gate precisa de pelo menos 2 (o teaser mostra a abertura + a 1ª; o resto fica para apoiadores).`,
    );
  }
  const cuts = [...intro, ...sections.flatMap((s) => s.blocks), ...(sources?.blocks ?? [])].filter((b) => b.kind === "cut").length;
  if (cuts > 1) throw new ArtigoEspecialDraftError(`draft.md: ${cuts} marcadores de corte — deixe só um.`);
  if (sources?.blocks.some((b) => b.kind === "cut")) {
    throw new ArtigoEspecialDraftError("draft.md: o corte do teaser não pode ficar dentro das fontes.");
  }
  if (intro.some((b) => b.kind === "cut")) {
    throw new ArtigoEspecialDraftError("draft.md: o corte do teaser não pode ficar antes da 1ª seção — o teaser ficaria sem nenhuma seção.");
  }

  return { meta, intro, sections, sources };
}

// ── render ─────────────────────────────────────────────────────────────

/** Pura: markdown inline restrito → HTML, com escape de todo o resto. */
export function renderInline(text: string): string {
  const tokens: string[] = [];
  const stash = (html: string): string => {
    tokens.push(html);
    return `\u0000${tokens.length - 1}\u0000`;
  };
  let s = text;
  s = s.replace(/`([^`]+)`/g, (_m, code: string) => stash(`<code>${escHtml(code)}</code>`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    if (!/^(https?:\/\/|\/|#|mailto:)/i.test(url)) {
      throw new ArtigoEspecialDraftError(`link com URL não suportada: "${url}" (use http(s)://, /, # ou mailto:).`);
    }
    return stash(`<a href="${escHtml(url)}">${renderInline(label)}</a>`);
  });
  s = escHtml(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => tokens[Number(i)]);
}

function renderParagraph(text: string, cls?: string): string {
  const leadIn = text.match(/^\*\*([^*]+)\*\*\s+([\s\S]+)$/);
  const inner = leadIn ? `<span class="lead-in">${renderInline(leadIn[1])}</span> ${renderInline(leadIn[2])}` : renderInline(text);
  return `<p${cls ? ` class="${cls}"` : ""}>${inner}</p>`;
}

function renderBlock(block: DraftBlock): string {
  switch (block.kind) {
    case "paragraph":
      return `  ${renderParagraph(block.text)}`;
    case "ul":
      return `  <ul>\n${block.items.map((i) => `    <li>${renderInline(i)}</li>`).join("\n")}\n  </ul>`;
    case "ol":
      return `  <ol>\n${block.items.map((i) => `    <li>${renderInline(i)}</li>`).join("\n")}\n  </ol>`;
    case "raw":
      return block.html;
    case "cut":
      return `    ${GATE_CUT_MARKER}`;
  }
}

/** Pura: data `AAAA-MM-DD` → "30 de setembro de 2026" / "setembro de 2026". */
export function formatDataPt(data: string): { longa: string; mes: string } {
  const [ano, mes, dia] = data.split("-").map(Number);
  const nomeMes = MESES[mes - 1];
  return { longa: `${dia} de ${nomeMes} de ${ano}`, mes: `${nomeMes} de ${ano}` };
}

function blockText(b: DraftBlock): string {
  switch (b.kind) {
    case "paragraph":
      return b.text;
    case "ul":
    case "ol":
      return b.items.join(" ");
    case "raw":
      return b.html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ");
    case "cut":
      return "";
  }
}

/** Pura: minutos de leitura estimados (palavras / 200, mínimo 1). */
export function estimateReadingMinutes(draft: ParsedDraft): number {
  const all = [...draft.intro, ...draft.sections.flatMap((s) => [{ kind: "paragraph", text: s.heading } as DraftBlock, ...s.blocks])];
  const words = all.map(blockText).join(" ").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

/** Pura: URL canônica do artigo. */
export function artigoUrl(ano: string, slug: string): string {
  return `${ESPECIAL_BASE_URL}/${ano}/${slug}/`;
}

/**
 * Pura: extrai a folha de estilo BASE (1º `<style>` do `<head>`) de um
 * artigo já publicado. Lança se o documento de referência não tiver o
 * bloco — nunca gera um artigo sem CSS.
 */
export function extractBaseStyle(referenceHtml: string): string {
  const head = referenceHtml.replace(/\r\n?/g, "\n").split(/<\/head>/i)[0];
  const m = head.match(/<style>[\s\S]*?<\/style>/i);
  if (!m || !m[0].includes(":root")) {
    throw new ArtigoEspecialDraftError("artigo de referência sem o <style> base (com :root) no <head>.");
  }
  return m[0];
}

/** CSS dos componentes que o conversor emite e que não estão na folha base
 *  (lead-in, listas do manuscrito, seção de fontes) — mesmos valores do
 *  bloco próprio do o-jev, com nomes genéricos. */
export const COMPONENT_STYLE = `<style>
  /* Componentes do conversor draft.md → HTML (#9099) */
  .manuscript ul, .manuscript ol { max-width: 60ch; padding-left: 1.4rem; margin: 0 0 1.15rem; display: grid; gap: 0.5rem; }
  .lead-in { font-family: var(--sans); font-weight: 600; font-size: 0.95em; }
  .sources { margin-top: 2.5rem; padding-top: 1.2rem; border-top: 1px solid var(--bg-raised); font-family: var(--sans); font-size: 0.85rem; line-height: 1.55; color: var(--ink-soft); }
  .sources h2 { font-size: 0.78rem; letter-spacing: 0.1em; text-transform: uppercase; margin: 0 0 0.6rem; }
  .sources ul { padding-left: 1.1rem; margin: 0; display: grid; gap: 0.4rem; }
</style>`;

const READ_PROGRESS = `<div class="read-progress" aria-hidden="true"></div>
<script>
  addEventListener('scroll', () => {
    const h = document.documentElement;
    const max = h.scrollHeight - h.clientHeight;
    document.querySelector('.read-progress').style.width =
      (max > 0 ? (h.scrollTop / max) * 100 : 0) + '%';
  }, { passive: true });
</script>`;

const BRAND = `<strong>diar<span style="color:var(--accent)">.</span>ia<span style="color:var(--accent)">.br</span></strong>`;

function sectionId(i: number): string {
  return `s${String(i + 1).padStart(2, "0")}`;
}

/**
 * Pura: monta o documento completo de `articles-src/{slug}.html` a partir
 * do rascunho já parseado + a folha base do artigo de referência.
 */
export function renderArtigoEspecialHtml(draft: ParsedDraft, baseStyle: string): string {
  const { meta } = draft;
  const url = artigoUrl(meta.ano, meta.slug);
  const image = `${url}${meta.capa}`;
  const { longa, mes } = formatDataPt(meta.data);
  const minutos = meta.leitura ?? estimateReadingMinutes(draft);
  const t = escHtml(meta.titulo);
  const d = escHtml(meta.dek);

  const hasExplicitCut = draft.sections.some((s) => s.blocks.some((b) => b.kind === "cut"));

  // Intro: 1º parágrafo vira lede.
  let ledeDone = false;
  const introHtml = draft.intro
    .map((b) => {
      if (!ledeDone && b.kind === "paragraph") {
        ledeDone = true;
        return `    ${renderParagraph(b.text, "lede")}`;
      }
      return renderBlock(b);
    })
    .join("\n");

  const sectionsHtml = draft.sections
    .map((s, i) => {
      const id = sectionId(i);
      const n = String(i + 1).padStart(2, "0");
      const parts: string[] = [];
      if (i === 1 && !hasExplicitCut) parts.push(`    ${GATE_CUT_MARKER}\n`);
      parts.push(`    <h3 class="sect" id="${id}"><span class="sect-n">${n}</span>${renderInline(s.heading)}</h3>\n`);
      parts.push(s.blocks.map(renderBlock).join("\n"));
      return parts.join("\n");
    })
    .join("\n\n");

  const tocHtml = draft.sections
    .map((s, i) => `      <a href="#${sectionId(i)}"><span class="n">${String(i + 1).padStart(2, "0")}</span>${renderInline(s.tocLabel)}</a>`)
    .join("\n");

  const sourcesHtml = draft.sources
    ? `\n\n    <section class="sources">
    <h2>${renderInline(draft.sources.heading)}</h2>
${draft.sources.blocks.map(renderBlock).join("\n")}
  </section>`
    : "";

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        "@id": `${url}#article`,
        headline: meta.titulo,
        description: meta.dek,
        url,
        mainEntityOfPage: url,
        image,
        datePublished: meta.data,
        dateModified: meta.atualizado,
        author: { "@type": "Person", name: meta.autor, url: AUTHOR_URL },
        publisher: { "@type": "Organization", name: "diar.ia.br", url: "https://diar.ia.br" },
        inLanguage: "pt-BR",
      },
    ],
  };
  // `</` dentro de JSON num <script> fecharia a tag — escapar a barra.
  const jsonLdText = JSON.stringify(jsonLd).replace(/<\//g, "<\\/");

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<meta name="description" content="${d}">
<link rel="canonical" href="${url}">
<link rel="icon" href="${FAVICON_DATA_URI}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="diar.ia.br">
<meta property="og:locale" content="pt_BR">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${escHtml(image)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
${baseStyle}
${COMPONENT_STYLE}
</head>
<body>
${renderSiteNav({ apexBase: DIARIA_APEX_URL })}

${READ_PROGRESS}

<div class="sheet">

  <div class="narrow-col">
  <div class="masthead">
    <div class="kicker">
      <span>${BRAND}: artigo especial</span>
      <span>${mes}</span>
    </div>
    <h1>${t}</h1>
    <p class="dek">${d}</p>
    <div class="meta-row">
      <span>Por ${escHtml(meta.autor)}</span>
      <span>${longa}</span>
      <span>~${minutos} min de leitura</span>
    </div>
  </div>
  </div>

  <figure class="cover">
    <img src="${escHtml(meta.capa)}" alt="${escHtml(meta.capaAlt)}" width="1600" height="800" loading="eager">
    <figcaption>Ilustração: diar.ia.br</figcaption>
  </figure>

  <nav class="toc" aria-label="Seções do artigo">
    <span class="toc-tag">Neste artigo</span>
    <div class="toc-links">
${tocHtml}
    </div>
  </nav>

  <div class="narrow-col">
  <div class="manuscript">
${introHtml}

${sectionsHtml}${sourcesHtml}
  </div>

  <footer>${escHtml(meta.autor)} é editor da ${BRAND}, newsletter diária sobre IA.</footer>

  </div>

</div>

<script type="application/ld+json">${jsonLdText}</script>

</body>
</html>
`;
}
