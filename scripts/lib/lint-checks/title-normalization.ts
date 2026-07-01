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
 *   ## Divergência intencional lint vs. normalizer
 *
 *   Este lint é DELIBERADAMENTE mais amplo que `stripPublisherSuffix`
 *   (`scripts/lib/strip-publisher-suffix.ts`): o normalizer só strip traço/
 *   travessão quando o sufixo está em `KNOWN_DASH_PUBLISHERS` (allowlist) e o
 *   prefixo ≥ MIN_PREFIX_LEN; o lint usa só a heurística de 1–4 palavras, sem
 *   allowlist nem guard de prefixo. Motivo: o lint é backstop para títulos que
 *   NÃO passaram pelo normalizer (gerados pelo writer LLM, curados pelo editor),
 *   onde o veículo pode ser desconhecido. Consequência aceita: o lint pode
 *   flagrar um título que o normalizer não strip automaticamente — por isso é
 *   WARN-ONLY no Stage 4 (não bloqueia o gate), e o editor decide.
 *
 *   Falso positivo possível: sufixos curtos legítimos com traço, ex:
 *   "ChatGPT vs Gemini - qual é melhor?" → sufixo "qual é melhor?" tem 3
 *   palavras (≤4) → SERIA flagrado. Como é WARN-ONLY, o editor simplesmente
 *   ignora o aviso. Sufixos de 5+ palavras não são flagrados (provável
 *   conteúdo de título, não veículo).
 *
 * ## Uso via CLI (lint-newsletter-md.ts)
 *
 *   --check title-publisher-suffix  → checkTitlePublisherSuffix
 *   --check title-trailing-period   → checkTitleTrailingPeriod
 */

import { parseInlineLink } from "../inline-link.ts";
import { looksLikeTitleOption } from "../title-heuristic.ts";
import { HIGHLIGHT_HEADER_RE, SECTION_BREAK_LINE_RE, SECTION_HEADER_LINE_RE } from "./highlight-parsing.ts";
import { walkDestaqueTitles } from "./destaque-title-walk.ts"; // #2693 item 1 — parser compartilhado

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Extrai todos os títulos do newsletter md com número de linha (1-based).
 *
 * Anti-falso-positivo (#2664/#2672 follow-up): este parser NÃO pode coletar
 * linhas de corpo como se fossem títulos, senão os checks de sufixo/ponto-final
 * flagram texto de parágrafo. Dois guards (espelham `countTitlesPerHighlight`
 * e `checkSecondaryItemsHaveSummary`):
 *
 *   1. Em bloco DESTAQUE, a coleta plain-text (formato legado) usa
 *      `looksLikeTitleOption` — uma linha que parece corpo (longa OU terminando
 *      em ponto único) ENCERRA a coleta do bloco, em vez de virar título.
 *   2. Inline links só são coletados como título de item quando estamos DENTRO
 *      de uma seção secundária (LANÇAMENTOS / RADAR / etc.). Um link de
 *      referência no corpo de um DESTAQUE (ex: na linha "Por que isso importa:")
 *      NÃO é título e não deve ser coletado.
 */
function extractAllTitles(md: string): Array<{ title: string; line: number }> {
  const lines = md.split("\n");
  const results: Array<{ title: string; line: number }> = [];

  // Só coletamos inline links como títulos quando estamos numa seção secundária.
  let inSecondarySection = false;

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();

    // DESTAQUE block — coletar títulos via parser compartilhado (#2693 item 1
    // — antes esta função reimplementava o walk feito por
    // `countTitlesPerHighlight` em titles-per-highlight.ts, sincronizado só
    // por comentário. `walkDestaqueTitles` centraliza o walk + break;
    // `looksLikeTitleOption` continua sendo o filtro de candidatura de título
    // (mesmo critério de #245/#259).
    const headerMatch = t.match(HIGHLIGHT_HEADER_RE);
    if (headerMatch) {
      inSecondarySection = false; // o corpo do destaque NÃO é seção secundária
      const category = headerMatch[2].trim();
      // #2778: `walkDestaqueTitles` herda o guard `t !== category` (não quebra
      // a coleta quando uma linha de corpo repete o nome da categoria do
      // destaque) — decisão CONSCIENTE, não efeito colateral da consolidação
      // do #2693. Ver docstring de `walkDestaqueTitles` pra rationale completo.
      const { titles, nextIndex } = walkDestaqueTitles(lines, i + 1, category, looksLikeTitleOption);
      results.push(...titles);
      i = nextIndex;
      continue;
    }

    // Header de seção secundária (LANÇAMENTOS / RADAR / USE MELHOR / ...) — ativa
    // a coleta de inline links como títulos de item. Tolera bold (`**...**`).
    const headerCandidate = t.replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
    if (SECTION_HEADER_LINE_RE.test(t) || SECTION_HEADER_LINE_RE.test(headerCandidate)) {
      inSecondarySection = true;
      i++;
      continue;
    }
    // Separador `---` encerra a seção secundária corrente.
    if (SECTION_BREAK_LINE_RE.test(t)) {
      inSecondarySection = false;
      i++;
      continue;
    }

    // Dentro de seção secundária: títulos de item são inline links.
    if (inSecondarySection) {
      const inline = parseInlineLink(t);
      if (inline) {
        results.push({ title: inline.title, line: i + 1 });
      }
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

// Nota: a detecção de traço/travessão é feita inline em `checkTitlePublisherSuffix`
// via `lastIndexOf` (pega o ÚLTIMO separador) + contagem de palavras do sufixo.
// Não há regex dedicada — `lastIndexOf` é mais simples que ancorar a regex no
// último separador.

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
