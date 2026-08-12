/**
 * lint-checks/ia-in-title.ts (#4825)
 *
 * Backstop editorial: a diar.ia.br é uma newsletter *sobre* IA — dizer
 * "IA"/"inteligência artificial"/"AI" em título de destaque é redundante
 * (o contexto já está dado) e gasta caracteres preciosos (título ≤52 chars,
 * `editorial-rules.md` seção 3). A regra editorial completa (com as
 * exceções legítimas: manchete sobre a categoria em si, ambiguidade real,
 * nome próprio/citação/nome de produto) vive em `context/editorial-rules.md`
 * seção 5 (Linguagem) — este check é só o backstop mecânico.
 *
 * **WARN-ONLY por design (decisão do editor, #4825).** Um lint bloqueante
 * teria falso-positivo constante nas exceções legítimas acima — nome de
 * produto como "Perplexity AI", manchete sobre a categoria ("regulação de
 * IA na UE"). Sem allowlist (mesmo padrão de `title-normalization.ts`
 * #2664/#2672): o check flagra QUALQUER ocorrência, o editor decide caso a
 * caso no gate da Etapa 4.
 *
 * ## Escopo: só títulos de DESTAQUE
 *
 * Diferente de `title-normalization.ts` (que cobre títulos de seções
 * secundárias também), este check é deliberadamente restrito a blocos
 * DESTAQUE — o pedido do editor (#4825) foi "sinalizando ocorrências de
 * IA/inteligência artificial/AI em títulos de destaque", não em itens de
 * LANÇAMENTOS/RADAR/USE MELHOR.
 *
 * ## Termos detectados
 *
 *   - `IA` — sigla, case-sensitive (maiúscula). Case-sensitive evita falso
 *     positivo em palavras comuns do português que contêm "ia" minúsculo
 *     (ex: "praia", "dia", "seria") — a sigla é convencionalmente escrita
 *     em maiúsculas.
 *   - `AI` — sigla em inglês, mesma lógica de case-sensitivity. "Aí" (com
 *     acento) é uma palavra portuguesa diferente e não colide.
 *   - `inteligência artificial` / `inteligencia artificial` — frase
 *     completa, case-insensitive, com e sem acento.
 *
 * Em todos os casos, `\b` (word boundary) evita casar substring dentro de
 * uma palavra maior — "NVIDIA" não flagra (é uma palavra contígua; `\b` só
 * insere entre um caractere de palavra e um não-palavra), nem "Praia".
 */

import { HIGHLIGHT_HEADER_RE, SECTION_HEADER_LINE_RE } from "./highlight-parsing.ts";
import { walkDestaqueTitles } from "./destaque-title-walk.ts";
import { looksLikeTitleOption } from "../title-heuristic.ts";

export interface TitleMentionsIaError {
  /** Número do destaque (1/2/3). */
  destaque: number;
  /** Categoria do destaque (grupo 2 do header). */
  category: string;
  /** Número de linha no markdown (1-based). */
  line: number;
  /** Título flagrado. */
  title: string;
  /** Termo casado (ex: "IA", "AI", "inteligência artificial"). */
  matched: string;
}

export interface TitleMentionsIaReport {
  ok: boolean;
  errors: TitleMentionsIaError[];
}

// Sigla PT — case-sensitive (maiúscula) pra não casar "ia" minúsculo dentro
// de palavras comuns do português.
const IA_ABBREV_RE = /\bIA\b/;
// Sigla EN — mesma lógica; "Aí" (acento) é palavra distinta, não colide.
const AI_ABBREV_RE = /\bAI\b/;
// Frase completa, com/sem acento, case-insensitive.
const IA_PHRASE_RE = /\bintelig(?:ê|e)ncia artificial\b/i;

function findIaMention(title: string): string | null {
  const phrase = title.match(IA_PHRASE_RE);
  if (phrase) return phrase[0];
  const abbrevPt = title.match(IA_ABBREV_RE);
  if (abbrevPt) return abbrevPt[0];
  const abbrevEn = title.match(AI_ABBREV_RE);
  if (abbrevEn) return abbrevEn[0];
  return null;
}

/**
 * Flagra títulos de DESTAQUE contendo "IA"/"AI"/"inteligência artificial".
 * WARN-ONLY (#4825) — `ok: false` nunca deve virar bloqueio de gate; ver
 * docstring do módulo.
 */
export function checkTitleMentionsIA(md: string): TitleMentionsIaReport {
  // #5084: normaliza CRLF→LF antes do split — sem isso, uma linha com \r
  // sobrando no fim quebra HIGHLIGHT_HEADER_RE (que usa `$` sem /m, exigindo
  // fim de string exato; `.` não casa \r).
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const errors: TitleMentionsIaError[] = [];

  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(HIGHLIGHT_HEADER_RE);
    if (!m) {
      i++;
      continue;
    }
    const destaqueNum = parseInt(m[1], 10);
    const category = m[2].trim();
    const { titles, nextIndex } = walkDestaqueTitles(
      lines,
      i + 1,
      category,
      looksLikeTitleOption,
    );
    for (const { title, line } of titles) {
      // Guarda contra falso-positivo de header de seção secundária colado
      // (não deveria acontecer via walkDestaqueTitles, mas por segurança).
      if (SECTION_HEADER_LINE_RE.test(title.trim())) continue;
      const matched = findIaMention(title);
      if (matched) {
        errors.push({ destaque: destaqueNum, category, line, title, matched });
      }
    }
    i = nextIndex;
  }

  return { ok: errors.length === 0, errors };
}
