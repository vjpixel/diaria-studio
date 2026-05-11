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

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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
  /** #1076: bloco 🎁 SORTEIO parseado do reviewed.md (texto bruto, ou null se ausente). */
  sorteio?: string | null;
  /** #1076: bloco 🙋🏼‍♀️ PARA ENCERRAR parseado do reviewed.md. */
  encerrar?: string | null;
}

// ── Section parsing (destaques come from extract-destaques.ts) ────────

/**
 * Parse non-destaque sections from the reviewed newsletter.
 * Uses URL-anchored parsing: each item ends at a URL line.
 * Lines between URL boundaries are grouped as title + description.
 */
/**
 * Pure (#1076): extrai bloco SORTEIO ou PARA ENCERRAR do reviewed.md. Retorna
 * texto bruto pós-header (markdown), null se ausente. Caller passa o
 * marker (ex: "🎁 SORTEIO" ou "🙋🏼‍♀️ PARA ENCERRAR").
 *
 * Procura `**{marker}**` como linha de header, captura tudo até o próximo
 * `---` ou fim do MD. Aceita tanto a forma com bold (`**...**`) quanto sem.
 */
export function extractTemplateBlock(text: string, marker: string): string | null {
  // Escape marker pra regex (emojis + word chars; safe)
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // JS regex não tem \Z — usa lookahead `^---$` ou fim de string via slice.
  const headerRe = new RegExp(`^(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*$`, "m");
  const headerMatch = headerRe.exec(text);
  if (!headerMatch) return null;
  const after = text.slice(headerMatch.index + headerMatch[0].length);
  const splitRe = /^---\s*$/m;
  const splitMatch = splitRe.exec(after);
  const block = splitMatch ? after.slice(0, splitMatch.index) : after;
  const trimmed = block.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseSections(text: string): Section[] {
  const blocks = text.split(/^---$/m).map((s) => s.trim()).filter(Boolean);
  const sections: Section[] = [];

  for (const block of blocks) {
    // #1077 — aceitar tanto `SECTION` quanto `**SECTION**` (writer agent sempre
    // gera com markdown bold; regex antiga só pegava sem formatação).
    const sectionMatch = block.match(/^(?:\*\*)?(PESQUISAS|LANÇAMENTOS|OUTRAS NOTÍCIAS)(?:\*\*)?$/m);
    if (!sectionMatch) continue;

    const name = sectionMatch[1];
    const emoji = SECTION_EMOJI[name] || "📰";
    const afterHeader = block.replace(/^(?:\*\*)?(PESQUISAS|LANÇAMENTOS|OUTRAS NOTÍCIAS)(?:\*\*)?$/m, "").trim();
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

  // #1076: blocos fixos do template Beehiiv (SORTEIO + PARA ENCERRAR).
  // Quando ausentes (edição antiga, ou pixel preferiu omitir), graceful skip.
  const sorteio = extractTemplateBlock(reviewedText, "🎁 SORTEIO");
  const encerrar = extractTemplateBlock(reviewedText, "🙋🏼‍♀️ PARA ENCERRAR");

  return {
    title: destaques[0].title,
    subtitle: buildSubtitle(destaques[1].title, destaques[2].title),
    coverImage: "04-d1-2x1.jpg",
    destaques,
    eia,
    sections,
    sorteio,
    encerrar,
  };
}

// ── HTML Rendering ────────────────────────────────────────────────────
// Produces email-safe HTML matching Beehiiv's Default template styling.
// Uses inline styles, table layout, Poppins/Inter fonts.

const TEAL = "#00A0A0";
const TEXT_COLOR = "#1A1A1A";
const MUTED = "#666666";
const RULE = "#E5E5E5";
// #1085: design "editorial-magazine" adotado como padrão (2026-05-11).
// Fonte única Inter em todo o email — sem Poppins/serif. Hierarquia via
// font-size + weight + uppercase kickers.
const FONT_HEADING = "'Inter', -apple-system, BlinkMacSystemFont, Roboto, sans-serif";
const FONT_BODY = "'Inter', -apple-system, BlinkMacSystemFont, Roboto, sans-serif";
// #1083: URL montada inline com edition literal + merge tags Beehiiv
// (`{{email}}` reserved field + `{{poll_sig}}` custom field). poll_sig é
// HMAC(email) permanente, populado 1x pelo inject-poll-sig.ts.
// Sintaxe Beehiiv: SEM espaços, SEM prefix `subscriber.` ou `custom_fields.`
// (validado contra docs oficiais 2026-05-11).
const POLL_WORKER_URL = "https://diar-ia-poll.diaria.workers.dev";

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

function renderCategoryLabel(_emoji: string, category: string): string {
  // #1085: kicker minimalista — uppercase + letterspacing em vez de h6 grande.
  // String `category` já vem com emoji prefixado (ex: "🚀 LANÇAMENTO").
  return `<tr><td align="left" valign="top" style="padding:0px 2px;text-align:left;">
  <p style="font-family:${FONT_BODY};color:${TEAL};font-weight:600;text-transform:uppercase;letter-spacing:2px;font-size:16px;margin:0 0 12px 0;padding:0;">${esc(category)}</p>
</td></tr>`;
}

function renderTitle(title: string, url: string): string {
  // #1085: h1 30px Inter font-weight 400 + border-bottom 2px solid teal
  // (email-safe substitute pra text-decoration-color, que Gmail strip).
  return `<tr><td align="left" valign="top" style="padding:0px 2px;text-align:left;">
  <h1 style="font-family:${FONT_HEADING};color:${TEXT_COLOR};font-weight:400;font-size:30px;line-height:1.2;letter-spacing:-0.5px;margin:0 0 20px 0;padding:0;">
    <a href="${esc(url)}" style="color:${TEXT_COLOR};text-decoration:none;border-bottom:2px solid ${TEAL};padding-bottom:2px;" target="_blank" rel="noopener noreferrer nofollow">${esc(title)}</a>
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
  // #1085: border-radius:6px na imagem; caption italic cinza alinhada à direita.
  return `<tr><td align="left" valign="top" style="padding:0 2px;">
  <img src="{{IMG:${placeholder}}}" alt="${esc(alt)}" width="100%" style="display:block;width:100%;height:auto;border-radius:6px;margin:0 0 8px 0;" border="0"/>
  <p style="font-family:${FONT_BODY};font-size:16px;color:${MUTED};font-style:italic;margin:0 0 20px 0;padding:0;text-align:right;">${esc(caption)}</p>
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
  <p style="font-family:${FONT_BODY};font-weight:400;color:${TEXT_COLOR};font-size:16px;line-height:1.6;margin:0 0 14px 0;padding:0;">${esc(p.trim())}</p>
</td></tr>`
    )
    .join("\n");
}

function renderWhyBlock(text: string): string {
  // #1085: "Por que isso importa" como pull-quote inline — table com
  // border-left teal, parágrafo em itálico cinza. Em vez de h3 grande +
  // parágrafos depois (legacy renderWhyHeading), agrega ambos em um único
  // bloco editorial estilo magazine.
  const body = text.split(/\n\n+/).filter((p) => p.trim()).map((p) => esc(p.trim())).join("<br><br>");
  return `<tr><td align="left" style="padding:0px 2px;text-align:left;word-break:break-word;">
  <table role="none" border="0" cellspacing="0" cellpadding="0" width="100%"><tr><td style="border-left:3px solid ${TEAL};padding:4px 0 4px 16px;">
    <p style="font-family:${FONT_BODY};color:#444444;font-size:16px;line-height:1.6;font-style:italic;margin:0;padding:0;"><b style="color:${TEXT_COLOR};font-style:normal;">Por que isso importa.</b> ${body}</p>
  </td></tr></table>
</td></tr>`;
}

function renderRule(thick = false): string {
  // #1085: separador horizontal entre blocos editoriais. `thick` = 2px (entre
  // destaques e seções/pesquisa); fino = 1px (entre destaques).
  const border = thick ? `2px solid ${TEXT_COLOR}` : `1px solid ${RULE}`;
  return `<tr><td style="padding:36px 2px 0 2px;"><hr style="border:0;border-top:${border};margin:0;"/></td></tr>`;
}

function renderTopPadding(): string {
  return `<tr><td style="padding:32px 2px 0 2px;font-size:1px;line-height:1px;">&nbsp;</td></tr>`;
}

function renderDestaque(d: RenderDestaque): string {
  // #1085: sem box ciano — destaques separados por <hr> finos. Mantém
  // imagem inline em D1 (cover) e D2/D3 sem (#1077, memory
  // feedback_newsletter_only_d1_image.md). Estrutura "magazine" editorial:
  // kicker → h1 → cover (se D1) → parágrafos → blockquote "Por que importa".
  const showInlineImage = d.n === 1;
  return `<!-- Destaque ${d.n} -->
${renderTopPadding()}
${renderCategoryLabel(d.emoji, d.category)}
${renderTitle(d.title, d.url)}
${showInlineImage ? renderImage(d.imageFile) : ""}
${renderParagraphs(d.body)}
${renderWhyBlock(d.why)}`;
}

function renderEIA(eia: EIA): string {
  const creditHtml = processInlineLinks(eia.credit);
  const paragraphStyle = `font-family:${FONT_BODY};font-weight:400;color:${MUTED};font-size:16px;line-height:1.5;margin:0;padding:0;`;

  const prevResultRow = eia.prevResultLine
    ? `      <tr><td align="left" style="padding:8px 0 0 0;">
        <p style="${paragraphStyle}">${esc(eia.prevResultLine)}</p>
      </td></tr>`
    : "";

  // #1085: É IA? mantém um background suave (#FAFAFA) pra sinalizar bloco
  // interativo, sem o border ciano grosso dos destaques antigos. Padding
  // simétrico em ambos <td> das imagens (#1085) — alinha A/B no stack mobile.
  const imageStyle = `display:block;width:100%;height:auto;border-radius:6px;`;
  const buildVoteUrl = (choice: "A" | "B") =>
    `${POLL_WORKER_URL}/vote?email={{email}}&edition=${eia.edition}&choice=${choice}&sig={{poll_sig}}`;
  const eiaChoice = (choice: "A" | "B", imgFile: string) =>
    `<td width="50%" valign="top" style="padding:0 6px 12px 6px;" class="mob-stack">
            ${eia.edition
              ? `<a href="${buildVoteUrl(choice)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;display:block;">`
              : ""}
              <img src="{{IMG:${imgFile}}}" alt="Imagem ${choice}" width="100%" style="${imageStyle}" border="0"/>
            ${eia.edition ? "</a>" : ""}
          </td>`;

  return `<!-- É IA? -->
${renderRule()}
<tr><td style="padding:32px 0 0 0;">
  <table role="none" width="100%" border="0" cellspacing="0" cellpadding="0">
    <tr><td style="background-color:#FAFAFA;padding:32px 24px;border-radius:8px;">
      <table role="none" width="100%" border="0" cellspacing="0" cellpadding="0">
        <tr><td align="left" style="padding:0 0 16px 0;">
          <p style="font-family:${FONT_BODY};color:${TEAL};font-weight:600;text-transform:uppercase;letter-spacing:2px;font-size:16px;margin:0;padding:0;">🖼️ É IA?</p>
        </td></tr>
        <tr><td align="center" style="padding:0 0 20px 0;">
          <p style="font-family:${FONT_BODY};font-weight:400;color:${TEXT_COLOR};font-size:20px;line-height:1.3;margin:0;padding:0;">Clique na imagem que foi gerada por IA.</p>
        </td></tr>
        <tr><td>
          <table role="none" width="100%" border="0" cellspacing="0" cellpadding="0"><tr>
            ${eiaChoice("A", eia.imageA)}
            ${eiaChoice("B", eia.imageB)}
          </tr></table>
        </td></tr>
        <tr><td align="left" style="padding:16px 0 0 0;">
          <p style="${paragraphStyle}">${creditHtml}</p>
        </td></tr>
${prevResultRow}
      </table>
    </td></tr>
  </table>
</td></tr>`;
}

/** Render a single section item as its own table row(s) */
function renderSectionItem(item: SectionItem, last: boolean): string {
  // #1085: título com border-bottom 1px solid teal (email-safe), descrição em
  // cinza. Espaçamento entre items via padding-bottom no último <td>.
  const titleHtml = item.url
    ? `<a href="${esc(item.url)}" style="color:${TEXT_COLOR};text-decoration:none;border-bottom:1px solid ${TEAL};" target="_blank" rel="noopener noreferrer nofollow">${esc(item.title)}</a>`
    : esc(item.title);

  const bottomPad = last ? "0" : "16px";
  const titleRow = `<tr><td align="left" style="padding:0 0 ${item.description ? "4px" : bottomPad} 0;text-align:left;word-break:break-word;">
  <p style="font-family:${FONT_BODY};font-weight:600;color:${TEXT_COLOR};font-size:16px;line-height:1.4;margin:0;padding:0;">${titleHtml}</p>
</td></tr>`;

  if (!item.description) return titleRow;

  const descRow = `<tr><td align="left" style="padding:0 0 ${bottomPad} 0;text-align:left;word-break:break-word;">
  <p style="font-family:${FONT_BODY};font-weight:400;color:${MUTED};font-size:16px;line-height:1.5;margin:0;padding:0;">${esc(item.description)}</p>
</td></tr>`;

  return titleRow + "\n" + descRow;
}

function renderSection(section: Section): string {
  // #1090: rule fina (1px RULE) cima E baixo do kicker pra simetria visual —
  // versão anterior tinha rule grossa (2px TEXT_COLOR) só em cima, ficava
  // pesada e desbalanceada (feedback Pixel 2026-05-11).
  const itemsHtml = section.items
    .map((item, i) => renderSectionItem(item, i === section.items.length - 1))
    .join("\n");

  return `<!-- ${section.name} -->
${renderRule()}
<tr><td style="padding:24px 2px 0 2px;">
  <p style="font-family:${FONT_BODY};color:${TEAL};font-weight:600;text-transform:uppercase;letter-spacing:2px;font-size:16px;margin:0 0 16px 0;padding:0 0 16px 0;border-bottom:1px solid ${RULE};">${esc(section.name)}</p>
  <table role="none" border="0" cellspacing="0" cellpadding="0" width="100%">
    ${itemsHtml}
  </table>
</td></tr>`;
}

/**
 * Converte markdown inline simples (links `[text](url)`, bold `**text**`)
 * em HTML. Cobre o que aparece em SORTEIO/PARA ENCERRAR. Não é parser
 * markdown completo — só o subset necessário pros 2 blocos.
 */
function mdInlineToHtml(s: string): string {
  // Bold primeiro pra não engolir links dentro
  let out = s.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, label: string, url: string) =>
      `<a href="${esc(url)}" style="color:${TEXT_COLOR};text-decoration:none;border-bottom:1px solid ${TEAL};" target="_blank" rel="noopener noreferrer nofollow">${esc(label)}</a>`,
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  return out;
}

/**
 * Pure (#1076): renderiza o bloco 🎁 SORTEIO. Texto bruto vem do reviewed.md
 * (parágrafos + lista). Output em estilo editorial (#1085): kicker uppercase
 * + parágrafos sem box ciano.
 */
function renderSorteio(text: string): string {
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim());
  const html = paragraphs.map((p) =>
    `<p style="font-family:${FONT_BODY};color:${TEXT_COLOR};font-size:16px;line-height:1.6;margin:0 0 14px 0;padding:0;">${mdInlineToHtml(p.trim())}</p>`
  ).join("");
  return `<!-- 🎁 SORTEIO -->
${renderRule(true)}
<tr><td style="padding:24px 2px 0 2px;">
  <p style="font-family:${FONT_BODY};color:${TEAL};font-weight:600;text-transform:uppercase;letter-spacing:2px;font-size:16px;margin:0 0 16px 0;padding:0;">🎁 Sorteio</p>
  ${html}
</td></tr>`;
}

/**
 * Pure (#1076): renderiza o bloco 🙋🏼‍♀️ PARA ENCERRAR. Lista `- item` no MD
 * vira `<ul><li>...`; resto vira parágrafos.
 */
function renderEncerrar(text: string): string {
  const lines = text.split("\n");
  type Block = { type: "p" | "ul"; content: string[] };
  const blocks: Block[] = [];
  let current: Block | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (current) {
        blocks.push(current);
        current = null;
      }
      continue;
    }
    const isLi = /^[-*]\s+/.test(line);
    if (isLi) {
      if (current?.type !== "ul") {
        if (current) blocks.push(current);
        current = { type: "ul", content: [] };
      }
      current.content.push(line.replace(/^[-*]\s+/, ""));
    } else {
      if (current?.type !== "p") {
        if (current) blocks.push(current);
        current = { type: "p", content: [] };
      }
      current.content.push(line);
    }
  }
  if (current) blocks.push(current);

  const html = blocks.map((b) => {
    if (b.type === "ul") {
      const items = b.content.map((c) =>
        `<li style="margin:0 0 4px 0;">${mdInlineToHtml(c)}</li>`
      ).join("");
      return `<ul style="font-family:${FONT_BODY};color:${TEXT_COLOR};font-size:16px;line-height:1.6;margin:0 0 16px 0;padding:0 0 0 20px;">${items}</ul>`;
    }
    return `<p style="font-family:${FONT_BODY};color:${TEXT_COLOR};font-size:16px;line-height:1.6;margin:0 0 16px 0;padding:0;">${mdInlineToHtml(b.content.join(" "))}</p>`;
  }).join("");

  return `<!-- 🙋🏼‍♀️ PARA ENCERRAR -->
${renderRule(true)}
<tr><td style="padding:24px 2px 0 2px;">
  <p style="font-family:${FONT_BODY};color:${TEAL};font-weight:600;text-transform:uppercase;letter-spacing:2px;font-size:16px;margin:0 0 16px 0;padding:0;">🙋🏼‍♀️ Para encerrar</p>
  ${html}
</td></tr>`;
}

export interface RenderOpts {
  /** #1046 — quando `true`, omite a seção É IA? do body. Usado pelo paste
   * híbrido (Stage 4 publish-newsletter): body via ClipboardEvent + È IA?
   * via insertContent pra preservar merge tags `{{poll_x_url}}` que TipTap
   * normalizaria. Default false (output legado: body único com È IA? embutido). */
  excludeEia?: boolean;
}

export function renderHTML(content: NewsletterContent, opts: RenderOpts = {}): string {
  const parts: string[] = [];

  // #1077 — É IA? idealmente entre D2 e D3 (após i === 1), per memory
  // `feedback_beehiiv_sections.md` e convention pre-existente. Fallback
  // robusto (#1085): se destaques.length < 2 (test fixtures ou edições
  // atípicas), insere no fim do loop pra garantir que È IA? não seja
  // silenciosamente omitido.
  const includeEia = !!(!opts.excludeEia && content.eia.credit);
  let eiaInserted = false;
  for (let i = 0; i < content.destaques.length; i++) {
    parts.push(renderDestaque(content.destaques[i]));
    if (includeEia && !eiaInserted && i === 1) {
      parts.push(renderEIA(content.eia));
      eiaInserted = true;
    }
  }
  if (includeEia && !eiaInserted) {
    parts.push(renderEIA(content.eia));
  }

  for (const section of content.sections) {
    parts.push(renderSection(section));
  }

  // #1076: blocos fixos do template Beehiiv (SORTEIO + PARA ENCERRAR).
  // Renderer só emite quando o reviewed.md tem o bloco (graceful skip).
  if (content.sorteio) parts.push(renderSorteio(content.sorteio));
  if (content.encerrar) parts.push(renderEncerrar(content.encerrar));

  return `<!-- Diar.ia newsletter body — auto-generated by render-newsletter-html.ts -->
<table role="none" width="100%" border="0" cellspacing="0" cellpadding="0">
${parts.join("\n")}
</table>`;
}

/**
 * #1046 — Render È IA? section standalone (em outer table própria), pra paste
 * via `editor.commands.insertContent({type: 'htmlSnippet', ...})` no TipTap
 * Beehiiv. Preserva merge tags `{{poll_a_url}}` / `{{poll_b_url}}` que
 * paste-handler normalizaria a empty hrefs.
 *
 * Retorna `null` se a edição não tem È IA? configurada (eia.credit vazio).
 * Caller deve fazer fallback gracioso (renderiza só o body).
 */
export function renderEiaStandalone(content: NewsletterContent): string | null {
  if (!content.eia.credit) return null;
  return `<!-- Diar.ia È IA? section — auto-generated by render-newsletter-html.ts (#1046) -->
<!-- Paste via editor.commands.insertContent pra preservar merge tags. -->
<table role="none" width="100%" border="0" cellspacing="0" cellpadding="0">
${renderEIA(content.eia)}
</table>`;
}

// ── Main ──────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const editionDir = args.find((a) => !a.startsWith("--"));
  const { values, flags } = parseCliArgs(args); // #535: fix indexOf+1 bug
  const format = values["format"] ?? "html";
  const outPath = values["out"] ?? null;
  const split = flags.has("split"); // #1046 — paste híbrido (body + È IA? standalone)

  if (!editionDir) {
    console.error(
      "Usage: npx tsx scripts/render-newsletter-html.ts <edition-dir> [--format html|json] [--out <path>] [--split]\n" +
        "  --split: produz 2 arquivos em {edition}/_internal/ — newsletter-body.html (sem È IA?) + newsletter-eia.html (È IA? standalone, preserva merge tags). #1046",
    );
    process.exit(1);
  }

  const resolvedDir = resolve(ROOT, editionDir);
  const content = extractContent(resolvedDir);

  // #1046 — Modo split: produz 2 arquivos pro paste híbrido (body via
  // ClipboardEvent + È IA? via insertContent). --format json incompatível;
  // --out ignorado com warning explícito (#1052 review follow-up).
  if (split) {
    if (format !== "html") {
      console.error("--split incompatível com --format json");
      process.exit(1);
    }
    if (outPath) {
      console.error(
        `--split + --out: --out (${outPath}) ignorado. Modo split sempre escreve em _internal/newsletter-{body,eia}.html`,
      );
    }
    const internalDir = resolve(resolvedDir, "_internal");
    // #1052 review follow-up: garante que _internal/ existe antes de write.
    // Stage 4 normalmente já tem (criado por scripts anteriores), mas defensive
    // contra fresh edition dirs ou ordens de execução não-padrão.
    mkdirSync(internalDir, { recursive: true });
    const bodyPath = resolve(internalDir, "newsletter-body.html");
    const eiaPath = resolve(internalDir, "newsletter-eia.html");
    const bodyHtml = renderHTML(content, { excludeEia: true });
    writeFileSync(bodyPath, bodyHtml + "\n");
    console.error(`Written body to ${bodyPath} (${bodyHtml.length} bytes)`);
    const eiaHtml = renderEiaStandalone(content);
    if (eiaHtml) {
      writeFileSync(eiaPath, eiaHtml + "\n");
      console.error(`Written È IA? to ${eiaPath} (${eiaHtml.length} bytes)`);
    } else {
      console.error(`È IA? sem credit configurado — pulando ${eiaPath}`);
    }
    return;
  }

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
