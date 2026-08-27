/**
 * newsletter-parse.ts (#1889)
 *
 * Parse phase: markdown → NewsletterContent.
 * Extracted from render-newsletter-html.ts — byte-identical functions.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDestaques, buildSubtitle, type Destaque as BaseDestaque } from "../extract-destaques.js";
import { parseBoxHeaderField, isRuntimeExcluded, readBoxTituloFlag } from "./shared/snippet-header.ts"; // #3981 — categoria: do header do snippet; isRuntimeExcluded #4504 — invariant de runtime:false no render path; readBoxTituloFlag #5882 — titulo:false declarado
import { parseInlineLink, parseInlineLinkWithTrailing } from "./inline-link.ts"; // #599, #1581
import { buildPrevResultLine, readPrevPollStats } from "../eia-compose.ts"; // #1707 fallback
import {
  sectionEmojiPrefix,
  sectionHeaderRegex,
  ALL_SECTION_NAMES_PATTERN,
} from "./section-naming.ts";
import { countDoubleAsterisk } from "./lint-checks/callout-placement.ts"; // #3762

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
  /** #4991: índice em `sections` após o qual É IA? deve renderizar, derivado
   * de onde o mirror `**É IA?**` aparece de fato no reviewed.md (ver
   * `findEiaAnchorSection`). `null` = mirror ausente, `renderHTML` cai no
   * fallback #3476 (após USE MELHOR). `-1` = mirror presente mas nenhuma
   * seção o precede (renderiza antes de todas). `i` (≥0) = após
   * `sections[i]`. */
  eiaAnchorSectionIdx?: number | null;
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
  /** #3705: texto de coverage que fica DEPOIS do introCallout no MD (ex: editor
   * quer o callout entre 2 parágrafos de boas-vindas, não só no final). Como
   * renderHTML sempre emite coverageLine → introCallout → destaques nessa
   * ordem fixa, esse texto não caberia em nenhum dos dois — é capturado à
   * parte e renderizado logo após o callout, antes do 1º destaque. */
  coverageLineTrailer?: string | null;
  /** Box de divulgação (#2978, marcador-agnóstico desde #3204) posicionado
   * ENTRE o 1º e o 2º destaque — SLOT fixo por posição (gap D1/D2),
   * independente do formato de conteúdo. Aceita QUALQUER bloco isolado por
   * `---` na lacuna (bold-line `**...**` OU multi-parágrafo) — nenhum
   * marcador emoji é exigido; o formato (curto vs CTA/pill) é decidido pela
   * ESTRUTURA do conteúdo, não pelo marcador (ver `renderBoxDivulgacao` em
   * newsletter-render-html.ts). */
  boxDivulgacao1?: string | null;
  /** URL pública de uma imagem (ex: screenshot da página de livros) pra
   * tornar o box 1 mais proeminente: imagem + texto + botão CTA. Lida de
   * `06-public-images.json` (entry `livros_promo`). Ausente → box só-texto. */
  boxDivulgacao1Image?: string | null;
  /** #3373: peso de fonte do box de 1 parágrafo (sem imagem/CTA-pill) —
   * `true` quando a fonte tem `**...**` embrulhando o box inteiro, `false`
   * quando é texto plano. Editor controla o peso pelo markdown do
   * `02-reviewed.md`; não afeta o box com imagem/carrinho (sempre estruturado
   * por título+corpo). Default `true` preserva o visual histórico. */
  boxDivulgacao1Bold?: boolean;
  /** #3981: `categoria:` configurada no header do snippet atualmente
   * atribuído ao slot 1 (`boxes_divulgacao.slot1` em `platform.config.json`)
   * — rótulo exibido como kicker acima do box, substituindo o
   * "Divulgação"/"Agradecimento" default (ver `renderHTML`,
   * `readBoxDivulgacaoCategoriaForSlot`). `null`/ausente -> renderiza
   * exatamente como hoje (sem override de rótulo). Re-derivado do DISCO no
   * momento do render (não via `02-reviewed.md`) — ver docstring de
   * `readBoxDivulgacaoCategoriaForSlot`. */
  boxDivulgacao1Categoria?: string | null;
  /** #4274: box de divulgação posicionado ENTRE a linha/bloco de cobertura e
   * o marcador `**DESTAQUE 1** — SLOT 0 (introdução), o mais alto valor de
   * atenção da edição. Diferente dos slots 1/2/3 (todos ANCORADOS em
   * marcadores `**DESTAQUE`), este vive na região de intro — mesma região
   * onde já moram `introCallout`/o box de agradecimento a apoiadores; ver
   * `locateBoxAtIntro` pela lógica de desambiguação. Default `null`
   * (opcional, decisão editorial #4274 — 5 slots preenchidos seria demais
   * pra uma edição). */
  boxDivulgacao0?: string | null;
  /** Mesmo contrato de `boxDivulgacao1Image`, pro slot 0. */
  boxDivulgacao0Image?: string | null;
  /** Mesmo contrato de `boxDivulgacao1Bold`, pro slot 0. */
  boxDivulgacao0Bold?: boolean;
  /** #3981: mesmo contrato de `boxDivulgacao1Categoria`, pro slot 0. */
  boxDivulgacao0Categoria?: string | null;
  /** Box de divulgação (#2978) posicionado ENTRE o 2º e o 3º destaque — SLOT
   * fixo por posição (gap D2/D3), mesmo contrato de formato do slot 1. Em
   * edições de 2 destaques (sem gap D2/D3) fica sempre `null`. */
  boxDivulgacao2?: string | null;
  /** #2978-slot2-parity: mesmo contrato de `boxDivulgacao1Image`, mas pro slot
   * 2 (gap D2/D3). O box de livros (📚) pode cair em QUALQUER slot a depender
   * da ordem de conteúdo da edição — sem este campo, o box de livros no slot 2
   * degradava pra texto puro (sem imagem/CTA-pill), quebrando paridade com o
   * slot 1. Ausente → box só-texto. */
  boxDivulgacao2Image?: string | null;
  /** #3373: mesmo contrato de `boxDivulgacao1Bold`, pro slot 2. */
  boxDivulgacao2Bold?: boolean;
  /** #3981: mesmo contrato de `boxDivulgacao1Categoria`, pro slot 2. */
  boxDivulgacao2Categoria?: string | null;
  /** #3476: box de divulgação posicionado SEMPRE após o ÚLTIMO destaque (D3 em
   * edições de 3 destaques, D2 em edições de 2), antes de USE MELHOR/É IA? —
   * diferente dos slots 1/2 (lacunas ENTRE destaques), este é a região
   * pós-destaques (ver `extractBoxDivulgacao3`/`locateBoxAfterLastDestaque`).
   * Existe em QUALQUER contagem de destaques (2 ou 3). Mesmo contrato de
   * formato dos slots 1/2 (bold-line OU multi-parágrafo genérico). */
  boxDivulgacao3?: string | null;
  /** Mesmo contrato de `boxDivulgacao1Image`, pro slot 3. Na prática sempre
   * `null` — a imagem `livros_promo` só é associada ao box de livros
   * (`isBoxDivulgacaoLivros`), e o slot 3 (Indicação de Ferramenta) nunca é
   * esse box; mantido pra paridade de contrato/futuro-proofing. */
  boxDivulgacao3Image?: string | null;
  /** Slots cuja imagem veio de `box_slot{N}_image` (atribuição EXPLÍCITA do
   * editor), não de `livros_promo`. O renderer usa isso pra forçar o layout com
   * imagem mesmo em box que normalmente cairia no caminho pill-only. */
  boxDivulgacaoImageExplicit?: { 0?: boolean; 1?: boolean; 2?: boolean; 3?: boolean };
  /** Slots cuja imagem é RETRATO (capa de livro etc): renderizada reduzida e
   * centralizada em vez de ocupar a largura toda do box. */
  boxDivulgacaoImagePortrait?: { 0?: boolean; 1?: boolean; 2?: boolean; 3?: boolean };
  /** `alt:` do snippet de cada slot — texto alternativo da imagem do box. */
  boxDivulgacaoImageAlt?: { 0?: string | null; 1?: string | null; 2?: string | null; 3?: string | null };
  /** #5882: `titulo: false` declarado no header do snippet de cada slot — o
   * 1º parágrafo do box renderiza como prosa corrida (`plainFirstParagraph`
   * em `renderBoxDivulgacao`), não como título serif 26px. Substitui a
   * detecção por regex de copy (`isConviteAmigoBox`, aposentada) — mesmo
   * mecanismo de leitura de `categoria:`/`alt:` acima (disco, no momento do
   * render, via `readBoxDivulgacaoNoTituloForSlot`). Ausente/`false` no
   * mapa -> renderiza exatamente como hoje (título quando a estrutura do box
   * pedir um). */
  boxDivulgacaoNoTitulo?: { 0?: boolean; 1?: boolean; 2?: boolean; 3?: boolean };
  /** Mesmo contrato de `boxDivulgacao1Bold`, pro slot 3. */
  boxDivulgacao3Bold?: boolean;
  /** #3981: mesmo contrato de `boxDivulgacao1Categoria`, pro slot 3. */
  boxDivulgacao3Categoria?: string | null;
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
 * Pure (#1093, formato novo #3456): extrai a linha de cobertura do topo do
 * reviewed.md. Retorna `null` se ausente.
 *
 * Suporta 2 formatos (ambos começam com "Para esta edição,"):
 *   - legado: "Para esta edição, eu (o editor) enviei X submissões e a Diar.ia
 *     encontrou outros Y artigos. Selecionamos os Z mais relevantes..."
 *   - novo (#3456): "Para esta edição, a diar.ia.br analisou N artigos: X
 *     enviados pelo editor, {nome}, e Y encontrados automaticamente. Após a
 *     curadoria, foram selecionados os Z mais relevantes."
 *
 * A linha é injetada pelo writer no topo do reviewed.md (após TÍTULO/SUBTÍTULO e
 * antes do primeiro destaque). #1097 mantém os números sincronizados com Stage 1.
 */
export function extractCoverageLine(text: string): string | null {
  // #3461: formato novo (padrão a partir de 260715) — bloco de boas-vindas
  // multi-parágrafo, sem negrito, começando com "Olá! Eu sou o [Pixel](...)"
  // e ANCORADO na frase-CTA fixa de apoio (sinal inequívoco de que é o bloco
  // de boas-vindas, não outro texto qualquer que comece com "Olá!").
  //
  // #3477 item 4: antes, o match TERMINAVA nessa frase — qualquer parágrafo
  // adicionado DEPOIS dela (ex: agradecimento a novos apoiadores) era
  // descartado silenciosamente do HTML mesmo presente no MD (o editor tinha
  // que colar o parágrafo extra ANTES da frase-fronteira, frágil). Agora a
  // frase-CTA só ANCORA o início do bloco — a captura real se estende até o
  // próximo boundary estrutural (`---` isolado em linha própria, ou o próximo
  // `**DESTAQUE`), o que vier primeiro. Sem boundary (MD malformado) captura
  // até o fim do texto — defensivo, não deveria ocorrer em MD bem formado.
  const anchorMatch = text.match(
    /^Olá! Eu sou o [\s\S]*?considere apoiar o projeto\]\([^)]+\)\./m,
  );
  if (anchorMatch) {
    return captureUntilCoverageBoundary(text, anchorMatch.index ?? 0);
  }

  // #3691: fallback quando o editor remove a frase-CTA de apoio do bloco de
  // boas-vindas (ex: pra não competir com o box de apoio dedicado) — a
  // âncora do CTA deixa de ser obrigatória pra reconhecer o bloco, só o
  // início "Olá! Eu sou o" é exigido. Sem isso, extractCoverageLine
  // retornava null e a intro inteira sumia do HTML em silêncio (caso real:
  // edição 260720).
  const welcomeMatch = text.match(/^Olá! Eu sou o [^\n]*$/m);
  if (welcomeMatch) {
    return captureUntilCoverageBoundary(text, welcomeMatch.index ?? 0);
  }

  // Formatos legados (linha única): #592/#609 original + #3456.
  const m = text.match(/^Para esta edição,[^\n]+$/m);
  return m ? m[0].trim() : null;
}

