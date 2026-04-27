#!/usr/bin/env npx tsx
/**
 * render-newsletter-html.ts
 *
 * Pre-renders the newsletter body as Beehiiv-compatible HTML.
 * This eliminates block-by-block filling in the browser editor —
 * the agent pastes one HTML block instead of ~20 individual operations.
 *
 * Usage:
 *   npx tsx scripts/render-newsletter-html.ts <edition-dir> [--format html|json] [--out <path>]
 *
 * --format html (default): outputs HTML body content for Beehiiv Custom HTML block
 * --format json: outputs structured JSON with all parsed sections
 * --out: write to file instead of stdout
 *
 * Image references use {{IMG:filename}} placeholders. The publish agent
 * uploads images to Beehiiv CDN first, then replaces placeholders with URLs.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDestaques, buildSubtitle, type Destaque as BaseDestaque } from "./extract-destaques.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Category → emoji mapping (matches Beehiiv template) ──────────────
const CATEGORY_EMOJI: Record<string, string> = {
  REGULAÇÃO: "🧮",
  MERCADO: "💵",
  LANÇAMENTO: "🚀",
  PESQUISA: "🧪",
  FERRAMENTA: "🔧",
  PRODUTO: "📦",
  TENDÊNCIA: "📈",
  INDÚSTRIA: "🏭",
  CULTURA: "🎭",
  BRASIL: "🇧🇷",
  OPINIÃO: "💬",
  DADOS: "📊",
  CONCEITO: "💡",
  NOTÍCIA: "📰",
};

const SECTION_EMOJI: Record<string, string> = {
  PESQUISAS: "🧪",
  LANÇAMENTOS: "🚀",
  "OUTRAS NOTÍCIAS": "📰",
};

// ── Interfaces ────────────────────────────────────────────────────────
interface RenderDestaque extends BaseDestaque {
  emoji: string;
  imageFile: string;
}

interface SectionItem {
  title: string;
  description: string;
  url: string;
}

interface Section {
  name: string;
  emoji: string;
  items: SectionItem[];
}

interface EAI {
  credit: string;
  realImage: string;
  iaImage: string;
}

interface NewsletterContent {
  title: string;
  subtitle: string;
  coverImage: string;
  destaques: RenderDestaque[];
  eai: EAI;
  sections: Section[];
}

// ── Section parsing (destaques come from extract-destaques.ts) ────────

/**
 * Parse non-destaque sections from the reviewed newsletter.
 * Uses URL-anchored parsing: each item ends at a URL line.
 * Lines between URL boundaries are grouped as title + description.
 */
export function parseSections(text: string): Section[] {
  const blocks = text.split(/^---$/m).map((s) => s.trim()).filter(Boolean);
  const sections: Section[] = [];

  for (const block of blocks) {
    const sectionMatch = block.match(/^(PESQUISAS|LANÇAMENTOS|OUTRAS NOTÍCIAS)$/m);
    if (!sectionMatch) continue;

    const name = sectionMatch[1];
    const emoji = SECTION_EMOJI[name] || "📰";
    const afterHeader = block.replace(/^(PESQUISAS|LANÇAMENTOS|OUTRAS NOTÍCIAS)$/m, "").trim();
    const items = parseListItems(afterHeader);
    if (items.length > 0) {
      sections.push({ name, emoji, items });
    }
  }

  return sections;
}

/**
 * Parse list items from a section body.
 *
 * Layout per item pós-#172 (URL imediatamente abaixo do título):
 *   Título
 *   https://url
 *   Descrição em 1 frase
 *   <linha em branco>
 *
 * Layout legacy (pré-#172):
 *   Título
 *   Descrição em 1 frase
 *   https://url
 *   <linha em branco>
 *
 * Estratégia: separa o body em blocos por linhas em branco. Cada bloco
 * é um item. Dentro do bloco, a URL pode estar na linha 2 (novo) ou na
 * última (legacy). Título é sempre block[0]. Descrição é o resto.
 */
