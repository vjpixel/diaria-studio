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
import { parseInlineLink, parseInlineLinkWithTrailing } from "./lib/inline-link.ts"; // #599, #1581

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

// #1328: SECTION_EMOJI movido pra scripts/lib/section-naming.ts (compartilhado
// com singularize-md-sections + writer template). PESQUISAS mudou de 🧪 → 🔬
// pra match com destaque label D3 PESQUISA (🔬), confirmado pelo editor em
// 260518.
import {
  sectionEmojiPrefix,
  displaySectionName,
} from "./lib/section-naming.ts";

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
  /** Leaderboard top1 do mês corrente (#1160 legacy). Mantido pra back-compat
   * mas renderer agora usa `leaderboardPodium` (ranks 1-3, mais informativo). */
  leaderboardTop1?: { nickname: string; pct: number; correct: number; total: number }[];
  /** Leaderboard podium ranks 1-3 (#1160 followup). Lista ordenada na ordem
   * do leaderboard público (dense rank, nickname ASC tiebreaker). Renderiza
   * no rodapé do È IA?. Populado por `scripts/fetch-leaderboard-top1.ts` em
   * `_internal/04-leaderboard-top1.json`. */
  leaderboardPodium?: { nickname: string; rank: number }[];
  /** Label do período pro título do bloco (ex: "Maio"). */
  leaderboardPeriod?: string;
  /** Slug YYYY-MM do período — usado pra linkar o bloco pra
   * `/leaderboard/{YYYY-MM}` (URL histórica permanente, #1345). */
  leaderboardPeriodSlug?: string;
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
  /** #1279: bloco ERRO INTENCIONAL parseado do reviewed.md (raw — só o parágrafo "Na última edição, ..." é renderizado como callout box bordered). */
  erroIntencional?: string | null;
  /** #1093: linha "Para esta edição, eu (o editor) enviei X submissões e a Diar.ia encontrou
   * outros Y artigos. Selecionamos os Z mais relevantes...". Parseada do reviewed.md, renderizada
   * como bloco transparente no topo do email (após o título, antes do primeiro destaque). */
  coverageLine?: string | null;
  /** #1648: CTA de destaque no topo (ex: convite pro sorteio ao vivo). Parseado
   * de um parágrafo `**🎉 ...**` ou `**📣 ...**` na região de intro do reviewed.md
   * (após a coverage line, antes do primeiro destaque). Renderizado como callout
   * com borda teal — diferente da coverage line (cinza itálico), pra não passar
   * despercebido. */
  introCallout?: string | null;
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

/**
 * #1118: markers que terminam implicitamente uma section, mesmo sem `---`.
 * Writer agent às vezes omite o separator entre OUTRAS NOTÍCIAS e SORTEIO
 * (ou OUTRAS NOTÍCIAS e PARA ENCERRAR), o que fazia parseSections engolir
 * o bloco SORTEIO como items adicionais — render saía com duplicação.
 *
 * Aceita header com ou sem markdown bold marker (`**...**`).
 */
const SECTION_TERMINATOR_MARKERS = [
  /^(?:\*\*)?🎁 SORTEIO(?:\*\*)?\s*$/m,
  /^(?:\*\*)?🙋🏼‍♀️ PARA ENCERRAR(?:\*\*)?\s*$/m,
];

/**
 * #1118: trunca texto no primeiro marker de template block (SORTEIO ou
 * PARA ENCERRAR). Retorna texto antes do marker, trimmed. Defensive contra
 * MD sem `---` entre seções e blocos finais.
 *
 * Pure helper — exportado pra teste.
 */
export function truncateAtSectionTerminator(text: string): string {
  let minIdx = text.length;
  for (const re of SECTION_TERMINATOR_MARKERS) {
    const m = re.exec(text);
    if (m && m.index < minIdx) minIdx = m.index;
  }
  return text.slice(0, minIdx).trim();
}