/**
 * #3691: captura do início do bloco de boas-vindas até o próximo boundary
 * estrutural (`---` isolado em linha própria, ou o próximo `**DESTAQUE`), o
 * que vier primeiro. Sem boundary (MD malformado) captura até o fim do
 * texto — defensivo, não deveria ocorrer em MD bem formado. Compartilhado
 * entre o path ancorado no CTA de apoio e o fallback sem CTA.
 */
function captureUntilCoverageBoundary(text: string, startIdx: number): string {
  const rest = text.slice(startIdx);
  const sepMatch = rest.match(/^---[ \t]*\r?$/m);
  const destMatch = rest.match(/^\*\*DESTAQUE/m);
  let endIdx = rest.length;
  if (sepMatch?.index !== undefined) endIdx = Math.min(endIdx, sepMatch.index);
  if (destMatch?.index !== undefined) endIdx = Math.min(endIdx, destMatch.index);
  return rest.slice(0, endIdx).trim();
}

/**
 * #4358: fragmento de verbos reconhecidos na frase de contagem da intro
 * ("Selecionamos os N mais relevantes" / "selecionei os N mais relevantes" /
 * "foram selecionados os N mais relevantes" / variações de rephrase do
 * humanizador). Fonte ÚNICA entre `reconcileCoverageCount` (abaixo, usado no
 * render pra reconciliar o Z com a contagem real) e `extractIntroClaimedCount`
 * (`newsletter-count.ts`, usado por `sync-intro-count.ts` e pelo lint
 * `intro-count`) — antes cada arquivo mantinha seu próprio regex, e
 * divergiam: `newsletter-count.ts` só reconhecia verbos 1ª-pessoa-plural
 * (Selecionamos/Escolhemos/Reunimos/Destacamos/Separamos/Trouxemos), não
 * "selecionei" (1ª pessoa singular — a voz atual da newsletter). Resultado:
 * desde que a voz mudou, `extractIntroClaimedCount` retornava `null` pra
 * TODA edição atual, deixando o lint `intro-count` e o `sync-intro-count.ts`
 * inertes em silêncio (o e-mail final nunca saiu errado só porque o render
 * sempre recalcula via `reconcileCoverageCount`, que já reconhecia
 * "selecionei"). Superset das duas listas anteriores — nenhum verbo
 * reconhecido antes deixa de ser reconhecido agora.
 */
export const COVERAGE_COUNT_VERB_FRAGMENT =
  "selecionamos|selecionei|escolhemos|reunimos|destacamos|separamos|trouxemos|foi selecionado|foram selecionados";

/**
 * Pure (#1761, formato novo #3456, formato de boas-vindas #3461): reconcilia
 * a contagem final ("Selecionamos os Z mais relevantes" / "foram
 * selecionados os Z mais relevantes" / "selecionei os Z mais relevantes")
 * com o número REAL de itens renderizados (3 destaques + itens das seções
 * secundárias). O Z é setado por `sync-coverage-line.ts` num ponto do
 * pipeline e fica STALE quando o editor adiciona/remove itens no gate. Fazendo
 * isso no render, a fonte de verdade do Z passa a ser o que de fato vai pro HTML.
 *
 * Só substitui o trecho de contagem; preserva X (submissões) e Y (encontrados).
 * Detecta qual template está presente (verbo ativo "Selecionamos"/"selecionei"
 * vs passivo "foram selecionados") e preserva essa forma verbal na
 * substituição — concordância numérica: 1 item → singular ("o artigo mais
 * relevante"); N>1 → plural ("os N mais relevantes").
 */
export function reconcileCoverageCount(line: string, count: number): string {
  if (!line) return line;
  const countPhrase =
    count === 1 ? "o artigo mais relevante" : `os ${count} mais relevantes`;
  return line.replace(
    new RegExp(`(${COVERAGE_COUNT_VERB_FRAGMENT})\\s+(?:o artigo mais relevante|os \\d+ mais relevantes)`, "i"),
    (_match, verb: string) => {
      // Voz passiva (#3456) flexiona em número — "foi selecionado" (singular)
      // vira "foram selecionados" (plural) e vice-versa quando o count muda.
      // Voz ativa ("selecionamos"/"selecionei") não flexiona — mantém como capturado.
      const isPassive = /^fo(i|ram)\s+selecionad/i.test(verb);
      const verbOut = isPassive
        ? count === 1
          ? "foi selecionado"
          : "foram selecionados"
        : verb;
      return `${verbOut} ${countPhrase}`;
    },
  );
}

/**
 * Pure (#1648, marcador-agnóstico desde #3232): extrai um CTA de destaque (ex:
 * convite pro sorteio ao vivo) da região de intro — um parágrafo INTEIRAMENTE
 * embrulhado em negrito (`**...**`), posicionado antes do primeiro
 * `**DESTAQUE`. Retorna o texto interno (markdown de links preservado pra
 * processInlineLinks), ou `null` se ausente.
 *
 * #3232: mesma técnica de #3204 (`locateBoxInGap`) — detecção por POSIÇÃO
 * (região de intro, antes do 1º destaque) + ESTRUTURA (bloco bold-wrap), não
 * por um allowlist de marcadores emoji (🎉/📣). Antes, um callout de intro com
 * um marcador NOVO (ex: 🎥) não era reconhecido — `extractIntroCallout`
 * retornava `null`, `content.introCallout` ficava vazio, e o CTA inteiro
 * SUMIA do e-mail final sem erro nenhum (o mesmo padrão de silent-drop que
 * #3204 corrigiu pro box-entre-destaques). Ver
 * `test/intro-callout-marker-agnostic.test.ts` pela reprodução do bug e a
 * prova do fix.
 *
 * Diferente da coverage line: renderizado como callout com borda, não some no
 * meio do parágrafo cinza (feedback 260601 — sorteio não era encontrado no topo).
 */
// #3726: separador `---` isolado em linha própria — mesmo boundary usado por
// `GAP_SEPARATOR_RE` (ver embaixo). Delimita segmentos dentro da região de
// intro pra evitar que o regex greedy do callout cruze pra outro bloco
// bold-wrap distinto (ver `boldWrapSegments`).
const INTRO_SEGMENT_SEP_RE = /^---[ \t]*\r?$/gm;

/**
 * #3726: divide `introRegion` em segmentos delimitados por `---` isolado,
 * preservando o offset absoluto de cada segmento (pra permitir slicing
 * posterior em `extractCoverageLineTrailer`). O regex de bloco bold-wrap
 * roda DENTRO de cada segmento (nunca cruza um `---`) — mantém o
 * comportamento greedy original (#260701) para callouts multi-parágrafo com
 * sub-linhas `**bold**` internas (sem `---` entre elas), mas evita que 2
 * blocos bold-wrap SEPARADOS por `---` (ex: callout real + uma 2ª linha em
 * negrito isolada mais adiante) sejam fundidos num só, com o `---` entre eles
 * vazando como texto literal.
 */
function boldWrapSegments(introRegion: string): { text: string; offset: number }[] {
  const segments: { text: string; offset: number }[] = [];
  let cursor = 0;
  let sep: RegExpExecArray | null;
  INTRO_SEGMENT_SEP_RE.lastIndex = 0;
  while ((sep = INTRO_SEGMENT_SEP_RE.exec(introRegion))) {
    segments.push({ text: introRegion.slice(cursor, sep.index), offset: cursor });
    cursor = sep.index + sep[0].length;
  }
  segments.push({ text: introRegion.slice(cursor), offset: cursor });
  return segments;
}

const BOLD_WRAP_RE = /^\*\*\s*([\s\S]+)\*\*\s*$/m;

/**
 * #3741: encontra o bloco bold-wrap da região de intro, com posição absoluta
 * do fim do match (`matchEnd`, usado por `extractCoverageLineTrailer` pra
 * fatiar o trailer). Primeiro tenta por SEGMENTO (`boldWrapSegments`,
 * comportamento #3726: nunca funde 2 blocos bold-wrap DISTINTOS separados por
 * `---`). Só quando NENHUM segmento isoladamente bate no padrão — não quando
 * achou candidatos mas todos vazios — tenta o regex guloso na região INTEIRA
 * (sem segmentação) como fallback.
 *
 * Esse fallback existe pro caso de um callout LEGÍTIMO único cujo próprio
 * conteúdo tem um `---` isolado em linha própria (separador decorativo
 * interno do texto do callout, não boundary entre 2 blocos). A segmentação
 * do #3726 corta esse callout ao meio — abertura `**` sobra num segmento,
 * fechamento `**` sobra no segmento seguinte — e nenhum dos dois,
 * isoladamente, bate no regex. Sem o fallback, `extractIntroCallout` retorna
 * `null` e o callout inteiro some do HTML renderizado, sem erro (bug pior que
 * o que #3726 corrigiu, ver test/render-newsletter-html.test.ts).
 *
 * É seguro contra o regresso do #3726 porque o fallback só roda quando o loop
 * por segmento não achou NENHUM match — o cenário do #3726 (2 blocos bold-wrap
 * DISTINTOS, cada um com abertura+fechamento `**` completos no seu próprio
 * segmento) sempre encontra um match já no 1º segmento e retorna antes de
 * chegar aqui.
 */
function findIntroCalloutMatch(
  introRegion: string,
): { groupText: string; matchStart: number; matchEnd: number } | null {
  for (const seg of boldWrapSegments(introRegion)) {
    const m = seg.text.match(BOLD_WRAP_RE);
    if (m && m.index !== undefined) {
      return {
        groupText: m[1].trim(),
        matchStart: seg.offset + m.index,
        matchEnd: seg.offset + m.index + m[0].length,
      };
    }
  }
  const whole = introRegion.match(BOLD_WRAP_RE);
  if (whole && whole.index !== undefined) {
    return { groupText: whole[1].trim(), matchStart: whole.index, matchEnd: whole.index + whole[0].length };
  }
  return null;
}

