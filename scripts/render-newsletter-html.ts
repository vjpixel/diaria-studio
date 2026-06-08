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
import { COLORS, FONTS } from "./lib/design-tokens.ts"; // #1936
import { buildPrevResultLine, readPrevPollStats } from "./eia-compose.ts"; // #1707 fallback

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
  sectionHeaderRegex,
  ALL_SECTION_NAMES_PATTERN,
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
  /** Box (estilo teal) posicionado ENTRE o 1º e o 2º destaque — ex: promo
   * da nova página de livros. Parágrafo bold-wrapped `**📚 ...**` (ou 📣/🎉)
   * colocado entre `**DESTAQUE 1` e `**DESTAQUE 2` no reviewed.md. */
  midCallout?: string | null;
  /** URL pública de uma imagem (ex: screenshot da página de livros) pra
   * tornar o box do meio mais proeminente: imagem + texto + botão CTA.
   * Lida de `06-public-images.json` (entry `livros_promo`). Ausente → box só-texto. */
  midCalloutImage?: string | null;
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
// #1737: pattern + emoji prefix vêm de section-naming.ts (fonte única). Forma
// preservada: bold opcional, grupo 1 = nome sem emoji, `\s*$` tolera trailing
// whitespace. MUDANÇA INTENCIONAL: o prefixo de emoji antes era o loose
// `[^\sA-Za-zÁ-ú]+` (casava dígitos/pontuação como "123 RADAR"); agora é o range
// Unicode tight compartilhado (flag "u"). Validado byte-a-byte contra todas as
// edições reais (#1737).
const SECTION_HEADER_RE = sectionHeaderRegex(ALL_SECTION_NAMES_PATTERN, {
  capture: "name",
  flags: "mu",
});

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

/**
 * #1707: resolve a linha "Resultado da última edição: X% das pessoas acertaram".
 * Usa a do `01-eia.md` se presente; senão injeta do `_internal/04-eia-poll-stats.json`
 * (fallback anti-race — o eia-compose roda em background no Stage 1 e pode compor o
 * 01-eia.md ANTES do fetch-poll-stats gravar o JSON, perdendo a linha). Single-source
 * do formato + leitura via eia-compose (`buildPrevResultLine`/`readPrevPollStats`).
 * Retorna `undefined` quando não há linha nem stats válidas (skipped/below_threshold).
 */
