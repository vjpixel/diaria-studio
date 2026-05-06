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
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts"; // #535
import { parseInlineLink } from "./lib/inline-link.ts"; // #599

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

export interface EIA {
  credit: string;
  imageA: string;
  imageB: string;
  /** Linha "Resultado da última edição: X%..." auto-injetada por eia-compose (#107). */
  prevResultLine?: string;
  /** Código da edição (AAMMDD), usado nos botões de votação (#465). */
  edition: string;
}

interface NewsletterContent {
  title: string;
  subtitle: string;
  coverImage: string;
  destaques: RenderDestaque[];
  eia: EIA;
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

    // #599 — formato inline: primeira linha é `[título](URL)`. Resto vira descrição.
    const firstInlineLink = parseInlineLink(block[0]);
    if (firstInlineLink) {
      items.push({
        title: firstInlineLink.title,
        url: firstInlineLink.url,
        description: block.slice(1).join(" "),
      });
      continue;
    }

    // Indices de http-lines no bloco
    const urlIndices: number[] = [];
    for (let k = 0; k < block.length; k++) {
      if (/^https?:\/\//.test(block[k])) urlIndices.push(k);
    }

    if (urlIndices.length === 0) {
      // Bloco sem URL — emite item incompleto preservando título + descrição.
      items.push({
        title: block[0],
        description: block.slice(1).join(" "),
        url: "",
      });
      continue;
    }

    // M1: bloco com >1 URL = vários items colapsados (LLM esqueceu blank).
    // Detectar formato pela posição da primeira URL:
    //   - Novo (#172): primeira URL no índice 1 → ordem [Título, URL, Desc, Título, URL, Desc, ...]
    //   - Legacy: primeira URL no índice ≥2 → ordem [Título, Desc, URL, Título, Desc, URL, ...]
    // Quebrar em sub-items honrando a ordem detectada.
    if (urlIndices.length > 1) {
      const isNewFormat = urlIndices[0] === 1;
      if (isNewFormat) {
        for (let k = 0; k < urlIndices.length; k++) {
          const urlAt = urlIndices[k];
          const titleIdx = urlAt - 1;
          if (titleIdx < 0) continue;
          const nextItemStart = k + 1 < urlIndices.length ? urlIndices[k + 1] - 1 : block.length;
          const descLines = block.slice(urlAt + 1, nextItemStart);
          items.push({
            title: block[titleIdx],
            url: block[urlAt],
            description: descLines.join(" "),
          });
        }
      } else {
        // Legacy: cada item é [Título, ...Desc..., URL]
        let prevEnd = -1;
        for (const u of urlIndices) {
          const sub = block.slice(prevEnd + 1, u + 1);
          if (sub.length === 0) continue;
          const url = sub[sub.length - 1];
          const title = sub[0];
          const description = sub.slice(1, sub.length - 1).join(" ");
          items.push({ title, url, description });
          prevEnd = u;
        }
      }
      continue;
    }

    // 1 URL única no bloco — caminho comum.
    const urlIdx = urlIndices[0];

    if (urlIdx === 0) {
      // URL na primeira linha — sem título acima. Pula com warning visível.
      console.error(
        `[parseListItems] item órfão (URL sem título): ${block[0]}`,
      );
      continue;
    }

    const item = subBlockToItem(block);
    if (item) items.push(item);
  }

  return items;
}

/**
 * Converte um sub-bloco {títuloN linhas, URL, descriçãoN linhas} em item.
 * Aceita ambos os layouts (URL após título OU URL no fim).
 */
function subBlockToItem(block: string[]): SectionItem | null {
  if (block.length === 0) return null;

  const urlIdx = block.findIndex((l) => /^https?:\/\//.test(l));
  if (urlIdx === -1) {
    return {
      title: block[0],
      description: block.slice(1).join(" "),
      url: "",
    };
  }
  if (urlIdx === 0) return null;

  const title = block[0];
  const url = block[urlIdx];
  const before = block.slice(1, urlIdx);
  const after = block.slice(urlIdx + 1);
  const descriptionParts = after.length > 0 ? [...after, ...before] : [...before];
  return { title, description: descriptionParts.join(" "), url };
}

export function fallbackEIA(editionDir: string): EIA {
  const edition = editionDir.match(/(\d{6})[/\\]?$/)?.[1] ?? "";
  const newA = resolve(editionDir, "01-eia-A.jpg");
  const newB = resolve(editionDir, "01-eia-B.jpg");
  if (existsSync(newA) && existsSync(newB)) {
    return { credit: "", imageA: "01-eia-A.jpg", imageB: "01-eia-B.jpg", edition };
  }
  return { credit: "", imageA: "01-eia-real.jpg", imageB: "01-eia-ia.jpg", edition };
}

export function parseEIA(text: string, editionDir: string): EIA {
  // Pula frontmatter YAML se presente (#192 — eia_answer mapping é só pra editor).
  let body = text;
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (fmMatch) {
    body = fmMatch[2];
  }
  const allLines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);

  // Separa a linha "Resultado da última edição:" (#107) do crédito — vai
  // pra um `<p>` próprio em renderEIA; misturada no mesmo paragráfo do
  // crédito vira ilegível no email final.
  const creditLines: string[] = [];
  let prevResultLine: string | undefined;
  for (const l of allLines) {
    if (l.startsWith("É IA?")) continue;
    if (/^Resultado da última edição:/i.test(l)) {
      prevResultLine = l.trim();
    } else {
      creditLines.push(l);
    }
  }
  const credit = creditLines.join("\n").trim();

  // Extrai código da edição (AAMMDD) do caminho do diretório (#465).
  const edition = editionDir.match(/(\d{6})[/\\]?$/)?.[1] ?? "";

  // #192: novo padrão é 01-eia-A.jpg / 01-eia-B.jpg (random).
  // Fallback: edições antigas têm 01-eia-real.jpg / 01-eia-ia.jpg (real sempre primeiro).
  const newA = resolve(editionDir, "01-eia-A.jpg");
  const newB = resolve(editionDir, "01-eia-B.jpg");
  if (existsSync(newA) && existsSync(newB)) {
    return { credit, prevResultLine, imageA: "01-eia-A.jpg", imageB: "01-eia-B.jpg", edition };
  }
  return { credit, prevResultLine, imageA: "01-eia-real.jpg", imageB: "01-eia-ia.jpg", edition };
}