export function extractIntroCallout(text: string): string | null {
  const introRegion = text.split(/^\*\*DESTAQUE/m)[0];
  return findIntroCalloutMatch(introRegion)?.groupText ?? null;
}

/**
 * #3705: captura o texto de coverage que fica DEPOIS do introCallout na região
 * de intro (entre o fechamento do bloco bold-wrap e o próximo boundary
 * estrutural — `---` isolado ou `**DESTAQUE`). Existe porque o editor pode
 * querer o callout NO MEIO do bloco de boas-vindas (ex: entre o parágrafo de
 * lançamento e o parágrafo final de cobertura), não só no fim — sem essa
 * captura separada, esse texto ficaria fora tanto de `extractCoverageLine`
 * (que para no primeiro boundary, ANTES do callout) quanto de
 * `extractIntroCallout` (que só pega o bloco bold-wrap), e sumiria em
 * silêncio do HTML (mesma classe de bug que #3691/#3232 corrigiram).
 * `renderHTML` renderiza esse texto logo após o callout, antes do 1º destaque.
 */
export function extractCoverageLineTrailer(text: string): string | null {
  const introRegion = text.split(/^\*\*DESTAQUE/m)[0];
  // #3726/#3741: mesma detecção de bloco bold-wrap de extractIntroCallout
  // (ver `findIntroCalloutMatch`) — precisa da posição ABSOLUTA (dentro de
  // `introRegion`, não do segmento) pra fatiar o texto que vem depois.
  const calloutMatch = findIntroCalloutMatch(introRegion);
  if (!calloutMatch) return null;
  const rest = introRegion.slice(calloutMatch.matchEnd);
  // O primeiro `---` logo após o callout é o boundary que FECHA o box (#3705)
  // — precisa ser descartado antes de procurar o boundary que fecha o trailer,
  // senão o match cai nele mesmo e o trailer sai vazio.
  const afterClosingSep = rest.replace(/^[ \t\r\n]*---[ \t]*\r?\n/, "");
  const sepMatch = afterClosingSep.match(/^---[ \t]*\r?$/m);
  const endIdx = sepMatch?.index !== undefined ? sepMatch.index : afterClosingSep.length;
  const trailer = afterClosingSep.slice(0, endIdx).trim();
  if (!trailer) return null;
  // #3740: quando o trailer inteiro é OUTRO bloco bold-wrap completo (2
  // blocos bold-wrap empilhados na intro, separados por `---`), remover os
  // marcadores `**` externos — mesmo tratamento que extractIntroCallout já
  // aplica ao 1º bloco via grupo de captura (linha acima). Sem isso, o 2º
  // bloco vazava com `**` literais no HTML final (extractIntroCallout, ao
  // contrário, nunca tinha esse bug — sempre usou o grupo de captura).
  //
  // #3744: o regex acima é guloso — `[\s\S]+` casa até o ÚLTIMO `**` do
  // trailer, não necessariamente o par que fecha o PRIMEIRO. Quando o trailer
  // tem 2 spans bold INDEPENDENTES (não um bloco só) — ex:
  // "**Atenção:** hoje tem edição especial. **Não perca!**" — o match
  // engloba os 2 spans, e remover só os marcadores mais EXTERNOS deixa o par
  // do MEIO sobrando: "Atenção:** hoje tem edição especial. **Não perca!".
  // O HTML final então interpreta ESSE par sobrando como o bold, invertendo
  // o negrito (meio fica em negrito, "Atenção:"/"Não perca!" não ficam) —
  // mis-render SILENCIOSO, pior que o vazamento literal que #3740 corrigiu
  // (aquele pelo menos era visivelmente quebrado).
  //
  // #3762: o guard do #3744 acima ("MEIO capturado não tem par completo")
  // ainda escapava em 3 formas — contagem ÍMPAR (marcador órfão, ex:
  // "**foo **bar**" — o MEIO só tem 1 ocorrência de `**`, `test()` falha, o
  // strip acontecia e o marcador órfão vazava literal); e um padrão de 2
  // marcadores adjacentes específico ("**foo**bar**", 3 marcadores totais)
  // que manglava o texto do mesmo jeito. Contar só o MEIO é insuficiente — a
  // ambiguidade real só se resolve olhando o trailer INTEIRO.
  //
  // Fix: mesma convenção de `isSingleBoldWrap`
  // (`lint-checks/callout-placement.ts` #3315) — `countDoubleAsterisk` no
  // trailer INTEIRO (antes de extrair o grupo) exigindo EXATAMENTE 2
  // ocorrências (abertura + fechamento, nada mais) confirma sem ambiguidade
  // que é um único bloco bold-wrap. Qualquer contagem diferente de 2 (ímpar =
  // marcador órfão; par >2 = múltiplos spans OU bloco único com ênfase
  // aninhada interna redundante — as duas formas são estruturalmente
  // indistinguíveis por contagem, mesma ambiguidade do caso #3744 acima) →
  // mais seguro NÃO remover os marcadores, preserva o texto bruto (`**`
  // literal visível, corrompido mas visível, em vez de corromper a
  // formatação em silêncio).
  const boldWrapMatch = trailer.match(/^\*\*\s*([\s\S]+)\*\*\s*$/);
  if (boldWrapMatch && countDoubleAsterisk(trailer) === 2) {
    return boldWrapMatch[1].trim();
  }
  return trailer;
}

/**
 * #2978: cada box de divulgação ocupa um SLOT fixo por POSIÇÃO — slot 1 =
 * lacuna D1/D2 (gapIndex 0), slot 2 = lacuna D2/D3 (gapIndex 1). O FORMATO do
 * conteúdo (bold-line 📚/📣/🎉 vs multi-parágrafo-com-CTA 🛒) é decidido pelo
 * próprio marcador — cada slot aceita QUALQUER um dos dois formatos.
 *
 * `interDestaqueGaps` calcula as lacunas ENTRE destaques consecutivos: cada
 * gap = região [marker[i], marker[i+1]) com `gapIndex = i` (o índice do
 * destaque que PRECEDE a lacuna). A região DEPOIS do último destaque (onde
 * vivem É IA? + seções) NÃO é uma lacuna — não é varrida.
 */
function interDestaqueGaps(
  text: string,
): { start: number; end: number; gapIndex: number }[] {
  const markers = [...text.matchAll(/^\*\*DESTAQUE/gm)].map((m) => m.index ?? -1)
    .filter((i) => i >= 0);
  const gaps: { start: number; end: number; gapIndex: number }[] = [];
  for (let i = 0; i < markers.length - 1; i++) {
    gaps.push({ start: markers[i], end: markers[i + 1], gapIndex: i });
  }
  return gaps;
}

// #3204: detecção marcador-agnóstica, por POSIÇÃO + ESTRUTURA — substitui o
// antigo allowlist de marcadores emoji (BOX_DIVULGACAO_BOLD_RE `**📚|📖|📣|🎉…**`
// + BOX_DIVULGACAO_CART_RE `🛒…` + BOX_DIVULGACAO_BOOK_RE `📖…`). Um marcador
// NOVO (ex: 🎥, 🎁) não exige mais nenhuma mudança de código: o parser não olha
// pro emoji, só pra posição do bloco na lacuna.
//
// Dentro de uma lacuna entre destaques (`interDestaqueGaps`), o conteúdo tem
// esta forma fixa:
//
//   [bloco 0: header **DESTAQUE N | CAT** + título + corpo + why]
//   ---                                                            (separador)
//   [bloco 1: candidato a box de divulgação — QUALQUER conteúdo aqui]
//   ---                                                            (opcional, antes do próximo **DESTAQUE)
//
// O bloco 0 SEMPRE é o próprio destaque (reconhecível pelo header
// `DESTAQUE N | ...`, o mesmo padrão que `parseDestaques` usa) — nunca é
// tratado como box. Qualquer bloco ADICIONAL (delimitado por `---`) na mesma
// lacuna, que não seja também um header de destaque nem um header de seção
// (defensivo — nunca deveria ocorrer, já que `interDestaqueGaps` já exclui a
// região pós-último-destaque onde vivem as seções), é o box — o 1º que
// aparece, caso haja mais de um (ver `findOrphanBoxWarnings` pro aviso).
const GAP_SEPARATOR_RE = /^---[ \t]*\r?$/m;
const DESTAQUE_HEADER_IN_BLOCK_RE = /^(?:\*\*)?DESTAQUE\s+[123]\s*\|/m;

interface GapBlock {
  text: string;
  rawStart: number;
  rawEnd: number;
}

/** Divide uma região (texto de uma lacuna) em blocos delimitados por `---`. */
function splitByGapSeparator(region: string): GapBlock[] {
  const seps: { start: number; end: number }[] = [];
  const re = new RegExp(GAP_SEPARATOR_RE.source, "gm");
  let m: RegExpExecArray | null;
  while ((m = re.exec(region)) !== null) {
    seps.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++; // guard contra loop infinito
  }
  const blocks: GapBlock[] = [];
  let cursor = 0;
  for (const sep of seps) {
    blocks.push({ text: region.slice(cursor, sep.start), rawStart: cursor, rawEnd: sep.start });
    cursor = sep.end;
  }
  blocks.push({ text: region.slice(cursor), rawStart: cursor, rawEnd: region.length });
  return blocks;
}

/**
 * #3204: infere o FORMATO do box pelo conteúdo, não pelo marcador. Um bloco
 * inteiramente embrulhado em `**...**` (do 1º ao último char não-whitespace)
 * é o formato bold-line curto — o `**` estrutural é removido (mesmo contrato
 * do antigo BOX_DIVULGACAO_BOLD_RE, que capturava só o grupo interno).
 * Qualquer outro formato (multi-parágrafo, ou 1 parágrafo sem bold-wrap
 * total) mantém o texto bruto — `renderBoxDivulgacao` decide o resto
 * (imagem/pill/etc.) pela estrutura do conteúdo.
 *
 * #3373: também reporta se o bloco ESTAVA bold-wrapped na fonte — sinal que
 * `renderBoxDivulgacao`/`renderIntroCallout` usam pra decidir o peso da fonte
 * do box de 1 parágrafo (editor escreve `**...**` pra negrito, texto plano
 * pra peso normal — editorial 260712).
 */
function formatBoxInner(trimmed: string): { inner: string; bold: boolean } {
  const boldWrap = /^\*\*\s*([\s\S]+?)\*\*$/.exec(trimmed);
  return boldWrap ? { inner: boldWrap[1].trim(), bold: true } : { inner: trimmed, bold: false };
}

interface ParaSpan {
  text: string;
  start: number;
  end: number;
}

// Blank-line separator entre parágrafos, tolerante a CRLF (`\r?` em cada
// quebra) — mesma convenção de GAP_SEPARATOR_RE, generalizada pra runs de
// 1+ linhas em branco.
const PARA_BLANK_RE = /\r?\n(?:[ \t]*\r?\n)+/g;

