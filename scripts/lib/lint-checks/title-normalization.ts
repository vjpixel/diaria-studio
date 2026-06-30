/**
 * lint-checks/title-normalization.ts (#2664 + #2672)
 *
 * Dois checks pré-gate que cobrem normalização de título:
 *
 * 1. `checkTitlePublisherSuffix` (#2664) — flagra títulos que ainda terminam
 *    com um sufixo de veículo (` - Veículo`, ` | Veículo`, ` — Veículo`).
 *    A normalização acontece em `enrich-inbox-articles.ts` (Stage 1), mas
 *    títulos curados pelo editor no inbox ou produzidos pelo writer LLM podem
 *    escapar. Este lint captura o resíduo antes do gate do Stage 4.
 *
 * 2. `checkTitleTrailingPeriod` (#2672) — flagra títulos que terminam com
 *    ponto final único (não reticências). Manchetes não terminam em ponto.
 *
 * ## Escopo: o que é "título" aqui
 *
 *   - DESTAQUE blocks: título é o texto dentro de `[título](url)` (inline link).
 *     O writer pode ainda gerar 3 opções por destaque; todas são verificadas.
 *   - Seções secundárias (LANÇAMENTOS / RADAR / USE MELHOR / etc.):
 *     título é o texto dentro de `[título](url)` (inline link).
 *   - Títulos plain-text (formato legado, sem inline link) em DESTAQUE:
 *     também verificados.
 *
 * ## Separadores detectados em checkTitlePublisherSuffix
 *
 *   - ` | ` (pipe com espaços) — sempre suspeito de sufixo de veículo.
 *   - ` - ` (traço com espaços) — suspeito se o sufixo for de 1-4 palavras
 *     curtas (heurística: indica nome de veículo, não conteúdo do título).
 *   - ` — ` (travessão U+2014 com espaços) — idem.
 *
 *   Falso positivo inevitável raro: "ChatGPT vs Gemini - qual é melhor?" → o
 *   sufixo "qual é melhor?" tem 4 palavras → não seria flagrado (4 palavras
 *   e sem pipe). Decisão conservadora: aceitar esse falso-negativo para não
 *   bloquear títulos legítimos com traço.
 *
 * ## Uso via CLI (lint-newsletter-md.ts)
 *
 *   --check title-publisher-suffix  → checkTitlePublisherSuffix
 *   --check title-trailing-period   → checkTitleTrailingPeriod
 */

import { parseInlineLink } from "../inline-link.ts";
import { HIGHLIGHT_HEADER_RE, URL_LINE_RE, SECTION_BREAK_LINE_RE, SECTION_HEADER_LINE_RE, WHY_MATTERS_LINE_RE } from "./highlight-parsing.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Extrai todos os títulos do newsletter md com número de linha (1-based). */
function extractAllTitles(md: string): Array<{ title: string; line: number }> {
  const lines = md.split("\n");
  const results: Array<{ title: string; line: number }> = [];

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();

    // DESTAQUE block — coletar títulos até a URL ou próximo header
    if (HIGHLIGHT_HEADER_RE.test(t)) {
      let j = i + 1;
      while (j < lines.length) {
        const lt = lines[j].trim();
        if (lt === "") { j++; continue; }
        // Inline link — extrair título
        const inline = parseInlineLink(lt);
        if (inline) {
          results.push({ title: inline.title, line: j + 1 });
          j++;
          continue;
        }
        // URL em linha separada (legacy) → encerra o bloco de títulos
        if (URL_LINE_RE.test(lt)) break;
        if (HIGHLIGHT_HEADER_RE.test(lt)) break;
        if (SECTION_BREAK_LINE_RE.test(lt)) break;
        if (SECTION_HEADER_LINE_RE.test(lt)) break;
        if (WHY_MATTERS_LINE_RE.test(lt)) break;
        // Linha candidata a título plain-text (legacy, sem inline link)
        // Qualquer linha não-vazia, não-URL que não parece body é candidata.
        // Em formato legado, títulos aparecem aqui antes da URL.
        results.push({ title: lt, line: j + 1 });
        j++;
      }
      i = j;
      continue;
    }

    // Seções secundárias — coletar títulos de inline links
    const inline = parseInlineLink(t);
    if (inline) {
      results.push({ title: inline.title, line: i + 1 });
    }

    i++;
  }

  return results;
}