export function parseListItems(text: string): SectionItem[] {
  const rawLines = text.split(/\r?\n/);
  const items: SectionItem[] = [];

  // Separa em blocos por linhas em branco.
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const raw of rawLines) {
    if (raw.trim() === "") {
      if (current.length > 0) {
        blocks.push(current);
        current = [];
      }
      continue;
    }
    current.push(raw.trim());
  }
  if (current.length > 0) blocks.push(current);

  for (const block of blocks) {
    if (block.length === 0) continue;

    // Encontra URL no bloco
    const urlIdx = block.findIndex((l) => /^https?:\/\//.test(l));

    if (urlIdx === -1) {
      // Bloco sem URL — emite item incompleto preservando título + descrição.
      items.push({
        title: block[0],
        description: block.slice(1).join(" "),
        url: "",
      });
      continue;
    }

    if (urlIdx === 0) {
      // URL na primeira linha — sem título acima. Skip (ou poderia ser um
      // item órfão que o editor removeu o título; melhor não inventar).
      continue;
    }

    const title = block[0];
    const url = block[urlIdx];
    // Descrição = todas as outras linhas (entre título e URL + depois da URL).
    // Em formato novo: urlIdx == 1, descrição vem depois (block[2..]).
    // Em formato legacy: urlIdx == block.length-1, descrição vem antes (block[1..urlIdx-1]).
    const before = block.slice(1, urlIdx);
    const after = block.slice(urlIdx + 1);
    const descriptionParts = after.length > 0 ? [...after, ...before] : [...before];
    const description = descriptionParts.join(" ");

    items.push({ title, description, url });
  }

  return items;
}

function parseEAI(text: string): EAI {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const credit = lines.filter((l) => !l.startsWith("É IA?")).join("\n").trim();

  return {
    credit,
    realImage: "01-eai-real.jpg",
    iaImage: "01-eai-ia.jpg",
  };
}

function extractContent(editionDir: string): NewsletterContent {
  const reviewedPath = resolve(editionDir, "02-reviewed.md");
  const eaiPath = resolve(editionDir, "01-eai.md");

  if (!existsSync(reviewedPath)) {
    throw new Error(`${reviewedPath} not found — run Stage 2 first`);
  }

  const reviewedText = readFileSync(reviewedPath, "utf8");

  // Destaques: use shared parser from extract-destaques.ts (single source of truth)
  const baseDestaques = parseDestaques(reviewedText);
  if (baseDestaques.length !== 3) {
    throw new Error(`Expected 3 destaques, got ${baseDestaques.length}`);
  }

  // Enrich with emoji + image file mapping
  const destaques: RenderDestaque[] = baseDestaques.map((d) => ({
    ...d,
    emoji: CATEGORY_EMOJI[d.category] || "📌",
    imageFile: d.n === 1 ? "04-d1-2x1.jpg" : `04-d${d.n}.jpg`,
  }));

  // Sections: parsed here (extract-destaques doesn't handle these)
  const sections = parseSections(reviewedText);

  // É IA?
  const eai = existsSync(eaiPath)
    ? parseEAI(readFileSync(eaiPath, "utf8"))
    : { credit: "", realImage: "01-eai-real.jpg", iaImage: "01-eai-ia.jpg" };

  return {
    title: destaques[0].title,
    subtitle: buildSubtitle(destaques[1].title, destaques[2].title),
    coverImage: "04-d1-2x1.jpg",
    destaques,
    eai,
    sections,
  };
}

// ── HTML Rendering ────────────────────────────────────────────────────
// Produces email-safe HTML matching Beehiiv's Default template styling.
// Uses inline styles, table layout, Poppins/Inter fonts.

const TEAL = "#00A0A0";
const TEXT_COLOR = "#1A1A1A";
const FONT_HEADING = "'Poppins', Helvetica, sans-serif";
const FONT_BODY = "'Inter', -apple-system, BlinkMacSystemFont, Roboto, sans-serif";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Process markdown links [text](url) to <a> tags, escaping surrounding text */
function processInlineLinks(s: string): string {
  const parts: string[] = [];
  let lastIdx = 0;
  const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > lastIdx) parts.push(esc(s.substring(lastIdx, m.index)));
    parts.push(
      `<a href="${esc(m[2])}" style="color:${TEXT_COLOR};text-decoration:underline;font-weight:bold;" target="_blank" rel="noopener noreferrer nofollow">${esc(m[1])}</a>`
    );
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < s.length) parts.push(esc(s.substring(lastIdx)));
  return parts.join("");
}

function renderSpacer(height = 20): string {
  return `<tr><td height="${height}px" style="line-height:1px;font-size:1px;height:${height}px;">&nbsp;</td></tr>`;
}