/** Divide `s` em parágrafos (runs de linhas não-vazias), com offsets (relativos a `s`) do conteúdo TRIMMED. */
function splitParagraphsWithOffsets(s: string): ParaSpan[] {
  const seps: { start: number; end: number }[] = [];
  const re = new RegExp(PARA_BLANK_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    seps.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++; // guard contra loop infinito
  }
  const segs: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const sep of seps) {
    segs.push({ start: cursor, end: sep.start });
    cursor = sep.end;
  }
  segs.push({ start: cursor, end: s.length });
  const paras: ParaSpan[] = [];
  for (const seg of segs) {
    const raw = s.slice(seg.start, seg.end);
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const leadingWs = raw.length - raw.trimStart().length;
    const trailingWs = raw.length - raw.trimEnd().length;
    paras.push({ text: trimmed, start: seg.start + leadingWs, end: seg.end - trailingWs });
  }
  return paras;
}

const FULL_BOLD_WRAP_RE = /^\*\*[\s\S]+\*\*$/;
const SIMPLE_MD_LINK_RE = /\[[^\]]+\]\([^)]+\)/;

/**
 * #3204/#1972 Opção A: fallback pro caso em que o box está GLUADO ao final do
 * bloco do próprio destaque, sem `---` isolando-o (caso real 260609 — o
 * writer/editor colou o callout antes do separador de fechamento). Sem
 * marcador pra ancorar, o único sinal estrutural disponível é: o ÚLTIMO
 * parágrafo do bloco, se INTEIRAMENTE embrulhado em `**...**` E contém um
 * link markdown (evita falso-positivo em ênfase retórica tipo
 * "**Isso muda tudo.**" no fim de um why-text, que não tem link), e NÃO é o
 * parágrafo de título (posição 1, logo após o header) — é tratado como box
 * colado. `stripBoxInGap` segue funcionando mesmo sem `---` pra colapsar (só
 * concatena `before + after`).
 */
function locateGluedBoxInBlock(block: GapBlock): ParaSpan | null {
  const paras = splitParagraphsWithOffsets(block.text);
  // paras[0] = header **DESTAQUE N | ...**; paras[1] = título. Precisa de
  // pelo menos header + título + 1 parágrafo extra pra ter candidato.
  if (paras.length < 3) return null;
  const last = paras[paras.length - 1];
  if (!FULL_BOLD_WRAP_RE.test(last.text)) return null;
  if (!SIMPLE_MD_LINK_RE.test(last.text)) return null;
  return last;
}

/**
 * Pure (#1972/#2978, marcador-agnóstico desde #3204): localiza o box de
 * divulgação numa lacuna ESPECÍFICA (por `gapIndex`) pelo bloco `---`-
 * delimitado que vem depois do próprio destaque — ou, na ausência de um bloco
 * isolado, pelo fallback de box GLUADO ao final do bloco do destaque
 * (`locateGluedBoxInBlock`). Retorna o conteúdo interno + os índices
 * absolutos do match, pra extract/strip compartilharem a mesma lógica.
 */
function locateBoxInGap(
  text: string,
  gapIndex: number,
): { inner: string; bold: boolean; matchStart: number; matchEnd: number } | null {
  const gap = interDestaqueGaps(text).find((g) => g.gapIndex === gapIndex);
  if (!gap) return null;
  const region = text.slice(gap.start, gap.end);
  const blocks = splitByGapSeparator(region);
  // blocks[0] = o próprio destaque. Candidatos a box são os blocos
  // SEGUINTES, não-vazios, que não sejam header de destaque nem de seção.
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const trimmed = block.text.trim();
    if (!trimmed) continue;
    // code-review #3204: os 2 regexes abaixo têm a flag `m` (linha-a-linha) —
    // testar contra o bloco INTEIRO (multi-parágrafo) casaria se QUALQUER
    // linha do MEIO do bloco parecer um header, rejeitando um box legítimo
    // cujo corpo mencione algo como "RADAR" numa linha isolada. O sinal real
    // é "o bloco INTEIRO é um header solto" — então testamos só a 1ª linha.
    const firstLine = trimmed.split(/\r?\n/, 1)[0];
    if (DESTAQUE_HEADER_IN_BLOCK_RE.test(firstLine)) continue;
    if (SECTION_HEADER_RE.test(firstLine)) continue;
    const leadingWs = block.text.length - block.text.trimStart().length;
    const trailingWs = block.text.length - block.text.trimEnd().length;
    const matchStart = gap.start + block.rawStart + leadingWs;
    const matchEnd = gap.start + block.rawEnd - trailingWs;
    const formatted = formatBoxInner(trimmed);
    return { inner: formatted.inner, bold: formatted.bold, matchStart, matchEnd };
  }
  // Nenhum bloco isolado — tenta o fallback de box colado ao destaque.
  const glued = locateGluedBoxInBlock(blocks[0]);
  if (glued) {
    const formatted = formatBoxInner(glued.text);
    return {
      inner: formatted.inner,
      bold: formatted.bold,
      matchStart: gap.start + blocks[0].rawStart + glued.start,
      matchEnd: gap.start + blocks[0].rawStart + glued.end,
    };
  }
  return null;
}

// #3476: marcos conhecidos que delimitam o FIM da região pós-destaques (slot
// 3) — ao contrário de `interDestaqueGaps` (lacuna BOUNDED entre 2 markers de
// destaque), a região após o ÚLTIMO destaque se estende até o fim do arquivo
// (USE MELHOR/É IA?/LANÇAMENTOS/.../PARA ENCERRAR). Sem um limite explícito,
// o scan de candidato a box passaria por cima de seções inteiras. Qualquer um
// desses marcos, na 1ª linha de um bloco `---`-isolado, encerra a busca —
// diferente de `locateBoxInGap` (que só pula esses blocos e CONTINUA
// procurando dentro da lacuna fixa), aqui é um `break` definitivo.
const EIA_HEADER_RE = /^(?:\*\*)?É IA\?(?:\*\*)?\s*$/;
const ERRO_INTENCIONAL_HEADER_RE = /^(?:\*\*)?ERRO INTENCIONAL(?:\*\*)?\s*$/;

function isPostDestaqueLandmark(firstLine: string): boolean {
  if (DESTAQUE_HEADER_IN_BLOCK_RE.test(firstLine)) return true;
  if (SECTION_HEADER_RE.test(firstLine)) return true;
  if (EIA_HEADER_RE.test(firstLine)) return true;
  if (ERRO_INTENCIONAL_HEADER_RE.test(firstLine)) return true;
  for (const re of SECTION_TERMINATOR_MARKERS) {
    if (re.test(firstLine)) return true;
  }
  return false;
}

/**
 * #3825: extrai o bloco `**É IA?**` de `02-reviewed.md` — mirror/preview pro
 * editor, NUNCA a fonte real consumida pelo render (`01-eia.md`, sempre lido
 * direto em `extractContent`). Bounded pelos mesmos `---` isolados que
 * delimitam qualquer seção (mesma técnica de split-e-filtra de
 * `parseSections`). Retorna `null` quando o bloco não existe (edição legada
 * sem stitch, ou stitch ainda não rodou).
 */
export function extractEiaMirrorBlock(text: string): string | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const blocks = normalized.split(/^---$/m).map((s) => s.trim()).filter(Boolean);
  for (const block of blocks) {
    const firstLine = block.split("\n")[0]?.trim() ?? "";
    if (EIA_HEADER_RE.test(firstLine)) return block;
  }
  return null;
}

/**
 * #3825: parseia o bloco mirror extraído por `extractEiaMirrorBlock` reusando
 * `parseEIA` — o MESMO parser usado para `01-eia.md` — de propósito: a
 * comparação de divergência (`checkEiaCreditSynced`, invariant-checks/
 * stage-4.ts) precisa aplicar EXATAMENTE a mesma lógica de extração aos dois
 * lados, senão uma diferença de parsing (não de conteúdo) viraria
 * falso-positivo (ou pior, falso-negativo mascarando divergência real).
 *
 * Antes de chamar `parseEIA`, remove a linha `> Gabarito: ...` — formato
 * inserido pelo passo 2b do `writer.md` (single-writer, legado). O fluxo
 * atual (`writer-destaque` × 3 + `stitch-newsletter.ts::readEiaBlock`) copia
 * `01-eia.md` verbatim e nunca inclui essa linha, mas `parseEIA` não sabe
 * filtrá-la (ela não existe em `01-eia.md`) — sem este strip, edições no
 * formato legado vazariam a linha pro campo `credit` e produziriam
 * falso-positivo de divergência mesmo quando o crédito real bate.
 */
export function parseEiaMirrorBlock(block: string, editionDir: string): EIA {
  const withoutGabarito = block
    .split("\n")
    .filter((l) => !/^>\s*Gabarito\s*:/i.test(l.trim()))
    .join("\n");
  return parseEIA(withoutGabarito, editionDir);
}

/**
 * #4991: reimplementação de um fix perdido (commit `3bd161f9`, branch
 * `fix/4956-eia-anchor-section-reverte-3476` — validado ao vivo na edição
 * 260811, mas o worktree foi removido antes do push). Deriva onde É IA?
 * deve renderizar a partir de onde o mirror `**É IA?**` aparece de fato em
 * `02-reviewed.md`, em vez do hardcode fixo "sempre após USE MELHOR" do
 * #3476 — o editor pediu ao vivo (260811) mover É IA? para depois de VÍDEO.
 *
 * Retorno:
 *   - `null`  → mirror ausente (comportamento antigo, maioria das edições
 *     históricas). O chamador (`renderHTML`) deve cair no fallback #6323
 *     (após LANÇAMENTOS, ou após USE MELHOR se não houver LANÇAMENTOS, ou
 *     antes das seções secundárias se não houver nenhuma das duas) —
 *     regressão zero pra qualquer edição que nunca reordenou nada.
 *   - `-1`    → mirror presente, mas nenhuma seção secundária vem antes
 *     dele no md (mesma posição relativa do fallback "sem LANÇAMENTOS/USE
 *     MELHOR", #1085: É IA? nunca desaparece, renderiza antes das seções).
 *   - `i` (≥0) → mirror presente e deve renderizar logo APÓS
 *     `sections[i]` (índice no array retornado por `parseSections`, MESMO
 *     critério de filtragem — nome bate `SECTION_HEADER_RE` E tem ≥1 item).
 *
 * Reusa o MESMO split por `---` que `parseSections`/`extractEiaMirrorBlock`
 * usam, pra garantir que a posição do mirror seja calculada sobre os
 * MESMOS blocos que produziram `sections` (nenhum desvio de parsing entre
 * os dois lados).
 */
