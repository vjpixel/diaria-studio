#!/usr/bin/env node
// Usage:
//   npx tsx scripts/extract-destaques.ts <path-to-02-reviewed.md>
//
// Parses a reviewed newsletter and extracts the 3 destaques as structured JSON.
// Replaces LLM-based parsing in publish-newsletter (saves tokens, zero ambiguity).
//
// Expected input format (regular, enforced by writer.md + Clarice inline review):
//
//   DESTAQUE 1 | CATEGORIA
//   Título escolhido
//   https://url-da-fonte    ← #172: URL imediatamente abaixo do título
//
//   Corpo (1–N parágrafos)...
//
//   Por que isso importa:
//   Explicação (1–N parágrafos)...
//
//   ---
//   DESTAQUE 2 | CATEGORIA
//   ...
//
// Backward compat: layout legacy (pré-#172) tinha URL como última linha do
// bloco. O parser aceita ambos: URL é o primeiro `^https?://` dentro do
// bloco, em qualquer posição (linha 2 ou final).

import fs from 'fs';
import { looksLikeTitleOption } from './lib/title-heuristic.ts';
import { parseInlineLink, isInlineLinkLine } from './lib/inline-link.ts';
import { isMainModule } from "./lib/cli-args.ts";

// ── Shared types & parsing (also used by render-newsletter-html.ts) ───

export interface AprofundeItem {
  title: string;
  url: string;
  source: string;
}

export interface Destaque {
  n: 1 | 2 | 3;
  category: string;
  title: string;
  body: string;          // paragraphs before "Por que isso importa:"
  why: string;           // paragraphs after "Por que isso importa:" (exclui Aprofunde)
  url: string;
  // #3920: bloco "Aprofunde:" — fontes do cluster same-story. Presente só
  // quando o destaque tem cluster_sources. NÃO conta no char-limit do destaque.
  aprofunde?: AprofundeItem[];
}

// #3920: header + item do bloco "Aprofunde:".
//   Aprofunde:
//
//   * [Título do artigo](URL) - Fonte
export const APROFUNDE_HEADER_RE = /^Aprofunde:\s*$/i;
// bullet (* ou -) + inline-link (bold opcional, parênteses balanceados no path)
// + separador (- – —) + fonte. A fonte é opcional (defensivo).
export const APROFUNDE_ITEM_RE =
  /^[*-]\s+\*{0,2}\[([^\]]+)\]\((https?:\/\/[^\s)]+(?:\([^\s)]*\)[^\s)]*)*)\)\*{0,2}\s*(?:[-–—]\s*(.+?))?\s*$/;

/** Parse dos itens do bloco Aprofunde entre [startIdx, endIdx). */
export function parseAprofundeItems(
  lines: string[],
  startIdx: number,
  endIdx: number,
): AprofundeItem[] {
  const items: AprofundeItem[] = [];
  for (let i = startIdx; i < endIdx; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    const m = t.match(APROFUNDE_ITEM_RE);
    if (m) {
      items.push({ title: m[1].trim(), url: m[2].trim(), source: (m[3] ?? "").trim() });
    }
  }
  return items;
}

/**
 * Parse destaques from the reviewed newsletter text.
 * Exported so render-newsletter-html.ts can reuse the same logic.
 */
