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

// ── Shared types & parsing (also used by render-newsletter-html.ts) ───

export interface Destaque {
  n: 1 | 2 | 3;
  category: string;
  title: string;
  body: string;          // paragraphs before "Por que isso importa:"
  why: string;           // paragraphs after "Por que isso importa:"
  url: string;
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

    const body = lines.slice(bodyStart, bodyEnd).join('\n').trim();

    // Why end: até URL legacy (se existe e está depois do whyIdx) OU fim.
    const whyEnd = (urlIdx !== -1 && !isNewFormat && urlIdx > whyIdx) ? urlIdx : lines.length;
    const why = whyIdx !== -1 ? lines.slice(whyIdx + 1, whyEnd).join('\n').trim() : '';

    const url = isInlineFormat
      ? inlineUrl!
      : (urlIdx !== -1 ? lines[urlIdx].trim() : '');

    destaques.push({ n, category, title, body, why, url });
  }

  // Sort by n to guarantee d1, d2, d3 order.
  destaques.sort((a, b) => a.n - b.n);
  return destaques;
}

/**
 * Build subtitle from D2 and D3 titles.
 * Exported so render-newsletter-html.ts uses the same logic.
 */
export function buildSubtitle(d2title: string, d3title: string): string {
  const combined = `${d2title} | ${d3title}`;
  if (combined.length <= 80) return combined;
  if (d2title.length <= 80) return d2title;
  return d2title.slice(0, 77) + '...';
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

  if (destaques.length !== 3) {
    console.error(`Expected 3 destaques, got ${destaques.length}. Check formatting in ${path}.`);
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

  const [d1, d2, d3] = destaques;
  const output = {
    title: d1.title,
    subtitle: buildSubtitle(d2.title, d3.title),
    destaques,
  };

  console.log(JSON.stringify(output, null, 2));
}

// Only run CLI when executed directly (not when imported, e.g. from tests
// or render-newsletter-html.ts). Match the script file name precisely
// instead of substring — `extract-destaques.test.ts` was triggering CLI mode.
const _argv1 = process.argv[1]?.replace(/\\/g, '/') ?? '';
const isDirectRun = /\/scripts\/extract-destaques\.ts$/.test(_argv1);
if (isDirectRun) {
  main();
}