function extractContent(editionDir: string): NewsletterContent {
  const reviewedPath = resolve(editionDir, "02-reviewed.md");
  const eiaPath = resolve(editionDir, "01-eia.md");

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
    imageFile: d.n === 1 ? "04-d1-2x1.jpg" : `04-d${d.n}-1x1.jpg`,
  }));

  // Sections: parsed here (extract-destaques doesn't handle these)
  const sections = parseSections(reviewedText);

  // É IA?
  const eia = existsSync(eiaPath)
    ? parseEIA(readFileSync(eiaPath, "utf8"), editionDir)
    : fallbackEIA(editionDir);

  return {
    title: destaques[0].title,
    subtitle: buildSubtitle(destaques[1].title, destaques[2].title),
    coverImage: "04-d1-2x1.jpg",
    destaques,
    eia,
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
const POLL_WORKER_URL = process.env.POLL_WORKER_URL ?? "https://diar-ia-poll.diaria.workers.dev";

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

function imageGeneratorCredit(): string {
  try {
    const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
    const gen = cfg.image_generator ?? "gemini";
    const credits: Record<string, string> = {
      gemini:     "Criada com Gemini",
      openai:     "Criada com gpt-image-2",
      cloudflare: "Criada com Cloudflare FLUX",
      comfyui:    "Criada com ComfyUI",
    };
    return credits[gen] ?? "Criada com IA";
  } catch {
    return "Criada com IA";
  }
}

function renderImage(placeholder: string, alt = "", caption = imageGeneratorCredit()): string {
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

function renderEIA(eia: EIA): string {
  const creditHtml = processInlineLinks(eia.credit);
  const paragraphStyle = `font-family:${FONT_BODY};font-weight:400;color:${TEXT_COLOR};font-size:14px;line-height:1.5;padding:12px 0;margin:0;`;
  const cellStyle = `padding:0px 2px;text-align:left;word-break:break-word;`;

  // #107: linha "Resultado da última edição: X%..." auto-injetada pelo eia-compose
  // vai num `<p>` próprio (visualmente separado do crédito) — caso contrário ficaria
  // emendada no mesmo parágrafo no email final.
  const prevResultRow = eia.prevResultLine
    ? `      <tr><td align="left" style="${cellStyle}">
        <p style="${paragraphStyle}">${esc(eia.prevResultLine)}</p>
      </td></tr>`
    : "";

  // #192: alt text usa A/B em vez de "Foto real"/"Foto gerada por IA" pra não
  // revelar a resposta no HTML/accessibility tools. Mapping real↔IA fica em
  // `01-eia.md` (frontmatter, leitura humana) e `_internal/01-eia-meta.json`.

  // #465: botões de votação via merge tag do Beehiiv.
  // {{ subscriber.email }} é substituído pelo Beehiiv no envio — NÃO aplicar esc() na URL completa.
  const voteButtonsRow = eia.edition
    ? `      <tr><td align="center" style="${cellStyle};padding:16px 2px;">
        <table role="none" border="0" cellspacing="0" cellpadding="0" style="margin:0 auto;">
          <tr>
            <td style="padding:0 8px;">
              <a href="${POLL_WORKER_URL}/vote?email={{ subscriber.email }}&edition=${esc(eia.edition)}&choice=A"
                 style="display:inline-block;font-family:${FONT_BODY};font-size:14px;color:${TEAL};border:2px solid ${TEAL};border-radius:50px;padding:10px 24px;text-decoration:none;font-weight:600;"
                 target="_blank" rel="noopener noreferrer">Votar A</a>
            </td>
            <td style="padding:0 8px;">
              <a href="${POLL_WORKER_URL}/vote?email={{ subscriber.email }}&edition=${esc(eia.edition)}&choice=B"
                 style="display:inline-block;font-family:${FONT_BODY};font-size:14px;color:${TEAL};border:2px solid ${TEAL};border-radius:50px;padding:10px 24px;text-decoration:none;font-weight:600;"
                 target="_blank" rel="noopener noreferrer">Votar B</a>
            </td>
          </tr>
        </table>
      </td></tr>`
    : "";

  return `<!-- É IA? -->
<tr><td>
<table role="none" width="100%" border="0" cellspacing="0" cellpadding="0">
  ${renderSpacer()}
  <tr><td style="background-color:transparent;border:1px solid ${TEAL};border-radius:50px;padding:40px;">
    <table role="none" width="100%" border="0" cellspacing="0" cellpadding="0">
      ${renderCategoryLabel("🖼️", "É IA?")}
      ${renderImageNoCaption(eia.imageA, "Imagem A")}
      ${renderImageNoCaption(eia.imageB, "Imagem B")}
${voteButtonsRow}
      <tr><td align="left" style="${cellStyle}">
        <p style="${paragraphStyle}">${creditHtml}</p>
      </td></tr>
${prevResultRow}
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

  if (content.eia.credit) {
    parts.push(renderEIA(content.eia));
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
  const { values } = parseCliArgs(args); // #535: fix indexOf+1 bug
  const format = values["format"] ?? "html";
  const outPath = values["out"] ?? null;

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