export function parseDestaques(raw: string): Destaque[] {
  const sections = raw.split(/^---$/m).map(s => s.trim()).filter(Boolean);
  const destaques: Destaque[] = [];

  for (const section of sections) {
    // Header — plain ou em **negrito** (#590)
    const headerMatch = section.match(/^(?:\*\*)?DESTAQUE\s+([123])\s*\|\s*(.+?)(?:\*\*)?$/m);
    if (!headerMatch) continue;

    const n = parseInt(headerMatch[1], 10) as 1 | 2 | 3;
    const category = headerMatch[2].trim();

    // Remove the header line; work with the remaining content.
    // Aceita header com ou sem **negrito**.
    const afterHeader = section.replace(/^(?:\*\*)?DESTAQUE.*$/m, '').trim();
    const lines = afterHeader.split(/\r?\n/);

    // Title = first non-empty line after header.
    const titleIdx = lines.findIndex(l => l.trim().length > 0);
    if (titleIdx === -1) continue;
    const titleRaw = lines[titleIdx].trim();

    // #599 — inline-link format: `[título](URL)` na linha do título.
    // Se bater, extrai title+url do próprio link e pula busca de URL solo.
    const titleInlineLink = parseInlineLink(titleRaw);
    const title = titleInlineLink?.title ?? titleRaw;

    // Find "Por que isso importa:" marker.
    const whyIdx = lines.findIndex(l => /^Por que isso importa:/i.test(l.trim()));

    // #3920: "Aprofunde:" marker (bloco de fontes do cluster). Fica DEPOIS do
    // why; delimita o fim do why e o início dos itens Aprofunde.
    const aprofundeIdx = lines.findIndex(l => APROFUNDE_HEADER_RE.test(l.trim()));

    // Coletar todas as http-lines (linhas iniciando com http://) com seus índices.
    // A URL canônica é uma das duas posições válidas:
    //   - novo formato (#172): URL imediatamente após o bloco de títulos,
    //     antes de qualquer linha em branco ou parágrafo do body.
    //   - legacy: última http-line do bloco, depois de "Por que isso importa:"
    //     (ou simplesmente a última se whyIdx não existe).
    // URLs bare em parágrafos do body NÃO são canônicas — escolhemos a posição
    // estrutural correta pra evitar B1 (URL inline ganhando da canônica).
    const httpLines = lines
      .map((l, i) => /^https?:\/\//.test(l.trim()) ? i : -1)
      .filter(i => i !== -1);

    // #599 — formato inline: URL embedded no título via `[título](URL)`.
    // Quando título é inline link, body começa logo após o bloco de títulos
    // (sem linha solo de URL).
    let newFormatUrlIdx: number | undefined;
    let inlineFormatTitleEndIdx: number | undefined; // último índice do bloco de títulos inline
    let inlineUrl: string | undefined;
    if (titleInlineLink) {
      inlineUrl = titleInlineLink.url;
      // Encontrar fim do bloco de títulos inline (3 opções pré-gate ou 1 pós-gate).
      // Avança até primeira linha que não é blank nem inline-link nem comentário.
      let k = titleIdx + 1;
      while (k < lines.length) {
        const t = lines[k].trim();
        if (t === '') { k++; continue; }
        if (isInlineLinkLine(t)) { k++; continue; }
        break;
      }
      // k-1 pode ser uma blank line (formato #245 tem blank entre elementos),
      // mas bodyStart = urlIdx+1 = k-1+1 = k = primeira linha não-link não-blank.
      // URL é extraída de inlineUrl diretamente (não de lines[urlIdx]), então
      // apontar pra blank não causa problema na extração.
      inlineFormatTitleEndIdx = k - 1;
    } else {
      // Novo formato (#172, expandido em #245): URL imediatamente após o bloco
      // de título(s). Pode ter blank lines entre elementos (double-newline) ou
      // não (single-newline). Heurística (#259): looksLikeTitleOption aceita
      // títulos curtos terminados em `?`, `!`, `...` ou palavras; rejeita
      // linhas longas ou terminadas em ponto único (= parágrafo do body).
      // Sem isso, a primeira URL "inline" no body do legacy seria escolhida
      // como canônica (B1 regression).
      let k = titleIdx + 1;
      let stoppedAtUrl = false;
      while (k < lines.length) {
        const t = lines[k].trim();
        if (t === '') { k++; continue; }
        if (/^https?:\/\//.test(t)) { stoppedAtUrl = true; break; }
        if (/^Por que isso importa:/i.test(t)) break;
        if (!looksLikeTitleOption(t)) break;
        k++;
      }
      if (stoppedAtUrl) newFormatUrlIdx = k;
    }

    // Legacy: última URL do bloco (se houver), prioritariamente após whyIdx.
    const legacyUrlIdx = whyIdx !== -1
      ? httpLines.filter(i => i > whyIdx).pop()
      : httpLines[httpLines.length - 1];

    let urlIdx: number;
    let isNewFormat: boolean;
    let isInlineFormat = false;
    if (inlineUrl !== undefined && inlineFormatTitleEndIdx !== undefined) {
      // #599 — inline-link format
      urlIdx = inlineFormatTitleEndIdx;
      isNewFormat = true;
      isInlineFormat = true;
    } else if (newFormatUrlIdx !== undefined) {
      urlIdx = newFormatUrlIdx;
      isNewFormat = true;
    } else if (legacyUrlIdx !== undefined) {
      urlIdx = legacyUrlIdx;
      isNewFormat = false;
    } else {
      urlIdx = -1;
      isNewFormat = false;
    }

    // Body começa após a URL (novo formato) / após o último título (inline) / após título (legacy).
    const bodyStart = isNewFormat ? urlIdx + 1 : titleIdx + 1;

    // Body end: até "Por que isso importa:" (se existe) OU até a URL legacy
    // no fim (se URL está depois do whyIdx) OU fim do bloco.
    let bodyEnd: number;
    if (whyIdx !== -1) {
      bodyEnd = whyIdx;
    } else if (urlIdx !== -1 && !isNewFormat) {
      bodyEnd = urlIdx;
    } else {
      bodyEnd = lines.length;
    }
    // #3920: se não há "Por que isso importa" mas há bloco Aprofunde, o body não
    // deve absorver os itens do Aprofunde (mesma proteção do whyEnd abaixo).
    // No caso normal (whyIdx existe) bodyEnd=whyIdx < aprofundeIdx → no-op.
    if (aprofundeIdx !== -1 && aprofundeIdx >= bodyStart && aprofundeIdx < bodyEnd) {
      bodyEnd = aprofundeIdx;
    }

    const body = lines.slice(bodyStart, bodyEnd).join('\n').trim();

    // Why end: até URL legacy (se existe e está depois do whyIdx) OU fim.
    let whyEnd = (urlIdx !== -1 && !isNewFormat && urlIdx > whyIdx) ? urlIdx : lines.length;
    // #3920: o bloco Aprofunde (se presente e após o why) fecha o why antes dele
    // — assim os itens Aprofunde NÃO poluem o why (e não contam no char-limit).
    if (aprofundeIdx !== -1 && aprofundeIdx > whyIdx && aprofundeIdx < whyEnd) {
      whyEnd = aprofundeIdx;
    }
    const why = whyIdx !== -1 ? lines.slice(whyIdx + 1, whyEnd).join('\n').trim() : '';

    const url = isInlineFormat
      ? inlineUrl!
      : (urlIdx !== -1 ? lines[urlIdx].trim() : '');

    // #3920: itens do bloco Aprofunde (do header até a URL legacy final ou fim).
    let aprofunde: AprofundeItem[] | undefined;
    if (aprofundeIdx !== -1) {
      const aprofundeEnd =
        (urlIdx !== -1 && !isNewFormat && urlIdx > aprofundeIdx) ? urlIdx : lines.length;
      const items = parseAprofundeItems(lines, aprofundeIdx + 1, aprofundeEnd);
      if (items.length > 0) aprofunde = items;
    }

    destaques.push({ n, category, title, body, why, url, ...(aprofunde ? { aprofunde } : {}) });
  }

  // Sort by n to guarantee d1, d2, d3 order.
  destaques.sort((a, b) => a.n - b.n);
  return destaques;
}

// ── Edição visual de campo (#3806, Opção B — spike título de destaque) ────

export interface ReplaceDestaqueTitleResult {
  ok: boolean;
  md?: string;
  error?: string;
}

// Reconstrução da linha de título quando ela é um inline-link (#599),
// preservando a convenção de negrito ORIGINAL da linha (#590 outer-wrap,
// #1051 inner-wrap) — o objetivo é trocar SÓ o texto do título, nunca o
// formato ao redor dele. Regex deliberadamente mais simples que o parser
// completo de `inline-link.ts` (sem scan de balanceamento de parênteses
// explícito) — como os 3 padrões abaixo são ANCORADOS no fim da linha
// (`$`), o backtracking guloso do próprio regex já resolve URLs com
// parênteses literais (Wikipedia, `arquivo (1).pdf`) corretamente sem
// precisar de scan manual (ver teste "regex simplificado... ainda lida bem
// com URL contendo parênteses" em extract-destaques.test.ts). O fallback de
// recusa abaixo (`isInlineLinkLine` true mas nenhum dos 3 regex casa) é
// defensivo pra shapes que não conseguimos enumerar com confiança — preferir
// recusar explicitamente a arriscar reconstrução errada.
const OUTER_BOLD_LINK_RE = /^\*\*\[(.+)\]\((https?:\/\/\S+)\)\*\*$/;
const INNER_BOLD_LINK_RE = /^\[\*\*(.+)\*\*\]\((https?:\/\/\S+)\)$/;
const PLAIN_LINK_RE = /^\[(.+)\]\((https?:\/\/\S+)\)$/;

/**
 * Reconstrói a linha de título inline-link com `newTitle` no lugar do texto
 * antigo, preservando URL + convenção de negrito. `null` quando a linha
 * casa como inline-link (`isInlineLinkLine` concorda) mas em formato
 * complexo demais pro regex simplificado acima (ex: URL com parênteses
 * literais) — o caller trata isso como falha explícita, nunca reconstrução
 * arriscada.
 */
function rebuildInlineLinkTitleLine(originalTrimmed: string, newTitle: string): string | null {
  const outer = originalTrimmed.match(OUTER_BOLD_LINK_RE);
  if (outer) return `**[${newTitle}](${outer[2]})**`;
  const inner = originalTrimmed.match(INNER_BOLD_LINK_RE);
  if (inner) return `[**${newTitle}**](${inner[2]})`;
  const plain = originalTrimmed.match(PLAIN_LINK_RE);
  if (plain) return `[${newTitle}](${plain[2]})`;
  return null;
}

/**
 * Substitui SOMENTE a linha do título do destaque `n` no MD bruto de
 * `02-reviewed.md`, preservando literalmente todo o resto do arquivo (demais
 * destaques, categorias, URLs, corpo, "Por que isso importa", separadores
 * `---`, seções fora dos destaques) — a peça central do round-trip
 * visão→região-do-MD do #3806 (Opção B). Localiza o header/título com a
 * MESMA lógica de `parseDestaques` (header `DESTAQUE N | categoria`, título =
 * 1ª linha não-vazia após o header dentro do bloco), mas trabalhando sobre
 * ÍNDICES DE LINHA GLOBAIS do arquivo inteiro (não duplica parsing de
 * body/why/url, que não mudam nesta operação).
 *
 * Espera exatamente 1 linha de título no bloco (pós-gate, ver
 * `countTitlesPerHighlight` em lint-newsletter-md.ts — `02-reviewed.md` já
 * chegou aqui podado a 1 título só; múltiplas opções pré-gate não são o caso
 * de uso desta função).
 *
 * Falha (`ok:false`, nunca lança) quando: destaque `n` não existe no arquivo,
 * o bloco não tem linha de título, o novo título é vazio, ou o título
 * original é um inline-link em formato complexo demais pra reconstruir com
 * confiança.
 */
export function replaceDestaqueTitleInMd(raw: string, n: 1 | 2 | 3, newTitle: string): ReplaceDestaqueTitleResult {
  const trimmedTitle = newTitle.trim().replace(/\s+/g, ' ');
  if (!trimmedTitle) return { ok: false, error: 'título não pode ser vazio' };

  const eol = /\r\n/.test(raw) ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);

  const headerRe = new RegExp(`^(?:\\*\\*)?DESTAQUE\\s+${n}\\s*\\|`);
  const headerIdx = lines.findIndex((l) => headerRe.test(l.trim()));
  if (headerIdx === -1) return { ok: false, error: `DESTAQUE ${n} não encontrado no arquivo` };

  let blockEnd = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i].trim())) { blockEnd = i; break; }
  }

  let titleIdx = -1;
  for (let i = headerIdx + 1; i < blockEnd; i++) {
    if (lines[i].trim().length > 0) { titleIdx = i; break; }
  }
  if (titleIdx === -1) return { ok: false, error: `DESTAQUE ${n}: bloco vazio, sem linha de título` };

  const originalTrimmed = lines[titleIdx].trim();
  const inlineLine = rebuildInlineLinkTitleLine(originalTrimmed, trimmedTitle);
  if (inlineLine !== null) {
    lines[titleIdx] = inlineLine;
    return { ok: true, md: lines.join(eol) };
  }
  if (isInlineLinkLine(originalTrimmed)) {
    return {
      ok: false,
      error: `DESTAQUE ${n}: título em formato de link inline complexo demais pra edição visual — edite via Markdown`,
    };
  }
  // Formato "novo" (#172/#245): título isolado numa linha, URL na linha
  // seguinte — substitui só o texto da linha do título.
  lines[titleIdx] = trimmedTitle;
  return { ok: true, md: lines.join(eol) };
}