function renderCategoryLabel(emoji: string, category: string): string {
  return `<tr><td align="left" valign="top" style="color:${TEXT_COLOR};font-weight:500;padding:0px 2px;text-align:left;">
  <h6 style="font-family:${FONT_HEADING};color:${TEXT_COLOR};font-weight:500;font-size:14px;line-height:0.875;padding:0;margin:0;">${emoji} <span style="color:${TEAL};">${esc(category)}</span></h6>
</td></tr>`;
}

function renderTitle(title: string, url: string): string {
  return `<tr><td align="left" valign="top" style="color:${TEXT_COLOR};font-weight:500;padding:0px 2px;text-align:left;">
  <h1 style="font-family:${FONT_HEADING};color:${TEXT_COLOR};font-weight:500;font-size:24px;line-height:1.75;padding-bottom:4px;padding-top:16px;margin:0;">
    <span style="text-decoration:underline;"><a href="${esc(url)}" style="color:${TEXT_COLOR} !important;font-weight:bold;text-decoration:underline;" target="_blank" rel="noopener noreferrer nofollow"><span>${esc(title)}</span></a></span>
  </h1>
</td></tr>`;
}

function renderImage(placeholder: string, alt = "", caption = "Criada com Gemini"): string {
  return `<tr><td align="center" valign="top" style="padding:2px;">
  <table role="none" border="0" cellspacing="0" cellpadding="0" style="margin:0 auto;">
    <tr><td align="center" valign="top" style="width:578px;">
      <img src="{{IMG:${placeholder}}}" alt="${esc(alt)}" width="578" style="display:block;width:100%;height:auto;" border="0"/>
    </td></tr>
    <tr><td align="center" valign="top" style="width:578px;padding:4px 0;">
      <p style="font-family:${FONT_BODY};font-size:14px;color:#666;margin:0;">${esc(caption)}</p>
    </td></tr>
  </table>
</td></tr>`;
}

function renderImageNoCaption(placeholder: string, alt = ""): string {
  return `<tr><td align="center" valign="top" style="padding:2px;">
  <table role="none" border="0" cellspacing="0" cellpadding="0" style="margin:0 auto;">
    <tr><td align="center" valign="top" style="width:578px;">
      <img src="{{IMG:${placeholder}}}" alt="${esc(alt)}" width="578" style="display:block;width:100%;height:auto;" border="0"/>
    </td></tr>
  </table>
</td></tr>`;
}

function renderParagraphs(text: string): string {
  return text
    .split(/\n\n+/)
    .filter((p) => p.trim())
    .map(
      (p) =>
        `<tr><td align="left" style="padding:0px 2px;text-align:left;word-break:break-word;">
  <p style="font-family:${FONT_BODY};font-weight:400;color:${TEXT_COLOR};font-size:16px;line-height:1.5;padding:12px 0;margin:0;">${esc(p.trim())}</p>
</td></tr>`
    )
    .join("\n");
}

function renderWhyHeading(): string {
  // #113: "Por que isso importa:" precisa destaque visual — é o gancho
  // editorial. Aumentei pra h3 com 20px bold (era h5 16px).
  return `<tr><td align="left" style="padding:0px 2px;text-align:left;">
  <h3 style="font-family:${FONT_HEADING};color:${TEXT_COLOR};font-weight:700;font-size:20px;line-height:1.3;padding-top:20px;padding-bottom:4px;margin:0;">Por que isso importa:</h3>
</td></tr>`;
}

function renderDestaque(d: RenderDestaque): string {
  // #113: d1 image NÃO aparece inline pra evitar duplicar com a cover do post
  // (Beehiiv usa 04-d1-2x1.jpg como thumbnail/cover). d2 e d3 mantêm imagem
  // inline porque não têm slot de cover.
  const showInlineImage = d.n !== 1;
  return `<!-- Destaque ${d.n} -->
<tr><td>
<table role="none" width="100%" border="0" cellspacing="0" cellpadding="0">
  ${renderSpacer()}
  <tr><td style="background-color:transparent;border:1px solid ${TEAL};border-radius:50px;padding:40px;">
    <table role="none" width="100%" border="0" cellspacing="0" cellpadding="0">
      ${renderCategoryLabel(d.emoji, d.category)}
      ${renderTitle(d.title, d.url)}
      ${showInlineImage ? renderImage(d.imageFile) : ""}
      ${renderParagraphs(d.body)}
      ${renderWhyHeading()}
      ${renderParagraphs(d.why)}
    </table>
  </td></tr>
  ${renderSpacer()}
</table>
</td></tr>`;
}