// ---------------------------------------------------------------------------
// #2664 — Publisher suffix lint
// ---------------------------------------------------------------------------

/** Padrão de sufixo de veículo via pipe (` | `). */
const PIPE_SUFFIX_RE = / \| .+$/;

/**
 * Padrão de sufixo de veículo via traço/travessão.
 * Heurística: sufixo de 1–4 palavras após o ÚLTIMO separador.
 * "OpenAI lança GPT-5 - o maior modelo da história" → 6 palavras → não flagra.
 * "ChatGPT consegue fazer check-up; veja como - Canaltech" → 1 palavra → flagra.
 */
const DASH_SUFFIX_RE = / [-—] (\S+(\s+\S+){0,3})$/u;

export interface TitlePublisherSuffixError {
  /** Número de linha no markdown (1-based). */
  line: number;
  /** Título com sufixo. */
  title: string;
  /** Sufixo detectado. */
  suffix: string;
  /** Tipo de separador detectado. */
  separator: "pipe" | "dash" | "em_dash";
}

export interface TitlePublisherSuffixReport {
  ok: boolean;
  errors: TitlePublisherSuffixError[];
}

/**
 * Flagra títulos que ainda têm sufixo de veículo (` | Veículo`, ` - Veículo`,
 * ` — Veículo`). Lint defensivo pré-gate Stage 4.
 */
export function checkTitlePublisherSuffix(md: string): TitlePublisherSuffixReport {
  const titles = extractAllTitles(md);
  const errors: TitlePublisherSuffixError[] = [];

  for (const { title, line } of titles) {
    const t = title.trim();

    // Pipe — sempre suspeito
    const pipeMatch = t.match(PIPE_SUFFIX_RE);
    if (pipeMatch) {
      errors.push({
        line,
        title: t,
        suffix: pipeMatch[0].slice(3).trim(), // remove leading " | "
        separator: "pipe",
      });
      continue;
    }

    // Traço/travessão — heurística de 1-4 palavras no sufixo
    const emDashIdx = t.lastIndexOf(" — ");
    const dashIdx = t.lastIndexOf(" - ");
    const sepIdx = Math.max(dashIdx, emDashIdx);

    if (sepIdx !== -1) {
      const isEmDash = emDashIdx > dashIdx;
      const sepLen = 3; // " - ".length = " — ".length = 3 chars
      const suffix = t.slice(sepIdx + sepLen).trim();
      // Heurística: ≤4 palavras → provável nome de veículo
      const wordCount = suffix.split(/\s+/).filter(Boolean).length;
      if (wordCount >= 1 && wordCount <= 4) {
        errors.push({
          line,
          title: t,
          suffix,
          separator: isEmDash ? "em_dash" : "dash",
        });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// #2672 — Trailing period lint
// ---------------------------------------------------------------------------

export interface TitleTrailingPeriodError {
  /** Número de linha no markdown (1-based). */
  line: number;
  /** Título com ponto final. */
  title: string;
}

export interface TitleTrailingPeriodReport {
  ok: boolean;
  errors: TitleTrailingPeriodError[];
}

/**
 * Flagra títulos que terminam com ponto final único (não reticências).
 * Manchetes não terminam em ponto. Lint defensivo pré-gate Stage 4.
 *
 * Preserva:
 *   - `?` e `!` — pontuação intencional
 *   - `…` (U+2026) — reticências unicode
 *   - `...` (3+ pontos) — reticências ascii
 */
export function checkTitleTrailingPeriod(md: string): TitleTrailingPeriodReport {
  const titles = extractAllTitles(md);
  const errors: TitleTrailingPeriodError[] = [];

  for (const { title, line } of titles) {
    const t = title.trim();
    if (!t) continue;
    // Reticências → ok
    if (/\.{2,}$/.test(t)) continue;
    if (t.endsWith("…")) continue;
    // Ponto único no fim → erro
    if (t.endsWith(".")) {
      errors.push({ line, title: t });
    }
  }

  return { ok: errors.length === 0, errors };
}
