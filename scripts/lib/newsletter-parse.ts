/**
 * newsletter-parse.ts (#1889)
 *
 * Parse phase: markdown → NewsletterContent.
 * Extracted from render-newsletter-html.ts — byte-identical functions.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseDestaques, buildSubtitle, type Destaque as BaseDestaque } from "../extract-destaques.js";
import { parseInlineLink, parseInlineLinkWithTrailing } from "./inline-link.ts"; // #599, #1581
import { buildPrevResultLine, readPrevPollStats } from "../eia-compose.ts"; // #1707 fallback
import {
  sectionEmojiPrefix,
  sectionHeaderRegex,
  ALL_SECTION_NAMES_PATTERN,
} from "./section-naming.ts";

// ── Category → emoji mapping (matches Beehiiv template) ──────────────
export const CATEGORY_EMOJI: Record<string, string> = {
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

// ── Interfaces ────────────────────────────────────────────────────────
export interface RenderDestaque extends BaseDestaque {
  emoji: string;
  // imageFile removed: was inconsistent (D1=2x1, D2/D3=1x1) and unused after
  // #2133/#2141 expanded hero to all destaques. renderDestaque derives heroFile
  // directly as `04-d${d.n}-2x1.jpg`. (#2158 finding 6)
}

export interface SectionItem {
  title: string;
  description: string;
  url: string;
}

export interface Section {
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

export interface NewsletterContent {
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

const MID_CALLOUT_MARKER = /^\*\*DESTAQUE/m;
const MID_CALLOUT_BLOCK = /^\*\*\s*((?:📚|📣|🎉)[\s\S]+?)\*\*\s*$/m;

/**
 * Pure (#1972): localiza o bloco do midCallout no texto bruto, retornando o
 * conteúdo interno + os índices absolutos do match (`**…**` completo). Base
 * compartilhada por `extractMidCallout` (lê o conteúdo) e `stripMidCalloutFromD1`
 * (remove o bloco do corpo do D1). Região = entre o 1º e o 2º `**DESTAQUE`
 * (mesma do split legado, mas preservando offsets pra poder fatiar).
 */
function locateMidCallout(
  text: string,
): { inner: string; matchStart: number; matchEnd: number } | null {
  const firstMarker = text.search(MID_CALLOUT_MARKER);
  if (firstMarker === -1) return null;
  // 2º marcador (se houver) delimita o fim da região do D1.
  const afterFirst = text.slice(firstMarker + 1);
  const secondRel = afterFirst.search(MID_CALLOUT_MARKER);
  const regionEnd = secondRel === -1 ? text.length : firstMarker + 1 + secondRel;
  const region = text.slice(firstMarker, regionEnd);
  const m = MID_CALLOUT_BLOCK.exec(region);
  if (!m) return null;
  const matchStart = firstMarker + m.index;
  return { inner: m[1].trim(), matchStart, matchEnd: matchStart + m[0].length };
}

/**
 * Callout box posicionado ENTRE o 1º e o 2º destaque (ex: promo da página de
 * livros). Mesmo estilo teal do introCallout. Procura um parágrafo
 * bold-wrapped iniciado por 📚/📣/🎉 na região do 1º destaque (tudo após
 * `**DESTAQUE 1` e antes de `**DESTAQUE 2`). Não casa títulos de destaque
 * (começam com `[`) nem headers de seção (vêm após o 3º destaque).
 */
export function extractMidCallout(text: string): string | null {
  return locateMidCallout(text)?.inner ?? null;
}

/**
 * Pure (#1972): remove o bloco do midCallout do texto bruto ANTES do parse dos
 * destaques. Sem isso, um callout colado ANTES do `---` de fechamento do D1
 * (em vez de isolado entre dois `---`) é absorvido pelo corpo/why do D1 pelo
 * `parseDestaques` (que fatia em `^---$`) E renderizado como midCallout → box
 * duplicado e quebrado (260609). De-dup determinístico, robusto à posição do
 * `---`: o callout sai SÓ como midCallout. Idempotente quando não há callout.
 */
export function stripMidCalloutFromD1(text: string): string {
  const loc = locateMidCallout(text);
  if (!loc) return text;
  const without = text.slice(0, loc.matchStart) + text.slice(loc.matchEnd);
  // Colapsa as linhas em branco órfãs deixadas pela remoção (evita parágrafo
  // vazio). `(?:\r?\n)` (não `\n`) pra cobrir CRLF: sob `\r\n`, o `\s*$` do
  // MID_CALLOUT_BLOCK consome o `\r` mas para antes do `\n`, deixando o seam
  // `\r\n\r\n\n\r\n` — newlines intercalados com `\r` que `/\n{3,}/` não casaria.
  return without.replace(/(?:\r?\n){3,}/g, "\n\n");
}

/**
 * #2136: discrimina se o midCallout é o box de livros (📚 ou link para
 * livros.diaria.workers.dev) ou outro box (ex: divulgação CLARICE 📣).
 * A imagem livros_promo só deve ser associada ao box de livros.
 */