export function findEiaAnchorSection(text: string): number | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const blocks = normalized.split(/^---$/m).map((s) => s.trim()).filter(Boolean);

  let eiaBlockIdx = -1;
  for (let i = 0; i < blocks.length; i++) {
    const firstLine = blocks[i].split("\n")[0]?.trim() ?? "";
    if (EIA_HEADER_RE.test(firstLine)) {
      eiaBlockIdx = i;
      break;
    }
  }
  if (eiaBlockIdx === -1) return null; // sem mirror — fallback pro comportamento antigo

  // Conta quantas seções REAIS (mesmo critério de `parseSections`: header
  // bate `SECTION_HEADER_RE` e o body tem ≥1 item) aparecem ANTES do bloco
  // do mirror, na ordem do texto. Esse total, menos 1, é o índice em
  // `content.sections` da seção que precede o mirror — exatamente o mesmo
  // formato que `useMelhorIdx` já usa em `newsletter-render-html.ts`
  // (-1 = nenhuma seção antes).
  let sectionsBeforeMirror = 0;
  for (let i = 0; i < eiaBlockIdx; i++) {
    const block = blocks[i];
    const sectionMatch = block.match(SECTION_HEADER_RE);
    if (!sectionMatch) continue;
    const afterHeader = truncateAtSectionTerminator(
      block.replace(SECTION_HEADER_RE, "").trim(),
    );
    const items = parseListItems(afterHeader);
    if (items.length > 0) sectionsBeforeMirror++;
  }
  return sectionsBeforeMirror - 1;
}

/**
 * #3476: localiza o box de divulgação do slot 3 — SEMPRE posicionado após o
 * ÚLTIMO destaque (D3 em edições de 3 destaques, D2 em edições de 2), antes
 * de USE MELHOR/É IA?/qualquer outra seção. Diferente de `locateBoxInGap`
 * (lacuna fixa ENTRE 2 markers de destaque), esta região não é bounded pelo
 * próximo destaque — é bounded pelo próximo MARCO CONHECIDO
 * (`isPostDestaqueLandmark`). Mesma técnica de posição+estrutura do #3204:
 * aceita QUALQUER bloco `---`-isolado antes do 1º marco, ou (fallback) um
 * box GLUADO ao final do bloco do último destaque (sem `---` isolando).
 */
function locateBoxAfterLastDestaque(
  text: string,
): { inner: string; bold: boolean; matchStart: number; matchEnd: number } | null {
  const markers = [...text.matchAll(/^\*\*DESTAQUE/gm)].map((m) => m.index ?? -1)
    .filter((i) => i >= 0);
  if (markers.length === 0) return null;
  const lastMarkerStart = markers[markers.length - 1];
  const region = text.slice(lastMarkerStart);
  const blocks = splitByGapSeparator(region);
  // blocks[0] = o próprio último destaque. Candidato a box é o 1º bloco
  // seguinte não-vazio, ATÉ encontrar um marco conhecido (fim da região).
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const trimmed = block.text.trim();
    if (!trimmed) continue;
    const firstLine = trimmed.split(/\r?\n/, 1)[0];
    if (isPostDestaqueLandmark(firstLine)) break; // fim da região — sem box isolado
    const leadingWs = block.text.length - block.text.trimStart().length;
    const trailingWs = block.text.length - block.text.trimEnd().length;
    const matchStart = lastMarkerStart + block.rawStart + leadingWs;
    const matchEnd = lastMarkerStart + block.rawEnd - trailingWs;
    const formatted = formatBoxInner(trimmed);
    return { inner: formatted.inner, bold: formatted.bold, matchStart, matchEnd };
  }
  // Nenhum bloco isolado — tenta o fallback de box colado ao final do último destaque.
  const glued = locateGluedBoxInBlock(blocks[0]);
  if (glued) {
    const formatted = formatBoxInner(glued.text);
    return {
      inner: formatted.inner,
      bold: formatted.bold,
      matchStart: lastMarkerStart + blocks[0].rawStart + glued.start,
      matchEnd: lastMarkerStart + blocks[0].rawStart + glued.end,
    };
  }
  return null;
}

export interface OrphanBoxWarning {
  gapIndex: number;
  reason: string;
}

/**
 * #3204: sanity-check de defesa-em-profundidade pós marcador-agnóstico.
 * `locateBoxInGap` já trata QUALQUER bloco extra (delimitado por `---`) numa
 * lacuna como o box — nada deveria ficar "não reconhecido" nesse caminho. O
 * resíduo real: uma lacuna com MAIS de 1 bloco extra é ambígua (2+
 * candidatos pro mesmo slot) — `locateBoxInGap` usa "o 1º vence" e
 * silenciosamente descartaria os demais sem este aviso. Usado pelo lint
 * `orphan-box-in-gap` (gate-blocking no Stage 4, §4c.2).
 */
export function findOrphanBoxWarnings(text: string): OrphanBoxWarning[] {
  const warnings: OrphanBoxWarning[] = [];
  // #4290: região de introdução (slot 0) — entre o bloco de cobertura e
  // `**DESTAQUE 1`. Mesmo raciocínio dos loops abaixo (2+ blocos `---`-
  // isolados candidatos é ambíguo), mas com 2 diferenças que espelham
  // `locateBoxAtIntro`: (a) o candidato vencedor é o ÚLTIMO bloco da região,
  // não o 1º (mesma prioridade do stitch); (b) o bloco já reivindicado por
  // `findIntroCalloutMatch` (introCallout/agradecimento a apoiadores) NUNCA
  // conta como candidato a box — contá-lo geraria falso-positivo toda vez que
  // um callout legítimo dividir a região em blocos junto com um box0 real
  // (ver desambiguação documentada na docstring de `locateBoxAtIntro`).
  const firstMarkerMatch = /^\*\*DESTAQUE/m.exec(text);
  if (firstMarkerMatch) {
    const introRegion = text.slice(0, firstMarkerMatch.index);
    const introMatch = findIntroCalloutMatch(introRegion);
    const extraIntro: string[] = [];
    for (const block of splitByGapSeparator(introRegion).slice(1)) {
      if (
        introMatch &&
        introMatch.matchStart >= block.rawStart &&
        introMatch.matchStart < block.rawEnd
      ) {
        continue; // bloco já reivindicado pelo introCallout/agradecimento
      }
      const trimmed = block.text.trim();
      if (!trimmed) continue;
      const firstLine = trimmed.split(/\r?\n/, 1)[0];
      if (DESTAQUE_HEADER_IN_BLOCK_RE.test(firstLine)) continue; // defensivo
      if (SECTION_HEADER_RE.test(firstLine)) continue; // defensivo
      extraIntro.push(trimmed);
    }
    if (extraIntro.length > 1) {
      warnings.push({
        gapIndex: -1,
        reason:
          `${extraIntro.length} blocos extras na região de introdução (slot 0, entre a cobertura ` +
          `e **DESTAQUE 1, excluindo o bloco já reivindicado pelo callout/agradecimento) — apenas ` +
          `o ÚLTIMO vira box de divulgação (mesma posição usada pelo stitch); os demais seriam ` +
          `descartados silenciosamente. Isole 1 único bloco de box nessa região, ou mova o ` +
          `excedente pra outro slot.`,
      });
    }
  }
  for (const gap of interDestaqueGaps(text)) {
    const region = text.slice(gap.start, gap.end);
    const extra = splitByGapSeparator(region)
      .slice(1)
      .filter((b) => b.text.trim().length > 0);
    if (extra.length > 1) {
      warnings.push({
        gapIndex: gap.gapIndex,
        reason:
          `${extra.length} blocos extras na lacuna D${gap.gapIndex + 1}/D${gap.gapIndex + 2} — ` +
          `apenas o 1º vira box de divulgação; os demais seriam descartados silenciosamente. ` +
          `Isole 1 único bloco de box entre os \`---\`, ou mova o excedente pra outra lacuna.`,
      });
    }
  }
  // #3476: região pós-destaques (slot 3) — entre o ÚLTIMO destaque e o
  // próximo marco conhecido (USE MELHOR/É IA?/outra seção). Mesmo raciocínio
  // do loop acima, mas contando só os blocos ANTES do 1º marco (a região não
  // é bounded pelo próximo destaque — segue até o fim do arquivo).
  const markers = [...text.matchAll(/^\*\*DESTAQUE/gm)].map((m) => m.index ?? -1)
    .filter((i) => i >= 0);
  if (markers.length > 0) {
    const lastMarkerStart = markers[markers.length - 1];
    const region = text.slice(lastMarkerStart);
    const extra: string[] = [];
    for (const block of splitByGapSeparator(region).slice(1)) {
      const trimmed = block.text.trim();
      if (!trimmed) continue;
      const firstLine = trimmed.split(/\r?\n/, 1)[0];
      if (isPostDestaqueLandmark(firstLine)) break;
      extra.push(trimmed);
    }
    if (extra.length > 1) {
      warnings.push({
        gapIndex: 2,
        reason:
          `${extra.length} blocos extras na região pós-destaques (slot 3, entre o último ` +
          `destaque e USE MELHOR/É IA?) — apenas o 1º vira box de divulgação; os demais ` +
          `seriam descartados silenciosamente. Isole 1 único bloco de box nessa região, ` +
          `ou mova o excedente pra outro slot.`,
      });
    }
  }
  return warnings;
}

/**
 * Box de divulgação posicionado ENTRE o 1º e o 2º destaque (slot 1, gap
 * D1/D2). Aceita bold-line (📚/📣/🎉) OU carrinho (🛒). Não casa títulos de
 * destaque (começam com `[`) nem headers de seção.
 */
export function extractBoxDivulgacao1(text: string): string | null {
  return locateBoxInGap(text, 0)?.inner ?? null;
}

/** Box de divulgação posicionado ENTRE o 2º e o 3º destaque (slot 2, gap D2/D3). */
export function extractBoxDivulgacao2(text: string): string | null {
  return locateBoxInGap(text, 1)?.inner ?? null;
}

/**
 * #3373: o box de 1 parágrafo (sem imagem, sem CTA pill) sai em negrito
 * quando a fonte tem `**...**` embrulhando o bloco inteiro, peso normal
 * quando não tem (editorial 260712 — editor controla o peso pelo markdown).
 * Default `true` (bold) quando o box não existe é inofensivo — só é
 * consultado nos call-sites que já checaram que o box existe.
 */
export function isBoxDivulgacao1Bold(text: string): boolean {
  return locateBoxInGap(text, 0)?.bold ?? true;
}

/** Mesma lógica de `isBoxDivulgacao1Bold`, pro slot 2 (gap D2/D3). */
export function isBoxDivulgacao2Bold(text: string): boolean {
  return locateBoxInGap(text, 1)?.bold ?? true;
}

/**
 * #4338: marcador sentinel escrito por `stitchNewsletter` IMEDIATAMENTE antes
 * do conteúdo do box0 real injetado na região de intro. `locateBoxAtIntro`
 * usa esse marcador como ÚNICO sinal de "isto é um box0 de verdade" — nunca
 * infere por posição (ver docstring de `locateBoxAtIntro` pela causa raiz do
 * bug que isso substitui).
 */
export const BOX0_SENTINEL = "<!-- box0 -->";