// #1363: regex única reutilizada em match + replace. Aceita:
// - `**SECTION**` ou `SECTION` (com/sem markdown bold)
// - prefix opcional emoji + whitespace (ex: `**🚀 LANÇAMENTOS**`) inserido pelo
//   `singularize-md-sections.ts` per #1324/#1328
// - singular (LANÇAMENTO, NOTÍCIA, PESQUISA, VÍDEO) ou plural (idem + S)
// - C ou Ç em LANÇAMENTO / I ou Í em VÍDEO (compat com OS/teclado sem acento).
//   Sem acento o nome cai no fallback de emoji 📰 (degradação graceful — a seção
//   é reconhecida e renderizada, só sem o emoji canônico — em vez de sumir; é o
//   mesmo trade-off do C/Ç). #1689 review (#1674).
// - RADAR (#1569), USE MELHOR (#1568), VÍDEOS (#1674) — seções secundárias.
// - trailing whitespace no header (`\s*$`): editor/copy-paste às vezes deixa
//   espaço após `**…**`; sem isso a seção inteira sumia (silent-drop). #1689.
//
// Legacy aliases (PESQUISAS, OUTRAS NOTÍCIAS) mantidos pra re-rendering de
// edições antigas — render-newsletter-html não distingue, só extrai items.
//
// Sem essa flexibilidade, headers com emoji prefix matam silenciosamente as
// seções inteiras na renderização. Caso real 260519: LANÇAMENTOS + OUTRAS
// NOTÍCIAS perdidas no primeiro paste no Beehiiv (18.5KB vs 28.9KB esperado).
const SECTION_HEADER_RE = /^(?:\*\*)?(?:[^\sA-Za-zÁ-ú]+\s+)?(RADAR|PESQUISAS?|LAN[ÇC]AMENTOS?|OUTRAS NOTÍCIAS?|USE MELHOR|V[ÍI]DEOS?)(?:\*\*)?\s*$/m;