export function isMidCalloutLivros(text: string | null | undefined): boolean {
  if (!text) return false;
  // #260622: box combinado Livros+Cursos NÃO é o promo de livros — é um box de
  // seções com múltiplos CTAs (renderizado como texto, sem o screenshot da
  // página de livros). Se o texto também linka cursos.diaria.workers.dev,
  // tratar como box de seções (false), não promo de livros.
  if (/cursos\.diaria\.workers\.dev/i.test(text)) return false;
  // Marcador 📚 OU link apontando para livros.diaria.workers.dev
  return /^\s*📚/u.test(text) || /livros\.diaria\.workers\.dev/i.test(text);
}

/**
 * URL pública da imagem do box do meio (entry `livros_promo` de
 * `06-public-images.json`), se presente. Lida no momento do render (o cache já
 * existe — upload-images-public roda antes). Graceful: ausente → null.
 *
 * #2136: só retorna a imagem se o midCallout for o box de livros. Box 📣
 * CLARICE (e outros sem link livros.diaria.workers.dev) → null (sem hero).
 */
export function readMidCalloutImage(
  editionDir: string,
  midCalloutText?: string | null,
): string | null {
  // #2136: imagem livros_promo só vai pro box de livros, nunca pro box CLARICE.
  // #finding-6: undefined (sem texto) é tratado como "desconhecido" → null por segurança.
  // Apenas `null` explícito bypassa (back-compat para callers antigos sem texto disponível).
  // Contrato: passe o texto do callout sempre que disponível; omitir é seguro mas
  // conservador (nunca anexa imagem livros_promo sem confirmação explícita de ser box livros).
  if (midCalloutText == null || !isMidCalloutLivros(midCalloutText)) {
    return null;
  }
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

  // #1972: remove o bloco do midCallout ANTES do parse dos destaques. Se o
  // callout estiver colado antes do `---` de fechamento do D1, o parser o
  // absorveria no corpo/why do D1 (render duplicado). Strip → sai só como
  // midCallout (extraído abaixo do texto original). De-dup determinístico.
  const destaquesText = stripMidCalloutFromD1(reviewedText);

  // Destaques: use shared parser from extract-destaques.ts (single source of truth)
  // #2316: aceita 2–3 destaques (o caso editorial legítimo é 2 quando o editor
  // demove um destaque para Radar sem ter um substituto). Menos de 2 → erro fatal
  // (newsletter sem destaque não faz sentido); mais de 3 → erro fatal (template
  // não tem layout para 4+ destaques — parseDestaques regex `([123])` só captura
  // 1/2/3 e Destaque.n é typed `1 | 2 | 3`, então "4" nunca é retornado; o guard
  // alinha ao range real). Para 3 destaques, comportamento inalterado.
  const baseDestaques = parseDestaques(destaquesText);
  if (baseDestaques.length < 2 || baseDestaques.length > 3) {
    throw new Error(
      `Expected 2–3 destaques, got ${baseDestaques.length}. ` +
      `Verifique a formatação em ${reviewedPath}.`,
    );
  }

  // Enrich with emoji (#2158: imageFile removed — renderDestaque derives heroFile
  // directly as `04-d${d.n}-2x1.jpg` after #2133/#2141 expanded hero to all 3)
  const destaques: RenderDestaque[] = baseDestaques.map((d) => ({
    ...d,
    emoji: CATEGORY_EMOJI[d.category] || "📌",
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
  // #2136: passa o texto do midCallout pra discriminar livros vs CLARICE.
  // Imagem só vai pro box de livros; box 📣 CLARICE recebe null (sem hero).
  const midCalloutImage = readMidCalloutImage(editionDir, midCallout);

  // #2316: subtitle adapta-se ao número real de destaques.
  // Com 2 destaques: só D2 (sem o separador " | "). Com 3: D2 | D3 (padrão).
  // Explicit undefined check — subtitleD3 pode ser "" (título vazio) que é
  // falsy mas ainda indica que o destaque existe; undefined = sem D3.
  const subtitleD2 = destaques[1]?.title ?? "";
  const subtitleD3 = destaques[2]?.title;
  const subtitle = subtitleD3 !== undefined
    ? buildSubtitle(subtitleD2, subtitleD3)
    : subtitleD2.slice(0, 200);

  return {
    title: destaques[0].title,
    subtitle,
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
 * Pre-processor #1213: junta links markdown quebrados em múltiplas linhas
 * em um único `[label](url)`.
 *
 * Writer agent às vezes emite links no formato:
 *
 *   - [Melhores cursos grátis de IA](
 *   https://cursos.diaria.workers.dev
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

/**
 * #1279: filtra o parágrafo reveal do bloco ERRO INTENCIONAL. Exportado pra
 * teste e reutilizado pelo render module.
 *
 * #1859: o reveal é o parágrafo que descreve o erro da edição anterior.
 * Antes exigia prefixo literal "Na última edição" — qualquer reescrita
 * (editor no Drive, ou o fix #1854 ajustando a edição/data revelada)
 * derrubava o bloco ERRO INTENCIONAL INTEIRO do HTML, silenciosamente.
 * Agora: prefixo explícito é o caminho feliz; senão, cai no 1º parágrafo
 * que REFERENCIA a edição anterior (temporal) e não é teaser/boilerplate.
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