/**
 * #4274/#4338: localiza o box de divulgação do slot 0 (introdução) — região
 * entre a linha/bloco de cobertura e o marcador `**DESTAQUE 1`.
 *
 * #4338: detecção por MARCADOR EXPLÍCITO (`BOX0_SENTINEL`), não mais por
 * posição. A versão anterior tratava o ÚLTIMO bloco `---`-isolado da região
 * (excluindo o já reivindicado por `findIntroCalloutMatch`) como candidato a
 * box0 — mas isso é estruturalmente ambíguo: quando a região tem um parágrafo
 * de intro PURO (ex: `insert-titulo-subtitulo.ts` inserindo um `---` entre o
 * bloco TÍTULO/SUBTÍTULO e o parágrafo de boas-vindas) e NENHUM box0 real foi
 * injetado, o loop não tem como distinguir "prosa de intro que sobrou
 * separada por `---`" de "conteúdo real de box0" — e acabava tratando a
 * prosa como se fosse o box, duplicando o parágrafo de introdução no HTML
 * final (reincidente nas edições 260730/260731, mitigado só por workaround
 * manual — remover o `---`).
 *
 * `stitchNewsletter` agora escreve `BOX0_SENTINEL` imediatamente antes do
 * conteúdo, só quando de fato injeta um box0 real (ver `slot0Box` em
 * `stitch-newsletter.ts`). Sem o marcador na região, não há box0 — retorna
 * `null` incondicionalmente, eliminando a ambiguidade de uma vez (em vez de
 * arriscar inferir errado). Efeito colateral aceito: um `02-reviewed.md`
 * arquivado de uma edição anterior a este fix, com box0 já embutido sem o
 * marcador, deixa de ser reconhecido em re-render — não há re-render
 * automático de edições já enviadas, então o impacto é nulo em produção.
 *
 * Não precisa de "strip" antes do parse de destaques (diferente dos slots
 * 1/2/3): `parseDestaques`/`parseSections` já ignoram qualquer bloco
 * `---`-isolado que não bata no header de destaque/seção — o bloco do slot 0
 * nunca é absorvido por engano.
 */
function locateBoxAtIntro(
  text: string,
): { inner: string; bold: boolean; matchStart: number; matchEnd: number } | null {
  const firstMarkerMatch = /^\*\*DESTAQUE/m.exec(text);
  if (!firstMarkerMatch) return null;
  const region = text.slice(0, firstMarkerMatch.index);
  const sentinelIdx = region.indexOf(BOX0_SENTINEL);
  if (sentinelIdx === -1) return null; // #4338: sem marcador, sem box0 — nunca infere por posição.
  const afterSentinel = region.slice(sentinelIdx + BOX0_SENTINEL.length);
  // #4338: GAP_SEPARATOR_RE não tem flag `g` — cada `.exec()` busca do início
  // da string passada, sem estado de `lastIndex` pra vazar entre chamadas.
  const boundaryMatch = GAP_SEPARATOR_RE.exec(afterSentinel);
  const rawContent = boundaryMatch ? afterSentinel.slice(0, boundaryMatch.index) : afterSentinel;
  const trimmed = rawContent.trim();
  if (!trimmed) return null;
  const leadingWs = rawContent.length - rawContent.trimStart().length;
  const trailingWs = rawContent.length - rawContent.trimEnd().length;
  const matchStart = sentinelIdx + BOX0_SENTINEL.length + leadingWs;
  const matchEnd = sentinelIdx + BOX0_SENTINEL.length + rawContent.length - trailingWs;
  const formatted = formatBoxInner(trimmed);
  return { inner: formatted.inner, bold: formatted.bold, matchStart, matchEnd };
}

/**
 * Box de divulgação posicionado ENTRE a linha/bloco de cobertura e
 * `**DESTAQUE 1** (slot 0, introdução, #4274). Ver `locateBoxAtIntro` pela
 * lógica de desambiguação vs. `introCallout`/agradecimento.
 */
export function extractBoxDivulgacao0(text: string): string | null {
  return locateBoxAtIntro(text)?.inner ?? null;
}

/** Mesma lógica de `isBoxDivulgacao1Bold`, pro slot 0 (introdução). */
export function isBoxDivulgacao0Bold(text: string): boolean {
  return locateBoxAtIntro(text)?.bold ?? true;
}

/**
 * #3476: box de divulgação posicionado SEMPRE após o ÚLTIMO destaque (D3 em
 * edições de 3 destaques, D2 em edições de 2), antes de USE MELHOR/É IA?.
 * Diferente dos slots 1/2 (lacuna ENTRE 2 destaques), este é a região
 * pós-destaques — ver `locateBoxAfterLastDestaque`.
 */
export function extractBoxDivulgacao3(text: string): string | null {
  return locateBoxAfterLastDestaque(text)?.inner ?? null;
}

/** Mesma lógica de `isBoxDivulgacao1Bold`, pro slot 3 (região pós-destaques). */
export function isBoxDivulgacao3Bold(text: string): boolean {
  return locateBoxAfterLastDestaque(text)?.bold ?? true;
}

/**
 * Pure (#1972/#2978): remove o bloco do box de divulgação de uma lacuna
 * específica ANTES do parse dos destaques. Sem isso, um callout colado ANTES
 * do `---` de fechamento do destaque anterior (em vez de isolado entre dois
 * `---`) é absorvido pelo corpo/why desse destaque pelo `parseDestaques` (que
 * fatia em `^---$`) E renderizado como box de divulgação → duplicado e
 * quebrado (260609). De-dup determinístico, robusto à posição do `---`.
 * Idempotente quando não há box na lacuna. Colapsa `---` órfãos e linhas em
 * branco triplas deixadas pela remoção (seam-aware — ancorado em `$`/`^`,
 * nunca global, pra não fundir separadores `---` não-relacionados).
 */
function stripBoxInGap(text: string, gapIndex: number): string {
  const loc = locateBoxInGap(text, gapIndex);
  if (!loc) return text;
  const before = text.slice(0, loc.matchStart);
  const after = text.slice(loc.matchEnd);
  const openSep = /\n---[ \t]*\r?\n\s*$/;
  const closeSep = /^\s*\r?\n---[ \t]*\r?\n/;
  const joined =
    openSep.test(before) && closeSep.test(after)
      ? before + after.replace(closeSep, "\n")
      : before + after;
  // `(?:\r?\n)` (não `\n`) pra cobrir CRLF: sob `\r\n`, o `\s*$` do
  // BOX_DIVULGACAO_BOLD_RE consome o `\r` mas para antes do `\n`, deixando o
  // seam `\r\n\r\n\n\r\n` — newlines intercalados com `\r` que `/\n{3,}/` não casaria.
  return joined.replace(/(?:\r?\n){3,}/g, "\n\n");
}

/** Remove o box do slot 1 (gap D1/D2) do texto bruto ANTES do parse dos destaques. */
export function stripBoxDivulgacao1(text: string): string {
  return stripBoxInGap(text, 0);
}

/** Remove o box do slot 2 (gap D2/D3) do texto bruto ANTES do parse dos destaques. */
export function stripBoxDivulgacao2(text: string): string {
  return stripBoxInGap(text, 1);
}

/**
 * #3476: remove o bloco do box de divulgação do slot 3 (região pós-último-
 * destaque) do texto bruto ANTES do parse dos destaques. Mesmo motivo de
 * `stripBoxInGap` — sem isso, um box colado ao final do último destaque
 * (sem `---` isolando) seria absorvido pelo corpo/why desse destaque.
 * Idempotente quando não há box na região.
 */
export function stripBoxDivulgacao3(text: string): string {
  const loc = locateBoxAfterLastDestaque(text);
  if (!loc) return text;
  const before = text.slice(0, loc.matchStart);
  const after = text.slice(loc.matchEnd);
  const openSep = /\n---[ \t]*\r?\n\s*$/;
  const closeSep = /^\s*\r?\n---[ \t]*\r?\n/;
  const joined =
    openSep.test(before) && closeSep.test(after)
      ? before + after.replace(closeSep, "\n")
      : before + after;
  return joined.replace(/(?:\r?\n){3,}/g, "\n\n");
}

/**
 * #2136/#2978/#3204: discrimina se um box de divulgação é o de livros (link
 * para livros.diar.ia.br) ou outro box (ex: divulgação CLARICE). A
 * imagem livros_promo só deve ser associada ao box de livros. Marcador-
 * agnóstico desde #3204 — o antigo atalho por emoji (`/^\s*📚/`) foi removido;
 * o link de destino já era (e continua sendo) sinal suficiente e estrutural.
 *
 * #3698: casa TANTO o domínio de marca (`livros.diar.ia.br`, canônico desde
 * esta issue) QUANTO o legado `livros.diaria.workers.dev` (edições em voo no
 * Drive/gate podem ter sido escritas antes do cutover; sem o fallback, o box
 * dessas edições deixaria de ser reconhecido como "box de livros" e perderia
 * a imagem livros_promo silenciosamente).
 */
export function isBoxDivulgacaoLivros(text: string | null | undefined): boolean {
  if (!text) return false;
  // #260622: box combinado Livros+Cursos NÃO é o promo de livros — é um box de
  // seções com múltiplos CTAs (renderizado como texto, sem o screenshot da
  // página de livros). Se o texto também linka o domínio de cursos (marca ou
  // legado workers.dev), tratar como box de seções (false), não promo de livros.
  if (/cursos\.(?:diar\.ia\.br|diaria\.workers\.dev)/i.test(text)) return false;
  return /livros\.(?:diar\.ia\.br|diaria\.workers\.dev)/i.test(text);
}

/**
 * URL pública da imagem do box de divulgação (entry `livros_promo` de
 * `06-public-images.json`), se presente. Lida no momento do render (o cache já
 * existe — upload-images-public roda antes). Graceful: ausente → null.
 *
 * #2136/#2978/#2978-slot2-parity: só retorna a imagem se o box for o de
 * livros. Box 📣 CLARICE (e outros sem link livros.diar.ia.br) →
 * null (sem hero). Compartilhado pelos 2 slots — o box de livros pode cair
 * tanto no slot 1 (gap D1/D2) quanto no slot 2 (gap D2/D3), a depender da
 * ordem de conteúdo da edição (ver `test/flexible-callout-position.test.ts`).
 */
/**
 * Imagem ARBITRÁRIA atribuída a um slot de box (entry `box_slot{N}_image` de
 * `06-public-images.json`, produzida por `upload-images-public.ts` a partir de
 * `04-box-slot{N}.jpg`).
 *
 * Diferente de `livros_promo` — que só é associada ao box de LIVROS, por link de
 * destino (#2136) — esta associação é POSICIONAL: vale pro snippet que estiver
 * naquele slot, seja capa de livro, header de artigo ou outro. Tem precedência
 * sobre `livros_promo`: se o editor atribuiu uma imagem explícita ao slot, é
 * ela que vale.
 *
 * Graceful: ausente/cache ilegível → null (box só-texto, comportamento atual).
 */
/**
 * Dimensões de um JPEG lendo só os marcadores SOF (mini-parser, sem dependência
 * externa — `sharp` existe no projeto mas é pesado demais pra um módulo de parse
 * que roda em todo render). Retorna `null` se o arquivo não for JPEG legível.
 */