export function resolvePrevResultLine(
  eiaPrevLine: string | undefined,
  editionDir: string,
): string | undefined {
  // #1763: preferir o poll-stats JSON (`04-eia-poll-stats.json`, fresh e
  // re-fetchável) sobre a linha embutida no `01-eia.md` — esta é baked UMA vez
  // pelo eia-compose no Stage 1 e fica STALE se os stats forem corrigidos
  // depois (ex: rebuild-stats #1757 após votos de teste deletados). Caso real
  // 260603: 01-eia.md tinha "44%" (counter inflado), poll-stats corrigido pra
  // "57%" — o render usava o 44% stale. Fallback pra linha do 01-eia.md quando
  // não há poll-stats válido (anti-race #1707: eia-compose pode compor antes do
  // fetch-poll-stats gravar o JSON; e skipped/below_threshold → undefined).
  const fromStats = buildPrevResultLine(readPrevPollStats(editionDir)) ?? undefined;
  return fromStats ?? eiaPrevLine;
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
 * Pure (#1761): reconcilia o "Selecionamos os Z mais relevantes" da linha de
 * cobertura com o número REAL de itens renderizados (3 destaques + itens das
 * seções secundárias). O Z é setado por `sync-coverage-line.ts` num ponto do
 * pipeline e fica STALE quando o editor adiciona/remove itens no gate. Fazendo
 * isso no render, a fonte de verdade do Z passa a ser o que de fato vai pro HTML.
 *
 * Só substitui o trecho "Selecionamos ..."; preserva X (submissões) e Y
 * (encontrados). Concordância numérica: 1 item → "Selecionamos o artigo mais
 * relevante"; N>1 → "Selecionamos os N mais relevantes".
 */
export function reconcileCoverageCount(line: string, count: number): string {
  if (!line) return line;
  const replacement =
    count === 1
      ? "Selecionamos o artigo mais relevante"
      : `Selecionamos os ${count} mais relevantes`;
  return line.replace(
    /Selecionamos (?:o artigo mais relevante|os \d+ mais relevantes)/i,
    replacement,
  );
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

/**
 * Callout box posicionado ENTRE o 1º e o 2º destaque (ex: promo da página de
 * livros). Mesmo estilo teal do introCallout. Procura um parágrafo
 * bold-wrapped iniciado por 📚/📣/🎉 na região do 1º destaque (tudo após
 * `**DESTAQUE 1` e antes de `**DESTAQUE 2`). Não casa títulos de destaque
 * (começam com `[`) nem headers de seção (vêm após o 3º destaque).
 */
export function extractMidCallout(text: string): string | null {
  const afterD1 = text.split(/^\*\*DESTAQUE/m)[1];
  if (!afterD1) return null;
  const m = afterD1.match(/^\*\*\s*((?:📚|📣|🎉)[\s\S]+?)\*\*\s*$/m);
  return m ? m[1].trim() : null;
}

/**
 * URL pública da imagem do box do meio (entry `livros_promo` de
 * `06-public-images.json`), se presente. Lida no momento do render (o cache já
 * existe — upload-images-public roda antes). Graceful: ausente → null.
 */
export function readMidCalloutImage(editionDir: string): string | null {
  const p = resolve(editionDir, "06-public-images.json");
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    const e = (j.images ?? j)?.livros_promo;
    // `||` (não `??`): string vazia no cache deve cair pro próximo campo / null,
    // senão um `cloudflare_url: ""` viraria `<img src="">` (box quebrado).
    return e?.cloudflare_url || e?.url || null;
  } catch {
    return null;
  }
}

export function extractContent(editionDir: string): NewsletterContent {
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

  // #1707: fallback da linha "Resultado da última edição: X%…" (defesa em profundidade).
  eia.prevResultLine = resolvePrevResultLine(eia.prevResultLine, editionDir);

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
  // #1761: reconcilia o "Selecionamos os N" com o nº REAL de itens renderizados
  // (3 destaques + itens das seções secundárias) — evita N stale após edições de
  // seção no gate. Fonte de verdade do N = o que de fato vai pro HTML.
  const rawCoverageLine = extractCoverageLine(reviewedText);
  const renderedItemCount =
    destaques.length + sections.reduce((sum, sec) => sum + sec.items.length, 0);
  const coverageLine = rawCoverageLine
    ? reconcileCoverageCount(rawCoverageLine, renderedItemCount)
    : rawCoverageLine;
  // #1648: CTA de destaque no topo (ex: convite pro sorteio ao vivo).
  const introCallout = extractIntroCallout(reviewedText);
  // Box entre D1 e D2 (ex: promo da página de livros).
  const midCallout = extractMidCallout(reviewedText);
  const midCalloutImage = readMidCalloutImage(editionDir);

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
    midCallout,
    midCalloutImage,
  };
}

// ── HTML Rendering ────────────────────────────────────────────────────
// Produces email-safe HTML matching Beehiiv's Default template styling.
// Uses inline styles, table layout, Poppins/Inter fonts.

// #1936: design system canônico (vjpixel/diaria-design) — valores inline via
// scripts/lib/design-tokens.ts. Paleta de 4 cores (ink·bege·papel·teal); texto
// sempre ink (sem cinzas — hierarquia por tamanho/peso). Teal = único acento
// (links, kickers, marcas). Réguas/bordas = bege (--rule); ver design-tokens.ts.
const PAPER = COLORS.paper; // --paper #FBFAF6 (fundo/papel)
const SURFACE = COLORS.paperAlt; // --paper-alt #EBE5D0 (boxes/callouts/É IA?)
const TEAL = COLORS.brand; // --brand #00A0A0 (accent: underline/links/CTA/kicker/régua)
const TEXT_COLOR = COLORS.ink; // --ink #171411 (todo o texto)
const RULE = COLORS.rule; // --rule #EBE5D0 (hairline bege sob nomes de seção)
// #1936: DS usa serif Georgia SÓ em manchetes/títulos; CORPO + labels/kickers em
// sans Geist (confirmado pelo template de email do DS + typography.css "Body & UI
// (sans)"). Georgia é email-safe; Geist cai pra system sans em email.
const FONT_HEADING = FONTS.serif;
const FONT_BODY = FONTS.sans;
const FONT_LABEL = FONTS.sans;
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

// #1936 (DS email template): cada seção é UMA linha `<tr><td class="pad">` com
// padding lateral de 48px (mobile → 24px via .pad). Os helpers abaixo retornam
// HTML INTERNO (sem `<tr>`); os render* de topo embrulham na linha padded.
const PAD_SECTION = "40px 48px 0"; // padrão entre seções
const PAD_LEAD = "36px 48px 0"; // destaque líder (D1)

/** Remove emoji/símbolo + espaço do início do label (DS usa ponto ●, não emoji). */
function stripKickerEmoji(s: string): string {
  return s.replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

/**
 * Remove SÓ o marcador de callout (📣/📚/🎉 + variation selector + espaço) do
 * início. Diferente de `stripKickerEmoji`, NÃO engole `[` (markdown-link), aspas
 * ou outros não-alfanuméricos — preservando títulos que começam com link/citação
 * (#1942 review #4).
 */
function stripCalloutMarker(s: string): string {
  return s.replace(/^\s*(?:📣|📚|🎉)️?\s*/u, "").trim();
}

/**
 * Convenção de marcadores de callout (#1942 review #1):
 *   📣 = bloco PATROCINADO (anúncio) → recebe o separador "Divulgação".
 *   🎉 = CTA/sorteio editorial · 📚 = promo interna → SEM disclosure.
 * O disclosure é dirigido por este predicado (não pelo slot intro vs mid), então
 * um anúncio recebe "Divulgação" tanto no topo quanto entre D1 e D2.
 */
export function isSponsoredCallout(text: string | null | undefined): boolean {
  return !!text && /^\s*📣/u.test(text);
}

/** Linha do separador "Divulgação" (disclosure de patrocínio, #1940). */
function renderDivulgacaoSeparator(): string {
  return `<tr><td class="pad" style="padding:32px 48px 0;">${renderKicker("Divulgação")}</td></tr>`;
}

/**
 * Kicker de seção do DS: ponto ● teal + label teal uppercase + régua bege
 * preenchendo o resto da linha. Retorna HTML interno (sem `<tr>`).
 */
function renderKicker(label: string): string {
  const clean = esc(stripKickerEmoji(label));
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="font-family:${FONT_LABEL};font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:${TEAL};white-space:nowrap;padding-right:12px;"><span style="color:${TEAL};">&#9679;</span>&nbsp;${clean}</td>
    <td style="width:100%;border-bottom:1px solid ${RULE};font-size:0;line-height:0;">&nbsp;</td>
  </tr></table>`;
}

/** Manchete de destaque: Georgia 26px, ink, underline teal (link). HTML interno. */
function renderHeadlineInner(title: string, url: string): string {
  // #1941: underline em TODAS as linhas do título multi-linha. A versão #1936
  // usava `border-bottom` num `display:inline-block` — a borda traça só o rodapé
  // da caixa, ou seja, embaixo da última linha. `text-decoration:underline`
  // sublinha cada linha do texto. Mantemos a cor teal via `text-decoration-color`
  // (honrado por Apple Mail / Gmail moderno); onde o client remove (Outlook),
  // degrada pra cor do texto/ink — ainda sublinhado em todas as linhas, melhor
  // que o teal só na última. `display:inline-block` preservado pro `margin-top`.
  return `<a class="headline" href="${esc(url)}" style="display:inline-block;margin:18px 0 0;font-family:${FONT_HEADING};font-size:26px;line-height:1.2;color:${TEXT_COLOR};text-decoration:underline;text-decoration-color:${TEAL};text-decoration-thickness:2px;text-underline-offset:3px;" target="_blank" rel="noopener noreferrer nofollow">${esc(title)}</a>`;
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

/** Imagem hero (só D1) + legenda sans 12px uppercase ink (DS). HTML interno. */
function renderHeroImageInner(placeholder: string, alt = "", caption = imageGeneratorCredit()): string {
  return `<img class="hero" src="{{IMG:${placeholder}}}" alt="${esc(alt)}" width="100%" style="display:block;width:100%;height:auto;border-radius:6px;margin-top:24px;" border="0"/>
  <p style="margin:10px 0 0;font-family:${FONT_LABEL};font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${TEXT_COLOR};">${esc(caption)}</p>`;
}

/** Parágrafos do corpo: sans 16px line-height 1.62 ink (DS). HTML interno. */
function renderBodyParasInner(text: string): string {
  return text
    .split(/\n\n+/)
    .filter((p) => p.trim())
    .map(
      (p, i) =>
        `<p style="margin:${i === 0 ? "18px" : "16px"} 0 0;font-family:${FONT_BODY};font-size:16px;line-height:1.62;color:${TEXT_COLOR};">${escText(p.trim())}</p>`,
    )
    .join("\n  ");
}

/** "Por que isso importa": box "contorno" do DS (papel + borda bege + kicker teal). HTML interno. */
function renderWhyBoxInner(text: string): string {
  const body = text.split(/\n\n+/).filter((p) => p.trim()).map((p) => escText(p.trim())).join("<br><br>");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;border-collapse:separate;border-spacing:0"><tr>
    <td style="background:${PAPER};border:1px solid ${RULE};border-radius:12px;padding:23px 27px;">
      <p style="margin:0 0 10px;font-family:${FONT_LABEL};font-size:12px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:${TEAL};">Por que isso importa</p>
      <p style="margin:0;font-family:${FONT_BODY};font-size:16px;line-height:1.62;color:${TEXT_COLOR};">${body}</p>
    </td>
  </tr></table>`;
}

/**
 * #1093: bloco de cobertura no topo do email. Tipograficamente discreto —
 * cinza médio, itálico, sem box ou border — pra não competir com o primeiro
 * destaque. Aparece logo após o header gerado pelo template Beehiiv (título +
 * subtítulo) e antes do primeiro destaque.
 */
export function renderCoverage(text: string): string {
  // #1936 (DS): INTRO = parágrafo sans ink (não mais cinza itálico). Primeira
  // seção, padding 44px 48px 8px.
  return `<!-- INTRO (coverage) -->
<tr><td class="pad" style="padding:44px 48px 8px;">
  <p style="margin:0;font-family:${FONT_BODY};font-size:16px;line-height:1.6;color:${TEXT_COLOR};">${escText(text)}</p>
</td></tr>`;
}

/**
 * #1648: CTA de destaque no topo (ex: convite pro sorteio ao vivo). DS: box
 * "painel" (bege), texto peso 600. Links via processInlineLinks (underline teal).
 */
export function renderIntroCallout(text: string): string {
  // #1938: split em parágrafos (`\n\n`). Callout de 1 parágrafo (intro/sorteio)
  // mantém o comportamento antigo (negrito, emoji preservado). Bloco
  // multi-parágrafo (ex: divulgação CLARICE reaproveitada da mensal) segue o DS:
  // 1º parágrafo = título serif (emoji de marcação removido), demais = corpo
  // peso normal; os links já saem em negrito via processInlineLinks.
  const sponsored = isSponsoredCallout(text);
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  let inner: string;
  if (paras.length > 1) {
    // multi-parágrafo: 1º = título serif (marcador 📣/📚/🎉 removido), demais = corpo normal.
    const title = stripCalloutMarker(paras[0]);
    const titleHtml = `<p style="margin:0 0 14px;font-family:${FONT_HEADING};font-size:20px;line-height:1.2;color:${TEXT_COLOR};">${processInlineLinks(title)}</p>`;
    const bodyHtml = paras
      .slice(1)
      .map(
        (p, i) =>
          `<p style="margin:${i === 0 ? "0" : "12px"} 0 0;font-family:${FONT_BODY};font-size:16px;line-height:1.62;color:${TEXT_COLOR};">${processInlineLinks(p)}</p>`
      )
      .join("\n      ");
    inner = `${titleHtml}\n      ${bodyHtml}`;
  } else {
    // 1 parágrafo: anúncio (📣) tem o marcador removido — o separador "Divulgação"
    // já rotula (#1942 review #3). 🎉/📚 preservam o emoji decorativo.
    const single = paras[0] ?? text;
    const only = sponsored ? stripCalloutMarker(single) : single;
    inner = `<p style="margin:0;font-family:${FONT_BODY};font-weight:600;font-size:16px;line-height:1.5;color:${TEXT_COLOR};">${processInlineLinks(only)}</p>`;
  }
  return `<!-- #1648 intro callout (sorteio/CTA) -->
<tr><td class="pad" style="padding:8px 48px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SURFACE};border-radius:12px;">
    <tr><td style="padding:16px 20px;">
      ${inner}
    </td></tr>
  </table>
</td></tr>`;
}

/**
 * Acha os links markdown `[texto](url)` de `s` com parsing de parênteses
 * balanceados (#1634 — a regex ingênua `\(([^)]+)\)` trunca URLs que contêm
 * parênteses, ex: `...(1).pdf`). Retorna {url, start, end} na ordem de aparição;
 * `end` é exclusivo (índice logo após o `)` de fechamento).
 */
function findMarkdownLinks(
  s: string,
): { url: string; start: number; end: number }[] {
  const out: { url: string; start: number; end: number }[] = [];
  const linkStart = /\[[^\]]+\]\(/g;
  let m: RegExpExecArray | null;
  while ((m = linkStart.exec(s)) !== null) {
    const destStart = m.index + m[0].length;
    let depth = 0;
    let j = destStart;
    for (; j < s.length; j++) {
      const ch = s[j];
      if (ch === "(") depth++;
      else if (ch === ")") {
        if (depth === 0) break;
        depth--;
      }
    }
    if (j >= s.length) continue; // sem `)` de fechamento — não é link válido
    out.push({ url: s.slice(destStart, j).trim(), start: m.index, end: j + 1 });
    linkStart.lastIndex = j + 1;
  }
  return out;
}

/**
 * Box do meio (entre D1 e D2) com imagem proeminente + texto + botão CTA.
 * Sem imagem → cai no box só-texto (renderIntroCallout). Extrai o link
 * `[texto](url)` do próprio box pra usar na imagem clicável e no botão.
 */
export function renderMidCallout(text: string, imageUrl: string | null): string {
  if (!imageUrl) return renderIntroCallout(text);
  // #1634-safe: parênteses balanceados em vez de `\(([^)]+)\)`. Primeiro link
  // vira destino da imagem clicável + botão; TODOS os links saem do corpo.
  const links = findMarkdownLinks(text);
  const link = links.length ? links[0].url : null;
  let body = text;
  for (let i = links.length - 1; i >= 0; i--) {
    let { start, end } = links[i];
    while (start > 0 && /\s/.test(body[start - 1])) start--; // engole espaço antes
    if (body[end] === ".") end++; // e o ponto final do markdown-link
    body = body.slice(0, start) + body.slice(end);
  }
  body = body.trim();
  // esc() nos atributos: imageUrl vem do cache e link do reviewed.md — escapar
  // `"`/`<`/`>`/`&` evita quebrar o atributo HTML (#code-review 1807).
  const safeImg = esc(imageUrl);
  const safeLink = link ? esc(link) : null;
  const imgTag = `<img src="${safeImg}" width="100%" alt="Nova página de livros sobre IA da Diar.ia" style="display:block;width:100%;height:auto;border:0;border-radius:6px 6px 0 0;" />`;
  const imgBlock = safeLink ? `<a href="${safeLink}" style="text-decoration:none;">${imgTag}</a>` : imgTag;
  const cta = safeLink
    ? `<a href="${safeLink}" style="display:inline-block;background:${TEAL};color:#ffffff;font-family:${FONT_BODY};font-weight:600;font-size:15px;text-decoration:none;padding:10px 20px;border-radius:4px;">Ver os livros &rarr;</a>`
    : "";
  // #1942 review #2: corpo multi-parágrafo não vira blocão. >1 parágrafo → 1º =
  // título serif (marcador removido) + demais peso normal, igual ao caminho
  // sem imagem (#1938). 1 parágrafo mantém o estilo atual (peso 600, emoji preservado).
  const bodyParas = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const bodyHtml =
    bodyParas.length > 1
      ? `<p style="margin:0 0 12px;font-family:${FONT_HEADING};font-size:20px;line-height:1.2;color:${TEXT_COLOR};">${processInlineLinks(stripCalloutMarker(bodyParas[0]))}</p>\n      ` +
        bodyParas
          .slice(1)
          .map(
            (p, i) =>
              `<p style="margin:${i === 0 ? "0" : "12px"} 0 0;font-family:${FONT_BODY};font-size:16px;line-height:1.62;color:${TEXT_COLOR};">${processInlineLinks(p)}</p>`
          )
          .join("\n      ")
      : `<p style="margin:0 0 12px;font-family:${FONT_BODY};font-weight:600;font-size:16px;line-height:1.5;color:${TEXT_COLOR};">${processInlineLinks(body)}</p>`;
  return `<!-- mid callout com imagem (promo página de livros) -->
<tr><td class="pad" style="padding:8px 48px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SURFACE};border-radius:12px;">
    <tr><td style="padding:0;line-height:0;font-size:0;">${imgBlock}</td></tr>
    <tr><td style="padding:16px 20px;">
      ${bodyHtml}
      ${cta}
    </td></tr>
  </table>
</td></tr>`;
}

function renderDestaque(d: RenderDestaque): string {
  // #1936 (DS email template): seção = uma linha padded (48px lateral). Estrutura:
  // kicker (●+régua) → manchete Georgia 26px (underline teal) → imagem hero (só
  // D1, #1077) → parágrafos sans → box "Por que isso importa". Sem <hr> separador
  // (cada seção abre com seu próprio kicker).
  const showInlineImage = d.n === 1;
  const pad = d.n === 1 ? PAD_LEAD : PAD_SECTION;
  const inner = [
    renderKicker(d.category),
    renderHeadlineInner(d.title, d.url),
    showInlineImage ? renderHeroImageInner(d.imageFile, d.title) : "",
    renderBodyParasInner(d.body),
    renderWhyBoxInner(d.why),
  ].filter(Boolean).join("\n  ");
  return `<!-- Destaque ${d.n} -->
<tr><td class="pad" style="padding:${pad};">
  ${inner}
</td></tr>`;
}

function renderEIA(eia: EIA): string {
  const creditHtml = processInlineLinks(eia.credit);
  // Leaderboard (#1160): linha "🏆 Vencedores…" sans ink dentro do painel.
  const lbStyle = `margin:8px 0 0;font-family:${FONT_BODY};font-size:13px;line-height:1.5;color:${TEXT_COLOR};`;
  const leaderboardRow = renderLeaderboardTop1Row(eia, lbStyle);

  // #1630: "Resultado da última edição: X% acertaram" — DS: sans 12px bold
  // uppercase teal, no rodapé do painel.
  const prevResultHtml = eia.prevResultLine
    ? `\n      <tr><td><p style="margin:6px 0 0;font-family:${FONT_LABEL};font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:${TEAL};">${processInlineLinks(eia.prevResultLine)}</p></td></tr>`
    : "";

  const buildVoteUrl = (choice: "A" | "B") =>
    `${POLL_WORKER_URL}/vote?email={{email}}&edition=${eia.edition}&choice=${choice}&sig={{poll_sig}}`;
  // DS: imagens A/B lado a lado, poll-col empilha no mobile.
  const eiaChoice = (choice: "A" | "B", imgFile: string, side: "a" | "b") => {
    const img = `<img src="{{IMG:${imgFile}}}" alt="Imagem ${choice}" width="100%" style="display:block;width:100%;height:auto;border-radius:6px;" border="0"/>`;
    const inner = eia.edition
      ? `<a href="${buildVoteUrl(choice)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;">${img}</a>`
      : img;
    const pad = side === "a" ? "padding-right:8px;" : "padding-left:8px;";
    const cls = side === "a" ? "poll-col" : "poll-col poll-col-b";
    return `<td class="${cls}" valign="top" width="50%" style="${pad}">${inner}</td>`;
  };

  return `<!-- É IA? (poll) -->
<tr><td class="pad" style="padding:${PAD_SECTION};">
  ${renderKicker("É IA?")}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;border-collapse:separate;border-spacing:0"><tr>
    <td style="background:${SURFACE};border-radius:12px;padding:24px 28px;">
      <p style="margin:0;font-family:${FONT_HEADING};font-size:22px;line-height:1.15;color:${TEXT_COLOR};">Clique na imagem que foi gerada por IA.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;"><tr>
        ${eiaChoice("A", eia.imageA, "a")}
        ${eiaChoice("B", eia.imageB, "b")}
      </tr></table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td>
        <p style="margin:16px 0 0;font-family:${FONT_BODY};font-size:12px;line-height:1.5;color:${TEXT_COLOR};">${creditHtml}</p>
      </td></tr>${prevResultHtml}
${leaderboardRow}
      </table>
    </td>
  </tr></table>
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
        // #1672: `top1` (worker computeTop1) são TODOS líderes em rank 1 —
        // empatados (mesmo pct E mesmo correct, sem campo rank). Atribuir rank 1 a
        // todos, não i+1, senão fabricamos 2º/3º (ordem alfabética acidental) pra
        // quem empatou em 1º.
        ? eia.leaderboardTop1.map((e) => ({ nickname: e.nickname, rank: 1 }))
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

/**
 * Item de lista (Use melhor / Lançamentos / Radar) no padrão DS: título Georgia
 * 22px com underline teal + descrição sans ink. Itens separados por spacer 22px
 * (exceto o primeiro). Retorna um `<tr>` com o item; HTML interno do bloco.
 */
function renderSectionItem(item: SectionItem, first: boolean): string {
  const titleHtml = item.url
    ? `<a href="${esc(item.url)}" style="font-family:${FONT_HEADING};font-size:22px;line-height:1.14;color:${TEXT_COLOR};text-decoration:none;border-bottom:1px solid ${TEAL};" target="_blank" rel="noopener noreferrer nofollow">${esc(item.title)}</a>`
    : `<span style="font-family:${FONT_HEADING};font-size:22px;line-height:1.14;color:${TEXT_COLOR};">${esc(item.title)}</span>`;
  const spacer = first ? "" : `<div style="height:22px;line-height:22px;font-size:0;">&nbsp;</div>`;
  const desc = item.description
    ? `\n      <p style="margin:7px 0 0;font-family:${FONT_BODY};font-size:16px;line-height:1.6;color:${TEXT_COLOR};">${esc(item.description)}</p>`
    : "";
  return `<tr><td style="padding:22px 0 0;">
      ${spacer}${titleHtml}${desc}
    </td></tr>`;
}

// #1324: singularizeSectionName movido pra scripts/lib/section-naming.ts.
// Re-export pra retrocompat caller importando direto deste módulo.
export { singularizeSectionName } from "./lib/section-naming.ts";

function renderSection(section: Section): string {
  if (section.items.length === 0) return "";

  const itemsHtml = section.items
    .map((item, i) => renderSectionItem(item, i === 0))
    .join("\n    ");

  // #1070 + #1328: singular quando só tem 1 item. stripKickerEmoji remove o emoji
  // (DS usa ponto ●, não emoji).
  const displayName = displaySectionName(section.name, section.items.length);

  return `<!-- ${section.name} -->
<tr><td class="pad" style="padding:${PAD_SECTION};">
  ${renderKicker(displayName)}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
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
export function pickErroIntencionalReveal(text: string): string | null {
  const paragraphs = text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  // #1859: o reveal é o parágrafo que descreve o erro da edição anterior.
  // Antes exigia prefixo literal "Na última edição" — qualquer reescrita
  // (editor no Drive, ou o fix #1854 ajustando a edição/data revelada)
  // derrubava o bloco ERRO INTENCIONAL INTEIRO do HTML, silenciosamente.
  // Agora: prefixo explícito é o caminho feliz; senão, cai no 1º parágrafo
  // que REFERENCIA a edição anterior (temporal) e não é teaser/boilerplate.
  const isTeaserOrBoilerplate = (p: string): boolean =>
    /^Nessa\s+edi[çc][ãa]o/i.test(p) ||
    /^Esta\s+edi[çc][ãa]o\s+tem\s+um\s+erro/i.test(p) ||
    /\{PREENCHER/i.test(p);
  const explicit = paragraphs.find((p) => /^Na última edição/i.test(p));
  if (explicit) return explicit;
  // Fallback só dispara pra parágrafo que referencia a edição ANTERIOR
  // (temporal). Assim um reveal reescrito pelo editor ("Na edição de ontem…",
  // "Há duas edições atrás…", "Na edição anterior…", "Na última edição…")
  // ainda renderiza, mas texto solto/placeholder ("Apenas placeholder do
  // editor.") não vira um callout fantasma com o reveal errado.
  // Sem `\b`: o JS `\b` é ASCII-only e NÃO cria boundary antes do "ú" acentuado
  // (U+00FA), então `\b[úu]ltim` jamais casava "última" — a palavra mais comum
  // num reveal. Estas palavras são distintivas o bastante pra dispensar boundary.
  const REVEAL_HINT_RE = /[úu]ltim[ao]|anterior|passad[ao]|ontem|edi[çc][õo]es/i;
  const fallback = paragraphs.find(
    (p) => !isTeaserOrBoilerplate(p) && REVEAL_HINT_RE.test(p),
  );
  if (fallback) {
    console.error(
      `[render-newsletter-html] #1859: reveal do ERRO INTENCIONAL não começa com ` +
        `"Na última edição" — usando parágrafo que referencia a edição anterior: ` +
        `"${fallback.slice(0, 60)}…". Confira se é o reveal correto.`,
    );
    return fallback;
  }
  return null;
}

function renderErroIntencionalReveal(text: string): string {
  const reveal = pickErroIntencionalReveal(text);
  if (!reveal) return "";
  // DS: box "contorno" (papel + borda bege) logo abaixo dos parágrafos do
  // Sorteio — diferencia o reveal (informativo) dos painéis preenchidos.
  // Top padding pequeno (14px) pra encostar na seção acima, sem kicker próprio.
  return `<!-- ERRO INTENCIONAL — reveal -->
<tr><td class="pad" style="padding:14px 48px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0"><tr>
    <td style="background:${PAPER};border:1px solid ${RULE};border-radius:12px;padding:24px 28px;">
      <p style="margin:0;font-family:${FONT_BODY};font-size:16px;line-height:1.62;color:${TEXT_COLOR};">${mdInlineToHtml(reveal)}</p>
    </td>
  </tr></table>
</td></tr>`;
}

/**
 * Pure (#1076): bloco SORTEIO no padrão DS — kicker (●+régua) + parágrafos sans.
 * O reveal "Na última edição…" vai num box painel separado (renderErroIntencionalReveal).
 */
function renderSorteio(text: string): string {
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim());
  const html = paragraphs.map((p, i) =>
    `<p style="margin:${i === 0 ? "22px" : "12px"} 0 0;font-family:${FONT_BODY};font-size:16px;line-height:1.62;color:${TEXT_COLOR};">${mdInlineToHtml(p.trim())}</p>`
  ).join("\n  ");
  return `<!-- Sorteio -->
<tr><td class="pad" style="padding:${PAD_SECTION};">
  ${renderKicker("Sorteio")}
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

  // DS: lista `- [label](url)` vira PILLS (borda bege, radius 999px) precedidas
  // do rótulo "Acesse:". Parágrafos = sans ink com links underline teal.
  const pillStyle = `display:inline-block;border:1px solid ${RULE};border-radius:999px;padding:10px 18px;font-family:${FONT_LABEL};font-size:12px;font-weight:bold;color:${TEXT_COLOR};text-decoration:none;`;
  const renderBlock = (b: { type: "p" | "ul"; content: string[] }) => {
    if (b.type === "ul") {
      const cells = b.content.map((c) => {
        const m = c.match(/^\[([^\]]+)\]\((.+)\)$/);
        // Link puro → pill clicável. Senão, mdInlineToHtml (links/bold inline)
        // pra NUNCA vazar markdown cru (invariante "output sem markdown").
        const pill = m
          ? `<a href="${esc(m[2].trim())}" style="${pillStyle}">${esc(m[1])}</a>`
          : `<span style="${pillStyle}">${mdInlineToHtml(c)}</span>`;
        return `<td style="padding:0 10px 10px 0;">${pill}</td>`;
      }).join("");
      return `<p style="margin:22px 0 8px;font-family:${FONT_LABEL};font-size:12px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:${TEXT_COLOR};">Acesse:</p>
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table>`;
    }
    return `<p style="margin:22px 0 0;font-family:${FONT_BODY};font-size:16px;line-height:1.62;color:${TEXT_COLOR};">${mdInlineToHtml(b.content.join(" "))}</p>`;
  };

  const html = mainBlocks.map(renderBlock).join("\n  ");

  // CTA final ("Agora que chegou…") = box "painel" do DS.
  const ctaBox = ctaBlock
    ? `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;border-collapse:separate;border-spacing:0"><tr>
    <td style="background:${SURFACE};border-radius:12px;padding:24px 28px;">
      <p style="margin:0;font-family:${FONT_BODY};font-size:16px;line-height:1.62;color:${TEXT_COLOR};">${mdInlineToHtml(ctaBlock.content.join(" "))}</p>
    </td>
  </tr></table>`
    : "";

  return `<!-- Para encerrar -->
<tr><td class="pad" style="padding:40px 48px 8px;">
  ${renderKicker("Para encerrar")}
  ${html}${ctaBox}
</td></tr>`;
}

export interface RenderOpts {
  /** #1046 — quando `true`, omite a seção É IA? do body. Usado pelo paste
   * híbrido (Stage 4 publish-newsletter): body via ClipboardEvent + È IA?
   * via insertContent pra preservar merge tags `{{poll_x_url}}` que TipTap
   * normalizaria. Default false (output legado: body único com È IA? embutido). */
  excludeEia?: boolean;
  /** #1936 — quando `true`, embrulha o container num documento HTML completo
   * (doctype + body bege + preheader + tabela de centralização). Usado pro
   * preview/email Worker-hosted. Default `false`: emite só o container 600px
   * (fragmento pro paste no Beehiiv, que provê o shell). */
  fullDocument?: boolean;
}

// #1936 (DS): media query + hover do template de email. Progressive enhancement
// (Gmail/Apple Mail honram); o design carrega nos estilos inline.
const DS_STYLE_BLOCK = `<style>
  body { margin:0; padding:0; width:100% !important; }
  img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
  table { border-collapse:collapse; }
  a.headline:hover { color:${TEAL} !important; }
  @media only screen and (max-width:480px) {
    .container { width:100% !important; }
    .pad { padding-left:24px !important; padding-right:24px !important; }
    .poll-col { display:block !important; width:100% !important; padding:0 !important; }
    .poll-col-b { padding-top:12px !important; }
    .hero { height:auto !important; }
  }
</style>`;

export function renderHTML(content: NewsletterContent, opts: RenderOpts = {}): string {
  const parts: string[] = [];

  // #1093: linha de cobertura no topo, antes do primeiro destaque. Graceful
  // skip quando ausente (edições antigas pré-#1095/#1097).
  if (content.coverageLine) {
    parts.push(renderCoverage(content.coverageLine));
  }

  // #1648: CTA de destaque (ex: sorteio ao vivo) logo após a coverage line.
  if (content.introCallout) {
    // #1942 review #1: disclosure também cobre anúncio (📣) colocado no topo.
    if (isSponsoredCallout(content.introCallout)) parts.push(renderDivulgacaoSeparator());
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
    // Box entre D1 e D2 (ex: promo da página de livros). Reusa o estilo teal
    // do introCallout. Posicionado após o 1º destaque.
    if (i === 0 && content.midCallout) {
      // #1940: separador "Divulgação" antes de bloco PATROCINADO (📣). Promo
      // interna (📚) e sorteio (🎉) não recebem disclosure — ver isSponsoredCallout.
      if (isSponsoredCallout(content.midCallout)) parts.push(renderDivulgacaoSeparator());
      parts.push(renderMidCallout(content.midCallout, content.midCalloutImage ?? null));
    }
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

  // #1936 (DS): container de 600px (papel + trilhos bege) — a estrutura do
  // template de email do DS. Cada `part` é uma linha `<tr><td class="pad">`.
  const container = `<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:${PAPER};border-left:1px solid ${RULE};border-right:1px solid ${RULE};">
${parts.join("\n")}
</table>`;

  if (!opts.fullDocument) {
    // Fragmento pro Beehiiv: container + style (progressive enhancement).
    return `<!-- Diar.ia newsletter body — auto-generated by render-newsletter-html.ts -->
${DS_STYLE_BLOCK}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SURFACE};"><tr><td align="center" style="padding:0;">
${container}
</td></tr></table>`;
  }

  // Documento completo (preview / email Worker-hosted): shell bege + preheader.
  const preheader = esc(
    content.destaques.map((d) => d.title).filter(Boolean).slice(0, 2).join(" · "),
  );
  return `<!doctype html>
<html lang="pt-BR" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<title>Diar.ia — Edição</title>
${DS_STYLE_BLOCK}
</head>
<body style="margin:0; padding:0; background:${SURFACE};">
<div style="display:none; max-height:0; overflow:hidden; opacity:0;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SURFACE};"><tr><td align="center" style="padding:0;">
${container}
</td></tr></table>
</body>
</html>`;
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
    // #1936 --full: documento HTML completo (shell DS + preheader) pro preview/
    // email Worker-hosted. Sem a flag: fragmento container pro paste no Beehiiv.
    output = renderHTML(content, { fullDocument: flags.has("full") });
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