/**
 * Build subtitle from D2 and D3 titles.
 * Exported so render-newsletter-html.ts uses the same logic.
 *
 * #1214 (2026-05-13): threshold subido de 80 → 200. Beehiiv subtitle/preview
 * aceita 200 chars (verificado live no UI: indicador "90/200"). 80 era
 * excessivamente conservador — em 260517 (86 chars combined), o D3 caiu
 * fora silenciosamente. Memory `feedback_beehiiv_sections.md` declara que
 * subtitle DEVE ser "{D2} | {D3}".
 */
export function buildSubtitle(d2title: string, d3title: string): string {
  const combined = `${d2title} | ${d3title}`;
  if (combined.length <= 200) return combined;
  if (d2title.length <= 200) return d2title;
  return d2title.slice(0, 197) + '...';
}

// ── CLI entry point ──────────────────────────────────────────────────

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: npx tsx scripts/extract-destaques.ts <path>');
    process.exit(2);
  }

  const raw = fs.readFileSync(path, 'utf8');
  const destaques = parseDestaques(raw);

  // #2316: aceita 2–3 destaques (editorial legítimo: editor demove D3 para Radar).
  if (destaques.length < 2 || destaques.length > 3) {
    console.error(`Expected 2–3 destaques, got ${destaques.length}. Check formatting in ${path}.`);
    process.exit(1);
  }

  // Every destaque must have a source URL — publish-newsletter depends on it for
  // the "Ler mais" link. URL fica imediatamente abaixo do título (formato novo,
  // #172) ou na última linha do bloco (legacy). Empty = writer esqueceu ou
  // bloco malformado.
  const missingUrl = destaques.filter(d => !d.url);
  if (missingUrl.length > 0) {
    const which = missingUrl.map(d => `D${d.n} ("${d.title}")`).join(', ');
    console.error(`Destaque(s) sem URL de fonte: ${which}. Adicione a URL na linha imediatamente abaixo do título em ${path}.`);
    process.exit(1);
  }

  const d1 = destaques[0];
  const d2 = destaques[1];
  const d3 = destaques[2]; // undefined para edições com 2 destaques
  const subtitle = d3 !== undefined
    ? buildSubtitle(d2.title, d3.title)
    : d2.title.slice(0, 200);
  const output = {
    title: d1.title,
    subtitle,
    destaques,
  };

  console.log(JSON.stringify(output, null, 2));
}

// Only run CLI when executed directly (not when imported, e.g. from tests
// or render-newsletter-html.ts). Match the script file name precisely
// instead of substring — `extract-destaques.test.ts` was triggering CLI mode.
const isDirectRun = isMainModule(import.meta.url);
if (isDirectRun) {
  main();
}