export function parseSections(text: string): Section[] {
  const blocks = text.split(/^---$/m).map((s) => s.trim()).filter(Boolean);
  const sections: Section[] = [];

  for (const block of blocks) {
    const sectionMatch = block.match(SECTION_HEADER_RE);
    if (!sectionMatch) continue;

    // #1363: normalizar pra plural pro switch em sectionEmojiPrefix
    // (mapping aceita só plural). LANÇAMENTO → LANÇAMENTOS etc.
    // #1569: RADAR é invariante (singular = plural) — não pluralizar.
    const rawName = sectionMatch[1];
    const name = rawName === "RADAR" || rawName === "USE MELHOR" || rawName.endsWith("S") ? rawName : rawName + "S";
    const emoji = sectionEmojiPrefix(name).trim() || "📰";
    // #1118: truncar afterHeader em markers de SORTEIO/PARA ENCERRAR pra não
    // consumir esses blocos como items quando writer omitir `---`.
    const afterHeader = truncateAtSectionTerminator(
      block.replace(SECTION_HEADER_RE, "").trim(),
    );
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
    // #1581 — Drive round-trip (#1582) reformata `**[Title](url)**  \nsummary`
    // pra `[**Title**](url) summary` (title + summary inline mesma linha).
    // parseInlineLink rejeita; tentar variante que captura trailing text.
    //
    // TODO(#1582): este branch vira morto-código quando Drive normalize
    // reverter o roundtrip pós-pull. Remover então.
    //
    // Scan: cada linha que começa com `[link](url)` (com ou sem trailing)
    // abre um novo item. Linhas subsequentes até o próximo inline link
    // viram description daquele item. Cobre tanto o caso single-item
    // (Drive flatten do título+summary) quanto multi-item collapsed
    // (LLM omitiu blank line entre items).
    const inlineStarts: Array<{
      index: number;
      title: string;
      url: string;
      trailing: string;
    }> = [];
    for (let k = 0; k < block.length; k++) {
      const withTrailing = parseInlineLinkWithTrailing(block[k]);
      if (withTrailing) {
        inlineStarts.push({ index: k, ...withTrailing });
        continue;
      }
      const plain = parseInlineLink(block[k]);
      if (plain) {
        inlineStarts.push({ index: k, title: plain.title, url: plain.url, trailing: "" });
      }
    }
    if (inlineStarts.length > 0 && inlineStarts[0].index === 0) {
      for (let k = 0; k < inlineStarts.length; k++) {
        const cur = inlineStarts[k];
        const next = inlineStarts[k + 1];
        const descLines: string[] = [];
        if (cur.trailing) descLines.push(cur.trailing);
        const descEnd = next ? next.index : block.length;
        for (let j = cur.index + 1; j < descEnd; j++) descLines.push(block[j]);
        items.push({
          title: cur.title,
          url: cur.url,
          description: descLines.join(" ").trim(),
        });
      }
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
    // #1100: aceitar `É IA?` (legacy) e `**É IA?**` (novo formato em negrito)
    if (l.startsWith("É IA?") || l.startsWith("**É IA?**")) continue;
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

/**
 * Pure (#1093): extrai a linha de cobertura ("Para esta edição, eu (o editor) enviei X
 * submissões e a Diar.ia encontrou outros Y artigos. Selecionamos os Z mais relevantes...")
 * do reviewed.md. Retorna `null` se ausente.
 *
 * A linha é injetada pelo writer no topo do reviewed.md (após TÍTULO/SUBTÍTULO e
 * antes do primeiro destaque). #1097 mantém os números sincronizados com Stage 1.
 */
export function extractCoverageLine(text: string): string | null {
  const m = text.match(/^Para esta edição, eu \(o editor\) enviei[^\n]+$/m);
  return m ? m[0].trim() : null;
}

/**
 * Pure (#1648): extrai um CTA de destaque (ex: convite pro sorteio ao vivo) da
 * região de intro — um parágrafo em negrito iniciado por 🎉 ou 📣, posicionado
 * antes do primeiro `**DESTAQUE`. Retorna o texto interno (markdown de links
 * preservado pra processInlineLinks), ou `null` se ausente.
 *
 * Diferente da coverage line: renderizado como callout com borda, não some no
 * meio do parágrafo cinza (feedback 260601 — sorteio não era encontrado no topo).
 */
export function extractIntroCallout(text: string): string | null {
  const introRegion = text.split(/^\*\*DESTAQUE/m)[0];
  const m = introRegion.match(/^\*\*\s*((?:🎉|📣)[\s\S]+?)\*\*\s*$/m);
  return m ? m[1].trim() : null;
}

function extractContent(editionDir: string): NewsletterContent {
  const reviewedPath = resolve(editionDir, "02-reviewed.md");
  const eiaPath = resolve(editionDir, "01-eia.md");

  if (!existsSync(reviewedPath)) {
    throw new Error(`${reviewedPath} not found — run Stage 2 first`);
  }

  const reviewedText = joinMultilineLinks(readFileSync(reviewedPath, "utf8"));

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

  // #1160: leaderboard do mês corrente. Arquivo populado por
  // fetch-leaderboard-top1.ts pré-render; ausente → bloco omitido.
  // Renderer prefere `podium` (ranks 1-3) e cai em `top1` (rank 1 only) só
  // pra compat com arquivos legacy pré-#1160-followup.
  const leaderboardPath = resolve(editionDir, "_internal", "04-leaderboard-top1.json");
  if (existsSync(leaderboardPath)) {
    try {
      const parsed = JSON.parse(readFileSync(leaderboardPath, "utf8"));
      if (Array.isArray(parsed.podium) && parsed.podium.length > 0) {
        eia.leaderboardPodium = parsed.podium;
      } else if (Array.isArray(parsed.top1) && parsed.top1.length > 0) {
        eia.leaderboardTop1 = parsed.top1;
      }
      eia.leaderboardPeriod = parsed.period || undefined;
      // #1345: slug YYYY-MM pra linkar o bloco pra /leaderboard/{slug}
      // (URL histórica). Mantido mesmo sem líderes — habilita o link-convite.
      eia.leaderboardPeriodSlug = parsed.period_slug || undefined;
    } catch {
      // Corrupted → skip, bloco omitido
    }
  }

  // #1076: blocos fixos do template Beehiiv (SORTEIO + PARA ENCERRAR).
  // Quando ausentes (edição antiga, ou pixel preferiu omitir), graceful skip.
  const sorteio = extractTemplateBlock(reviewedText, "🎁 SORTEIO");
  const encerrar = extractTemplateBlock(reviewedText, "🙋🏼‍♀️ PARA ENCERRAR");
  const erroIntencional = extractTemplateBlock(reviewedText, "ERRO INTENCIONAL"); // #1279

  // #1093: linha de cobertura no topo da newsletter.
  const coverageLine = extractCoverageLine(reviewedText);
  // #1648: CTA de destaque no topo (ex: convite pro sorteio ao vivo).
  const introCallout = extractIntroCallout(reviewedText);

  return {
    title: destaques[0].title,
    subtitle: buildSubtitle(destaques[1].title, destaques[2].title),
    coverImage: "04-d1-2x1.jpg",
    destaques,
    eia,
    sections,
    sorteio,
    encerrar,
    erroIntencional,
    coverageLine,
    introCallout,
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
const POLL_WORKER_URL = "https://poll.diaria.workers.dev";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * #1117: remove backslash escapes do markdown pra pontuação ASCII comum.
 *
 * Writer agent (Sonnet) ocasionalmente escapa `.` `!` `?` `,` `;` `:` no MD
 * — válido em CommonMark mas desnecessário em pt-BR. Sem normalização, o
 * backslash literal vaza pro HTML final e fica visível ao leitor
 * (ex: "ajuda bastante\!").
 *
 * Aplica só a set fechado de ASCII punctuation. Não toca outros backslashes
 * (URLs Windows-path, etc.) — não há expectativa de ter `\.` legítimo em
 * texto editorial pt-BR.
 *
 * Pure helper — exportado pra teste.
 */
export function unescapeMd(s: string): string {
  return s.replace(/\\([.,!?:;])/g, "$1");
}

/**
 * #1364: converte `*text*` (italic markdown) em `<em>text</em>` inline,
 * preservando `**text**` (bold) intacto.
 *
 * Writer agent + crédito do É IA? usam `*Canis aureus*` pra nome científico.
 * Antes do #1364 o renderer mantinha os asteriscos literais → o email saía
 * com "(*Canis aureus*)" em texto puro, sem itálico.
 *
 * Regex: `*` solo (não-precedido nem seguido de `*`), conteúdo sem `*` nem
 * newline. `font-style:italic` inline garante renderização email-safe.
 *
 * Pure helper — exportado pra teste.
 */
export function processInlineItalics(s: string): string {
  return s.replace(
    /(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g,
    '<em style="font-style:italic;">$1</em>',
  );
}

/**
 * Escape pra HTML body text — combina `unescapeMd` (remove backslash do MD)
 * + `esc` (HTML entities) + `processInlineItalics` (#1364 — `*x*` → `<em>x</em>`).
 * Ordem: unescape → esc → italics. Italics roda por último pra que as tags
 * `<em>` não sejam HTML-escapadas. Usar em conteúdo editorial; NÃO usar em
 * URLs (backslash em URL é literal, raro mas legítimo).
 */
function escText(s: string): string {
  return processInlineItalics(esc(unescapeMd(s)));
}

/**
 * Pre-processor #1213: junta links markdown quebrados em múltiplas linhas
 * em um único `[label](url)`.
 *
 * Writer agent às vezes emite links no formato:
 *
 *   - [Melhores cursos grátis de IA](
 *   https://diaria.beehiiv.com/cursos-gratuitos-de-ia
 *   )
 *
 * O parser markdown (`processInlineLinks`) opera linha-a-linha, então
 * esses links viram texto bruto `[Label](` + URL como parágrafo separado
 * + `)` órfão. Caso real 260517: Pixel viu no test email do Beehiiv.
 *
 * Heurística: detecta `](` no fim de linha (ignorando whitespace) e procura
 * uma URL na próxima linha não-vazia, seguida por `)` (eventualmente em
 * outra linha). Substitui pelo `[label](url)` em linha única.
 *
 * Conservativa: só processa quando a estrutura é inequívoca. URLs em
 * uma linha single mantêm-se intactas.
 */
export function joinMultilineLinks(md: string): string {
  // Match `]( ... )` onde `...` pode ter newlines + whitespace ao redor da URL.
  // [^\]]+ no label (sem `]`), depois `](\s*(URL)\s*)` onde os \s* tolera newlines.
  return md.replace(
    /\[([^\]]+)\]\(\s*\n\s*(https?:\/\/\S+?)\s*\n\s*\)/g,
    "[$1]($2)",
  );
}

/** Process markdown links [text](url) to <a> tags, escaping surrounding text.
 * Input é normalizado via `unescapeMd` antes (#1117) — remove backslash escapes
 * de pontuação ASCII que o writer pode ter adicionado. URLs em markdown não
 * usam backslash escape (usam % encoding), então unescape upfront é seguro. */
/**
 * Processa markdown links inline `[texto](url)` → `<a>`.
 *
 * #1634: o destino é parseado contando parênteses balanceados, não com
 * `\(([^)]+)\)`. A regex antiga fechava o link no PRIMEIRO `)`, então uma URL
 * com parênteses (ex: `.../The-Founders-Playbook-05062026_v3%20(1).pdf`)
 * quebrava — o href saía truncado em `...(1` e o resto vazava como texto.
 * CommonMark permite pares de parênteses balanceados no destino; aqui um `(`
 * aumenta a profundidade e só um `)` em profundidade 0 fecha o link.
 */
export function processInlineLinks(s: string): string {
  const input = unescapeMd(s);
  const parts: string[] = [];
  let lastIdx = 0;
  const linkStart = /\[([^\]]+)\]\(/g;
  let m: RegExpExecArray | null;
  while ((m = linkStart.exec(input)) !== null) {
    const destStart = m.index + m[0].length;
    // Varre o destino balanceando parênteses: `(` aprofunda, `)` em depth 0 fecha.
    let depth = 0;
    let j = destStart;
    for (; j < input.length; j++) {
      const ch = input[j];
      if (ch === "(") depth++;
      else if (ch === ")") {
        if (depth === 0) break;
        depth--;
      }
    }
    if (j >= input.length) continue; // sem `)` de fechamento → não é link válido
    const url = input.substring(destStart, j);
    // URL vazia (`[texto]()`) não é link — preserva o comportamento da regex
    // antiga (`[^)]+` exigia destino não-vazio) e evita emitir `<a href="">`.
    if (url.length === 0) {
      linkStart.lastIndex = j + 1;
      continue;
    }
    if (m.index > lastIdx) parts.push(esc(input.substring(lastIdx, m.index)));
    parts.push(
      `<a href="${esc(url)}" style="color:${TEXT_COLOR};text-decoration:underline;font-weight:bold;" target="_blank" rel="noopener noreferrer nofollow">${esc(m[1])}</a>`
    );
    lastIdx = j + 1;
    linkStart.lastIndex = j + 1; // retoma a busca após o link consumido
  }
  if (lastIdx < input.length) parts.push(esc(input.substring(lastIdx)));
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
  return `<tr><td align="left" valign="top" style="padding:0 2px;">
  <img src="{{IMG:${placeholder}}}" alt="${esc(alt)}" width="100%" style="display:block;width:100%;height:auto;margin:0 0 8px 0;" border="0"/>
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
  <p style="font-family:${FONT_BODY};font-weight:400;color:${TEXT_COLOR};font-size:16px;line-height:1.6;margin:0 0 14px 0;padding:0;">${escText(p.trim())}</p>
</td></tr>`
    )
    .join("\n");
}

function renderWhyBlock(text: string): string {
  // #1085: "Por que isso importa" como pull-quote inline — table com
  // border-left teal, parágrafo em itálico cinza. Em vez de h3 grande +
  // parágrafos depois (legacy renderWhyHeading), agrega ambos em um único
  // bloco editorial estilo magazine.
  const body = text.split(/\n\n+/).filter((p) => p.trim()).map((p) => escText(p.trim())).join("<br><br>");
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

/**
 * #1093: bloco de cobertura no topo do email. Tipograficamente discreto —
 * cinza médio, itálico, sem box ou border — pra não competir com o primeiro
 * destaque. Aparece logo após o header gerado pelo template Beehiiv (título +
 * subtítulo) e antes do primeiro destaque.
 */
export function renderCoverage(text: string): string {
  return `<!-- #1093 coverage line -->
<tr><td align="left" style="padding:24px 2px 0 2px;text-align:left;word-break:break-word;">
  <p style="font-family:${FONT_BODY};font-weight:400;color:${MUTED};font-size:15px;line-height:1.5;font-style:italic;margin:0;padding:0;">${escText(text)}</p>
</td></tr>`;
}

/**
 * #1648: CTA de destaque no topo (ex: convite pro sorteio ao vivo). Callout com
 * fundo claro + borda esquerda teal, texto em peso 600 — visualmente distinto da
 * coverage line (cinza itálico) pra não passar despercebido. Links em markdown
 * são processados via processInlineLinks.
 */
export function renderIntroCallout(text: string): string {
  return `<!-- #1648 intro callout (sorteio/CTA) -->
<tr><td align="left" style="padding:16px 2px 0 2px;text-align:left;word-break:break-word;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0FAFA;border-left:4px solid ${TEAL};border-radius:4px;">
    <tr><td style="padding:12px 16px;">
      <p style="font-family:${FONT_BODY};font-weight:600;color:${TEXT_COLOR};font-size:16px;line-height:1.5;margin:0;padding:0;">${processInlineLinks(text)}</p>
    </td></tr>
  </table>
</td></tr>`;
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
  // #1422: caption do POTD em itálico (convenção de legenda de foto). Mantém
  // paragraphStyle separado pra não italicizar a leaderboard row (#1160), que
  // tem semântica de label, não de caption.
  const captionStyle = paragraphStyle + "font-style:italic;";

  // #1160: bloco leaderboard no rodapé do È IA?. Omitido quando ausente.
  // #1646: posições ordinais por acertos, sem percentual.
  // Formato: "🏆 Vencedores de Maio: 1º Bruna Quevedo, 2º Joshu, 3º Ana Cândida"
  const leaderboardRow = renderLeaderboardTop1Row(eia, paragraphStyle);

  // #1630: emite a linha "Resultado da última edição: X% acertaram" (parseada
  // em prevResultLine mas antes nunca renderizada). Mostra o % de acertos da
  // edição anterior no rodapé do bloco É IA?.
  const prevResultHtml = eia.prevResultLine
    ? `
        <tr><td align="left" style="padding:8px 0 0 0;">
          <p style="font-family:${FONT_BODY};font-weight:600;color:${TEXT_COLOR};font-size:16px;line-height:1.5;margin:0;padding:0;">${processInlineLinks(eia.prevResultLine)}</p>
        </td></tr>`
    : "";

  // #1085: É IA? mantém um background suave (#FAFAFA) pra sinalizar bloco
  // interativo, sem o border ciano grosso dos destaques antigos. Padding
  // simétrico em ambos <td> das imagens (#1085) — alinha A/B no stack mobile.
  const imageStyle = `display:block;width:100%;height:auto;`;
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
          <p style="${captionStyle}">${creditHtml}</p>
        </td></tr>${prevResultHtml}
${leaderboardRow}
      </table>
    </td></tr>
  </table>
</td></tr>`;
}

/**
 * Pure (#1160): renderiza linha do leaderboard no rodapé do È IA?.
 * Inclui leitores até o 3º lugar (dense rank) na mesma ordem do leaderboard
 * público. #1646: posições ordinais por acertos, sem percentual nem % de ranking.
 *
 * Formato:
 *   - 1 leader: "🏆 Vencedores de Maio: 1º Davyd Wilkerson"
 *   - 2 leitores: "🏆 Vencedores de Maio: 1º Davyd, 2º Luisao P"
 *   - 3+ leitores: "🏆 Vencedores de Maio: 1º Davyd, 2º Luisao P, 3º Vanessa"
 *   - Vazio (1ª edição do mês): convite linkado pra leaderboard do mês, ou ""
 *
 * Prefere `leaderboardPodium` (ranks 1-3); cai em `leaderboardTop1` (rank 1
 * only) pra compat com arquivos legacy.
 */
export function renderLeaderboardTop1Row(eia: EIA, paragraphStyle: string): string {
  // Source: prefere podium (#1160 followup), cai em top1 legacy. Preserva o
  // rank pra exibir posições ordinais (1º, 2º, 3º). #1646: ranking por acertos.
  const ranked: { nickname: string; rank: number }[] =
    eia.leaderboardPodium && eia.leaderboardPodium.length > 0
      ? eia.leaderboardPodium.map((e) => ({ nickname: e.nickname, rank: e.rank }))
      : eia.leaderboardTop1 && eia.leaderboardTop1.length > 0
        ? eia.leaderboardTop1.map((e, i) => ({ nickname: e.nickname, rank: i + 1 }))
        : [];
  const period = eia.leaderboardPeriod ? ` de ${eia.leaderboardPeriod}` : "";
  // URL histórica permanente do mês (#1345). Linka o bloco quando o slug existe.
  const slug = eia.leaderboardPeriodSlug || "";
  const lbUrl = slug ? `${POLL_WORKER_URL}/leaderboard/${slug}` : "";
  const linkStyle = `color:${TEAL};text-decoration:underline;font-weight:bold;`;

  // Sem líderes ainda (ex: 1ª edição do mês) — em vez de omitir o bloco,
  // convidar o leitor pra acompanhar a leaderboard do mês na URL histórica.
  if (ranked.length === 0) {
    if (!lbUrl) return "";
    const label = eia.leaderboardPeriod
      ? `Acompanhe a leaderboard de ${eia.leaderboardPeriod}`
      : "Acompanhe a leaderboard do mês";
    return `      <tr><td align="left" style="padding:8px 0 0 0;">
        <p style="${paragraphStyle}">🏆 <a href="${lbUrl}" target="_blank" rel="noopener noreferrer" style="${linkStyle}">${esc(label)}</a></p>
      </td></tr>`;
  }

  // Posições ordinais: "1º Bruna Quevedo, 2º Joshu, 3º Ana Cândida".
  const phrase = ranked
    .map((e) => `${e.rank}º ${esc(e.nickname)}`)
    .join(", ");

  // Quando há slug, o título "Vencedores de {mês}" vira link pra leaderboard histórica.
  const heading = lbUrl
    ? `<a href="${lbUrl}" target="_blank" rel="noopener noreferrer" style="${linkStyle}">Vencedores${period}</a>`
    : `<strong>Vencedores${period}</strong>`;

  return `      <tr><td align="left" style="padding:8px 0 0 0;">
        <p style="${paragraphStyle}">🏆 ${heading}: ${phrase}</p>
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

// #1324: singularizeSectionName movido pra scripts/lib/section-naming.ts.
// Re-export pra retrocompat caller importando direto deste módulo.
export { singularizeSectionName } from "./lib/section-naming.ts";

function renderSection(section: Section): string {
  if (section.items.length === 0) return "";

  // #1090: rule fina (1px RULE) cima E baixo do kicker pra simetria visual —
  // versão anterior tinha rule grossa (2px TEXT_COLOR) só em cima, ficava
  // pesada e desbalanceada (feedback Pixel 2026-05-11).
  const itemsHtml = section.items
    .map((item, i) => renderSectionItem(item, i === section.items.length - 1))
    .join("\n");

  // #1070 + #1328: emoji prefix + singular quando só tem 1 item
  // (🚀 LANÇAMENTO em vez de 🚀 LANÇAMENTOS)
  const displayName = displaySectionName(section.name, section.items.length);

  return `<!-- ${section.name} -->
${renderRule()}
<tr><td style="padding:24px 2px 0 2px;">
  <p style="font-family:${FONT_BODY};color:${TEAL};font-weight:600;text-transform:uppercase;letter-spacing:2px;font-size:16px;margin:0 0 16px 0;padding:0 0 16px 0;border-bottom:1px solid ${RULE};">${esc(displayName)}</p>
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
  // #1117: normalizar backslash escapes ASCII antes de qualquer parsing.
  let out = unescapeMd(s);
  // Bold primeiro pra não engolir links dentro
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, label: string, url: string) =>
      `<a href="${esc(url)}" style="color:${TEXT_COLOR};text-decoration:none;border-bottom:1px solid ${TEAL};" target="_blank" rel="noopener noreferrer nofollow">${esc(label)}</a>`,
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  return out;
}

/**
 * #1279: renderiza o reveal "Na última edição, ..." como callout box bordered
 * (1px solid #1a1a1a, border-radius 10px) — formato histórico usado em todas
 * edições publicadas no Beehiiv. Posicionado entre SORTEIO e PARA ENCERRAR.
 * Filtra: pega só parágrafo que começa com "Na última edição".
 */
function renderErroIntencionalReveal(text: string): string {
  const paragraphs = text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const reveal = paragraphs.find((p) => /^Na última edição/i.test(p));
  if (!reveal) return "";
  return `<!-- ERRO INTENCIONAL — reveal -->
<tr><td style="padding:24px 2px 0 2px;">
  <table role="none" width="100%" border="0" cellspacing="0" cellpadding="0">
    <tr><td style="background-color:#FFFFFF;border:1px solid #1a1a1a;border-radius:10px;padding:14px 16px;">
      <p style="font-family:${FONT_BODY};color:${TEXT_COLOR};font-size:16px;line-height:1.5;margin:0;padding:0;">${mdInlineToHtml(reveal)}</p>
    </td></tr>
  </table>
</td></tr>`;
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
${renderRule()}
<tr><td style="padding:24px 2px 0 2px;">
  <p style="font-family:${FONT_BODY};color:${TEAL};font-weight:600;text-transform:uppercase;letter-spacing:2px;font-size:16px;margin:0 0 16px 0;padding:0 0 16px 0;border-bottom:1px solid ${RULE};">🎁 Sorteio</p>
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

  // #1148: último parágrafo (CTA "Agora que chegou...") vai numa caixa
  // estilo É IA? — fundo #FAFAFA, padding 32px/24px, border-radius 8px.
  // Heurística: separar último item dos blocos se for um `<p>` começando com
  // "Agora que chegou"; render o resto inline e o último envelopado em box.
  const lastBlock = blocks[blocks.length - 1];
  const isAgoraCta =
    lastBlock?.type === "p" &&
    /^agora que chegou/i.test(lastBlock.content.join(" ").trim());
  const mainBlocks = isAgoraCta ? blocks.slice(0, -1) : blocks;
  const ctaBlock = isAgoraCta ? lastBlock : null;

  const renderBlock = (b: { type: "p" | "ul"; content: string[] }) => {
    if (b.type === "ul") {
      const items = b.content.map((c) =>
        `<li style="margin:0 0 4px 0;">${mdInlineToHtml(c)}</li>`
      ).join("");
      return `<ul style="font-family:${FONT_BODY};color:${TEXT_COLOR};font-size:16px;line-height:1.6;margin:0 0 16px 0;padding:0 0 0 20px;">${items}</ul>`;
    }
    return `<p style="font-family:${FONT_BODY};color:${TEXT_COLOR};font-size:16px;line-height:1.6;margin:0 0 16px 0;padding:0;">${mdInlineToHtml(b.content.join(" "))}</p>`;
  };

  const html = mainBlocks.map(renderBlock).join("");

  const ctaBox = ctaBlock
    ? `
  <table role="none" width="100%" border="0" cellspacing="0" cellpadding="0">
    <tr><td style="background-color:#FAFAFA;padding:32px 24px;border-radius:8px;">
      <p style="font-family:${FONT_BODY};color:${TEXT_COLOR};font-size:16px;line-height:1.6;margin:0;padding:0;">${mdInlineToHtml(ctaBlock.content.join(" "))}</p>
    </td></tr>
  </table>`
    : "";

  return `<!-- 🙋🏼‍♀️ PARA ENCERRAR -->
${renderRule()}
<tr><td style="padding:24px 2px 0 2px;">
  <p style="font-family:${FONT_BODY};color:${TEAL};font-weight:600;text-transform:uppercase;letter-spacing:2px;font-size:16px;margin:0 0 16px 0;padding:0 0 16px 0;border-bottom:1px solid ${RULE};">🙋🏼‍♀️ Para encerrar</p>
  ${html}${ctaBox}
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

  // #1093: linha de cobertura no topo, antes do primeiro destaque. Graceful
  // skip quando ausente (edições antigas pré-#1095/#1097).
  if (content.coverageLine) {
    parts.push(renderCoverage(content.coverageLine));
  }

  // #1648: CTA de destaque (ex: sorteio ao vivo) logo após a coverage line.
  if (content.introCallout) {
    parts.push(renderIntroCallout(content.introCallout));
  }

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
  // #1279: reveal "Na última edição..." renderiza entre SORTEIO e PARA ENCERRAR
  if (content.erroIntencional) parts.push(renderErroIntencionalReveal(content.erroIntencional));
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