function renderEAI(eai: EAI): string {
  const creditHtml = processInlineLinks(eai.credit);

  return `<!-- É IA? -->
<tr><td>
<table role="none" width="100%" border="0" cellspacing="0" cellpadding="0">
  ${renderSpacer()}
  <tr><td style="background-color:transparent;border:1px solid ${TEAL};border-radius:50px;padding:40px;">
    <table role="none" width="100%" border="0" cellspacing="0" cellpadding="0">
      ${renderCategoryLabel("🖼️", "É IA?")}
      ${renderImageNoCaption(eai.realImage, "Foto real")}
      ${renderImageNoCaption(eai.iaImage, "Foto gerada por IA")}
      <tr><td align="left" style="padding:0px 2px;text-align:left;word-break:break-word;">
        <p style="font-family:${FONT_BODY};font-weight:400;color:${TEXT_COLOR};font-size:14px;line-height:1.5;padding:12px 0;margin:0;">${creditHtml}</p>
      </td></tr>
    </table>
  </td></tr>
  ${renderSpacer()}
</table>
</td></tr>`;
}

/** Render a single section item as its own table row(s) */
function renderSectionItem(item: SectionItem): string {
  const titleHtml = item.url
    ? `<a href="${esc(item.url)}" style="color:${TEXT_COLOR} !important;text-decoration:underline;font-weight:bold;" target="_blank" rel="noopener noreferrer nofollow"><b>${esc(item.title)}</b></a>`
    : `<b>${esc(item.title)}</b>`;

  const titleRow = `<tr><td align="left" style="padding:0px 2px;text-align:left;word-break:break-word;">
  <p style="font-family:${FONT_BODY};font-weight:400;color:${TEXT_COLOR};font-size:16px;line-height:1.5;padding:12px 0 ${item.description ? "4px" : "12px"};margin:0;">${titleHtml}</p>
</td></tr>`;

  if (!item.description) return titleRow;

  const descRow = `<tr><td align="left" style="padding:0px 2px;text-align:left;word-break:break-word;">
  <p style="font-family:${FONT_BODY};font-weight:400;color:${TEXT_COLOR};font-size:16px;line-height:1.5;padding:4px 0 12px;margin:0;">${esc(item.description)}</p>
</td></tr>`;

  return titleRow + "\n" + descRow;
}

function renderSection(section: Section): string {
  const itemsHtml = section.items.map(renderSectionItem).join("\n");

  return `<!-- ${section.name} -->
<tr><td>
<table role="none" width="100%" border="0" cellspacing="0" cellpadding="0">
  ${renderSpacer()}
  <tr><td style="background-color:transparent;border:1px solid ${TEAL};border-radius:50px;padding:40px;">
    <table role="none" width="100%" border="0" cellspacing="0" cellpadding="0">
      ${renderCategoryLabel(section.emoji, section.name)}
      ${itemsHtml}
    </table>
  </td></tr>
  ${renderSpacer()}
</table>
</td></tr>`;
}

function renderHTML(content: NewsletterContent): string {
  const parts: string[] = [];

  for (const d of content.destaques) {
    parts.push(renderDestaque(d));
  }

  if (content.eai.credit) {
    parts.push(renderEAI(content.eai));
  }

  for (const section of content.sections) {
    parts.push(renderSection(section));
  }

  return `<!-- Diar.ia newsletter body — auto-generated by render-newsletter-html.ts -->
<!-- Image placeholders: {{IMG:filename}} — replace with CDN URLs before pasting -->
<table role="none" width="100%" border="0" cellspacing="0" cellpadding="0">
${parts.join("\n")}
</table>`;
}

// ── Main ──────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const editionDir = args.find((a) => !a.startsWith("--"));
  const format = args.includes("--format") ? args[args.indexOf("--format") + 1] : "html";
  const outIdx = args.indexOf("--out");
  const outPath = outIdx !== -1 ? args[outIdx + 1] : null;

  if (!editionDir) {
    console.error("Usage: npx tsx scripts/render-newsletter-html.ts <edition-dir> [--format html|json] [--out <path>]");
    process.exit(1);
  }

  const resolvedDir = resolve(ROOT, editionDir);
  const content = extractContent(resolvedDir);

  let output: string;
  if (format === "json") {
    output = JSON.stringify(content, null, 2);
  } else {
    output = renderHTML(content);
  }

  if (outPath) {
    writeFileSync(resolve(ROOT, outPath), output + "\n");
    console.error(`Written to ${outPath}`);
  } else {
    process.stdout.write(output);
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