function readJpegDimensions(path: string): { width: number; height: number } | null {
  try {
    const buf = readFileSync(path);
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null; // não é JPEG
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      // SOF0..SOF15, exceto DHT (c4), JPGA (c8) e DAC (cc) — os únicos que
      // carregam altura/largura no header.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      off += 2 + buf.readUInt16BE(off + 2);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Imagem de slot em RETRATO (altura > largura)? Capa de livro renderizada na
 * largura total do box (536px) viraria um bloco de ~800px de altura no e-mail;
 * o renderer usa este sinal pra exibi-la reduzida e centralizada. Imagem
 * horizontal (screenshot, header de artigo) mantém a largura total de sempre.
 */
export function isBoxSlotImagePortrait(editionDir: string, slot: 0 | 1 | 2 | 3): boolean {
  const dim = readJpegDimensions(resolve(editionDir, `04-box-slot${slot}.jpg`));
  return dim !== null && dim.height > dim.width;
}

function readBoxSlotImage(editionDir: string, slot: 0 | 1 | 2 | 3): string | null {
  const p = resolve(editionDir, "06-public-images.json");
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    const e = (j.images ?? j)?.[`box_slot${slot}_image`];
    // `||` (não `??`): string vazia deve cair pro próximo campo / null — mesma
    // razão de readBoxDivulgacaoImage (evita `<img src="">`).
    return e?.cloudflare_url || e?.url || null;
  } catch {
    return null;
  }
}

function readBoxDivulgacaoImage(
  editionDir: string,
  boxText?: string | null,
): string | null {
  // #2136: imagem livros_promo só vai pro box de livros, nunca pro box CLARICE.
  // #finding-6: undefined (sem texto) é tratado como "desconhecido" → null por segurança.
  // Apenas `null` explícito bypassa (back-compat para callers antigos sem texto disponível).
  // Contrato: passe o texto do callout sempre que disponível; omitir é seguro mas
  // conservador (nunca anexa imagem livros_promo sem confirmação explícita de ser box livros).
  if (boxText == null || !isBoxDivulgacaoLivros(boxText)) {
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

/** Slot 1 (gap D1/D2). Ver `readBoxDivulgacaoImage`. */
export function readBoxDivulgacao1Image(
  editionDir: string,
  boxText?: string | null,
): string | null {
  return readBoxSlotImage(editionDir, 1) ?? readBoxDivulgacaoImage(editionDir, boxText);
}

/**
 * Slot 2 (gap D2/D3). #2978-slot2-parity: sem paridade até esta função existir
 * — o box de livros (📚) só ganhava imagem/CTA-pill quando caía no slot 1; no
 * slot 2 degradava silenciosamente pro box só-texto (renderIntroCallout sem
 * forceCtaPill). Mesmo contrato do slot 1: imagem só quando o box é de livros.
 */
export function readBoxDivulgacao2Image(
  editionDir: string,
  boxText?: string | null,
): string | null {
  return readBoxSlotImage(editionDir, 2) ?? readBoxDivulgacaoImage(editionDir, boxText);
}

/**
 * Slot 3 (região pós-destaques, #3476). Mesmo contrato dos slots 1/2 — na
 * prática sempre `null`, já que o box do slot 3 (Indicação de Ferramenta)
 * nunca é o de livros (`isBoxDivulgacaoLivros`); mantido pra paridade.
 */
export function readBoxDivulgacao3Image(
  editionDir: string,
  boxText?: string | null,
): string | null {
  return readBoxSlotImage(editionDir, 3) ?? readBoxDivulgacaoImage(editionDir, boxText);
}

/**
 * Slot 0 (introdução, #4274). Mesmo contrato dos demais slots — imagem só
 * quando o box é o de livros (`livros_promo`) OU quando o editor atribuiu
 * explicitamente uma imagem ao slot (`box_slot0_image`).
 */
export function readBoxDivulgacao0Image(
  editionDir: string,
  boxText?: string | null,
): string | null {
  return readBoxSlotImage(editionDir, 0) ?? readBoxDivulgacaoImage(editionDir, boxText);
}

/** Raiz do repo, resolvida a partir do próprio módulo (`scripts/lib/` ->
 * `..` -> `scripts/` -> `..` -> raiz) — usada por
 * `readBoxDivulgacaoCategoriaForSlot` como default de `rootDir` no call site
 * real (`extractContent`, que só recebe `editionDir`, não a raiz do repo). */
const REPO_ROOT_FROM_MODULE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * #3981: `categoria:` configurada pro box de divulgação de um SLOT (1/2/3) —
 * rótulo exibido como kicker acima do box na newsletter (ver
 * `renderDivulgacaoSeparator`/`renderKicker` em newsletter-render-html.ts).
 *
 * Lida diretamente do DISCO no momento do render, NÃO via `02-reviewed.md`:
 * `platform.config.json` → `boxes_divulgacao.slot{N}` dá o nome do snippet
 * atualmente atribuído a esse slot; `categoria:` vem do header de comentário
 * HTML desse arquivo — mesmo campo editado no Studio (seção "Caixas",
 * `scripts/studio-ui/studio-boxes.ts` → `parseBoxCategoria`, mesma convenção
 * de `nome:` do #3933).
 *
 * Deliberadamente NÃO passa pelo texto de `02-reviewed.md`/pipeline de
 * escrita — a categoria é uma propriedade do BOX (slot -> arquivo), não do
 * conteúdo que o writer/humanizador/Clarice tocam; ler direto do disco evita
 * qualquer risco de a categoria ser alterada por um desses passos de LLM, e
 * evita ensinar `extractBoxDivulgacao{1,2,3}`/`stripBoxDivulgacao{1,2,3}` a
 * preservar um marcador de metadado dentro do texto solto do box (que hoje é
 * aceito em QUALQUER formato — bold-line, carrinho, ou genérico).
 *
 * `rootDir` (default: raiz do repo real) existe só pra permitir fixture de
 * teste isolada — o call site real (`extractContent`) nunca passa override.
 *
 * `null` (renderiza exatamente como hoje, sem rótulo) quando: config
 * ausente/corrompido, `boxes_divulgacao` ausente/malformado, slot vazio,
 * arquivo do snippet não existe, ou o header não tem `categoria:`. Fail-soft
 * total, nunca lança.
 */
export function readBoxDivulgacaoCategoriaForSlot(
  slot: 0 | 1 | 2 | 3,
  rootDir: string = REPO_ROOT_FROM_MODULE,
): string | null {
  try {
    const configPath = resolve(rootDir, "platform.config.json");
    if (!existsSync(configPath)) return null;
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    const boxes = cfg?.boxes_divulgacao;
    if (!boxes || typeof boxes !== "object") return null;
    const filename = boxes[`slot${slot}`];
    if (typeof filename !== "string" || !filename) return null;
    const snippetPath = resolve(rootDir, "data", "snippets", filename);
    if (!existsSync(snippetPath)) return null;
    const raw = readFileSync(snippetPath, "utf8");
    const categoria = parseBoxHeaderField(raw, "categoria");
    if (!categoria) return categoria;
    // Self-review finding (#3981): categoria é texto livre digitado no Studio
    // e vira label renderizado — sanitizar markdown (**, #, - ) na fonte única
    // de leitura, mesmo invariante de "output final sem markdown" que vale pro
    // resto da newsletter. `renderKicker` já faz `esc()` (HTML), não markdown.
    const sanitized = categoria.replace(/[*#]/g, "").replace(/^-+\s*/, "").trim();
    return sanitized || null;
  } catch {
    return null;
  }
}

/**
 * `alt:` configurado no header do snippet atribuído ao SLOT — texto alternativo
 * da imagem do box (`box_slot{N}_image`).
 *
 * Existe porque o alt default vem do anchor text do 1º link do box, que muitas
 * vezes é um rótulo de ação genérico ("Ler o artigo", "Quero apoiar"). Quando a
 * imagem CARREGA informação (header de artigo com o título embutido, capa de
 * livro), o alt genérico apaga essa informação pra quem usa leitor de tela ou
 * tem imagens bloqueadas no cliente de e-mail — que é justamente o público que
 * mais depende do alt.
 *
 * Mesmo mecanismo de leitura de `categoria:` (`readBoxDivulgacaoCategoriaForSlot`):
 * disco, no momento do render, via `platform.config.json > boxes_divulgacao`.
 * Ausente → null (renderer cai no anchor text, comportamento de sempre).
 */
export function readBoxDivulgacaoAltForSlot(
  slot: 0 | 1 | 2 | 3,
  rootDir: string = REPO_ROOT_FROM_MODULE,
): string | null {
  try {
    const configPath = resolve(rootDir, "platform.config.json");
    if (!existsSync(configPath)) return null;
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    const boxes = cfg?.boxes_divulgacao;
    if (!boxes || typeof boxes !== "object") return null;
    const filename = boxes[`slot${slot}`];
    if (typeof filename !== "string" || !filename) return null;
    return readBoxDivulgacaoAltForFile(filename, rootDir);
  } catch {
    return null;
  }
}

/**
 * #5457: mesma leitura de `alt:` de `readBoxDivulgacaoAltForSlot`, mas por
 * NOME DE ARQUIVO direto em vez de resolvido a partir de
 * `platform.config.json > boxes_divulgacao.slot{N}`. Existe pra permitir que
 * callers com uma fonte de resolução diferente do config estático (ex: o
 * snippet REALMENTE usado num slot, registrado em
 * `_internal/box-selection.json` pela seleção automática do #4626) consultem
 * o `alt:` do arquivo certo — ver `checkBoxDivulgacaoAltMissing` em
 * `invariant-checks/stage-4.ts`, que passou a preferir essa fonte quando
 * disponível em vez de sempre reler o config estático.
 */
export function readBoxDivulgacaoAltForFile(
  filename: string,
  rootDir: string = REPO_ROOT_FROM_MODULE,
): string | null {
  try {
    const snippetPath = resolve(rootDir, "data", "snippets", filename);
    if (!existsSync(snippetPath)) return null;
    const alt = parseBoxHeaderField(readFileSync(snippetPath, "utf8"), "alt");
    if (!alt) return null;
    // Mesma sanitização de markdown do `categoria:` (#3981) — o alt é atributo
    // HTML, `**` literal ali é ruído pro leitor de tela. `esc()` do HTML fica
    // por conta do renderer.
    return alt.replace(/[*#]/g, "").replace(/^-+\s*/, "").trim() || null;
  } catch {
    return null;
  }
}

/**
 * #5882: `true` quando o snippet (por NOME DE ARQUIVO direto) declara
 * `titulo: false` no header — mesmo mecanismo de leitura de `alt:`
 * (`readBoxDivulgacaoAltForFile`). `false` (comportamento de hoje) quando o
 * arquivo não existe ou o campo está ausente/tem outro valor. Nunca lança.
 */
export function readBoxDivulgacaoNoTituloForFile(
  filename: string,
  rootDir: string = REPO_ROOT_FROM_MODULE,
): boolean {
  try {
    const snippetPath = resolve(rootDir, "data", "snippets", filename);
    if (!existsSync(snippetPath)) return false;
    return readBoxTituloFlag(readFileSync(snippetPath, "utf8")) === false;
  } catch {
    return false;
  }
}

/**
 * #5882: mesmo mecanismo de leitura de `categoria:`/`alt:` do SLOT
 * (`readBoxDivulgacaoCategoriaForSlot`/`readBoxDivulgacaoAltForSlot`) —
 * disco, via `platform.config.json > boxes_divulgacao`, no momento do
 * render. `true` só quando o snippet atualmente atribuído ao slot declara
 * `titulo: false` no header; `false` (fail-soft, nunca lança) em qualquer
 * outro caso — config ausente/corrompido, `boxes_divulgacao`
 * ausente/malformado, slot vazio, ou arquivo do snippet não existe.
 */
export function readBoxDivulgacaoNoTituloForSlot(
  slot: 0 | 1 | 2 | 3,
  rootDir: string = REPO_ROOT_FROM_MODULE,
): boolean {
  try {
    const configPath = resolve(rootDir, "platform.config.json");
    if (!existsSync(configPath)) return false;
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    const boxes = cfg?.boxes_divulgacao;
    if (!boxes || typeof boxes !== "object") return false;
    const filename = boxes[`slot${slot}`];
    if (typeof filename !== "string" || !filename) return false;
    return readBoxDivulgacaoNoTituloForFile(filename, rootDir);
  } catch {
    return false;
  }
}

/**
 * #4504: `true` se o snippet atualmente atribuído ao SLOT em
 * `boxes_divulgacao.slot{N}` (`platform.config.json`) declara `runtime:
 * false` no header (`isRuntimeExcluded`, `shared/snippet-header.ts` — movida
 * de `scripts/studio-ui/studio-boxes.ts` nesta mesma issue porque o pipeline
 * core não pode importar dessa camada UI, ver `test/lib-boundary.test.ts`).
 *
 * `runtime: false` sinaliza que o arquivo é documentação/referência (ex:
 * `intro-campeoes-sorteio.md`, incidente original #4500), não conteúdo real
 * — se um slot algum dia apontar pra ele (config editado manualmente, config
 * antigo não migrado), o texto é injetado verbatim na newsletter.
 * `saveBoxSlots` (Studio UI) já bloqueia essa atribuição no PUT, mas não
 * cobre edição direta do `platform.config.json` — este helper alimenta o
 * invariant check do Stage 4 (`checkBoxDivulgacaoRuntimeExcluded`,
 * `invariant-checks/stage-4.ts`), a defesa em profundidade no próprio
 * pipeline de render.
 *
 * Mesmo mecanismo de leitura dos irmãos (`readBoxDivulgacaoCategoriaForSlot`/
 * `readBoxDivulgacaoAltForSlot`): disco, via `platform.config.json >
 * boxes_divulgacao`. `false` (não excluído) quando: config ausente/
 * corrompido, `boxes_divulgacao` ausente/malformado, slot vazio, ou arquivo
 * do snippet não existe — mesmo fail-soft dos irmãos, nunca lança.
 *
 * `rootDir` (default: raiz do repo real) existe só pra fixture de teste
 * isolada — o call site real (STAGE_4_RULES) nunca passa override.
 */
export function readBoxDivulgacaoRuntimeExcludedForSlot(
  slot: 0 | 1 | 2 | 3,
  rootDir: string = REPO_ROOT_FROM_MODULE,
): boolean {
  try {
    const configPath = resolve(rootDir, "platform.config.json");
    if (!existsSync(configPath)) return false;
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    const boxes = cfg?.boxes_divulgacao;
    if (!boxes || typeof boxes !== "object") return false;
    const filename = boxes[`slot${slot}`];
    if (typeof filename !== "string" || !filename) return false;
    const snippetPath = resolve(rootDir, "data", "snippets", filename);
    if (!existsSync(snippetPath)) return false;
    return isRuntimeExcluded(readFileSync(snippetPath, "utf8"));
  } catch {
    return false;
  }
}

export function extractContent(editionDir: string): NewsletterContent {
  const reviewedPath = resolve(editionDir, "02-reviewed.md");
  const eiaPath = resolve(editionDir, "01-eia.md");

  if (!existsSync(reviewedPath)) {
    throw new Error(`${reviewedPath} not found — run Stage 2 first`);
  }

  const reviewedText = joinMultilineLinks(readFileSync(reviewedPath, "utf8"));

  // #1972/#2978/#3476: remove os blocos dos boxes de divulgação (slot 1, slot
  // 2 e slot 3) ANTES do parse dos destaques. Se um callout estiver colado
  // antes do `---` de fechamento do destaque anterior, o parser o absorveria
  // no corpo/why desse destaque (render duplicado). Strip → sai só como box
  // de divulgação (extraído abaixo do texto original). De-dup determinístico.
  const destaquesText = stripBoxDivulgacao3(stripBoxDivulgacao2(stripBoxDivulgacao1(reviewedText)));

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

  // #4991: posição real do mirror **É IA?** no reviewed.md (null = ausente,
  // cai no fallback #3476 dentro de renderHTML).
  const eiaAnchorSectionIdx = findEiaAnchorSection(reviewedText);

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
  // #3705: texto de coverage pós-callout (callout no meio do bloco de boas-vindas).
  const rawCoverageLineTrailer = extractCoverageLineTrailer(reviewedText);
  const coverageLineTrailer = rawCoverageLineTrailer
    ? reconcileCoverageCount(rawCoverageLineTrailer, renderedItemCount)
    : rawCoverageLineTrailer;
  // #4274: box de divulgação slot 0 — região de introdução, entre a
  // linha/bloco de cobertura e `**DESTAQUE 1`.
  const boxDivulgacao0 = extractBoxDivulgacao0(reviewedText);
  const boxDivulgacao0Image = readBoxDivulgacao0Image(editionDir, boxDivulgacao0);
  const boxDivulgacao0Bold = isBoxDivulgacao0Bold(reviewedText);
  const boxDivulgacao0Categoria = boxDivulgacao0 ? readBoxDivulgacaoCategoriaForSlot(0) : null;
  // #2978: box de divulgação slot 1 (gap D1/D2) e slot 2 (gap D2/D3) — cada
  // slot é fixo por posição, aceitando qualquer formato (bold-line 📚/📣/🎉
  // OU carrinho 🛒).
  const boxDivulgacao1 = extractBoxDivulgacao1(reviewedText);
  // #2136: passa o texto do box pra discriminar livros vs CLARICE. Imagem só
  // vai pro box de livros; box 📣 CLARICE recebe null (sem hero). Só o slot 1
  // suporta imagem (comportamento legado, nunca existiu pro slot 2).
  const boxDivulgacao1Image = readBoxDivulgacao1Image(editionDir, boxDivulgacao1);
  // #3373: peso de fonte do box só-texto controlado pelo bold-wrap da fonte.
  const boxDivulgacao1Bold = isBoxDivulgacao1Bold(reviewedText);
  // #3981: só busca categoria quando o slot de fato tem box no reviewed.md —
  // sem isso, um slot vazio (nunca preenchido, ou suprimido por --no-sponsor)
  // ganharia um rótulo órfão sem box embaixo.
  const boxDivulgacao1Categoria = boxDivulgacao1 ? readBoxDivulgacaoCategoriaForSlot(1) : null;
  const boxDivulgacao2 = extractBoxDivulgacao2(reviewedText);
  // #2978-slot2-parity: mesmo tratamento do slot 1 — a imagem livros_promo só
  // vai pro box de livros, independente de em qual slot ele caiu.
  const boxDivulgacao2Image = readBoxDivulgacao2Image(editionDir, boxDivulgacao2);
  const boxDivulgacao2Bold = isBoxDivulgacao2Bold(reviewedText);
  const boxDivulgacao2Categoria = boxDivulgacao2 ? readBoxDivulgacaoCategoriaForSlot(2) : null;
  // #3476: box de divulgação slot 3 — região pós-último-destaque (D3 em
  // edições de 3, D2 em edições de 2), antes de USE MELHOR/É IA?.
  const boxDivulgacao3 = extractBoxDivulgacao3(reviewedText);
  const boxDivulgacao3Image = readBoxDivulgacao3Image(editionDir, boxDivulgacao3);
  const boxDivulgacao3Bold = isBoxDivulgacao3Bold(reviewedText);
  const boxDivulgacao3Categoria = boxDivulgacao3 ? readBoxDivulgacaoCategoriaForSlot(3) : null;
  const boxDivulgacaoImageExplicit = {
    0: readBoxSlotImage(editionDir, 0) !== null,
    1: readBoxSlotImage(editionDir, 1) !== null,
    2: readBoxSlotImage(editionDir, 2) !== null,
    3: readBoxSlotImage(editionDir, 3) !== null,
  };
  const boxDivulgacaoImageAlt = {
    0: readBoxDivulgacaoAltForSlot(0),
    1: readBoxDivulgacaoAltForSlot(1),
    2: readBoxDivulgacaoAltForSlot(2),
    3: readBoxDivulgacaoAltForSlot(3),
  };
  // #5882: mesmo padrão de boxDivulgacaoImageAlt — lido do disco pra TODO
  // slot, independente de o slot ter box no reviewed.md (mesmo tratamento de
  // boxDivulgacaoImageExplicit/Portrait acima; categoria é a exceção, porque
  // vira texto VISÍVEL de rótulo órfão — ver comentário de
  // boxDivulgacao1Categoria).
  const boxDivulgacaoNoTitulo = {
    0: readBoxDivulgacaoNoTituloForSlot(0),
    1: readBoxDivulgacaoNoTituloForSlot(1),
    2: readBoxDivulgacaoNoTituloForSlot(2),
    3: readBoxDivulgacaoNoTituloForSlot(3),
  };
  const boxDivulgacaoImagePortrait = {
    0: boxDivulgacaoImageExplicit[0] && isBoxSlotImagePortrait(editionDir, 0),
    1: boxDivulgacaoImageExplicit[1] && isBoxSlotImagePortrait(editionDir, 1),
    2: boxDivulgacaoImageExplicit[2] && isBoxSlotImagePortrait(editionDir, 2),
    3: boxDivulgacaoImageExplicit[3] && isBoxSlotImagePortrait(editionDir, 3),
  };

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
    eiaAnchorSectionIdx,
    sorteio,
    encerrar,
    erroIntencional,
    coverageLine,
    introCallout,
    coverageLineTrailer,
    boxDivulgacao0,
    boxDivulgacao0Image,
    boxDivulgacao0Bold,
    boxDivulgacao0Categoria,
    boxDivulgacao1,
    boxDivulgacao1Image,
    boxDivulgacao1Bold,
    boxDivulgacao1Categoria,
    boxDivulgacao2,
    boxDivulgacao2Image,
    boxDivulgacao2Bold,
    boxDivulgacao2Categoria,
    boxDivulgacao3,
    boxDivulgacao3Image,
    boxDivulgacao3Bold,
    boxDivulgacao3Categoria,
    boxDivulgacaoImageExplicit,
    boxDivulgacaoImagePortrait,
    boxDivulgacaoImageAlt,
    boxDivulgacaoNoTitulo,
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
 *   https://cursos.diar.ia.br
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
