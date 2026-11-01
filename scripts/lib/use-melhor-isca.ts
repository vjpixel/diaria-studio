/**
 * use-melhor-isca.ts (#11667)
 *
 * Padrão do 4º post social (`## um`, item USE MELHOR) como chamariz para a
 * edição do dia. Decisões do editor (30/10/2026 e briefing overnight 261101b,
 * registradas na issue):
 *
 *   1. Isca: quando o item é uma lista ("15 funções", "10 dicas"), o post mostra
 *      uma PARTE dos itens e fecha apontando para a edição, SEM dizer quantas
 *      faltam ("mostramos 3 das 15" é proibido).
 *   2. Na edição, o item segue com link + uma frase — o post não pode prometer
 *      mais do que isso (nada de "a lista completa está na edição").
 *   3. A chamada leva a DATA da edição ("na edição de DD/MM"), nunca "de hoje":
 *      o post é lido dias depois e "hoje" passa a apontar para o dia errado.
 *      O permalink (`{edition_url}`) entra pelo canal, no publish (ver
 *      `context/editorial-rules.md` §"USE MELHOR no social").
 *   4. No texto corrido (item sem `steps`, exatamente 3 parágrafos, #10246) a
 *      chamada fica no FIM do 3º parágrafo, com UMA única frase antes dela —
 *      assim o corte do slide (`splitParagraphIntoTwoBlocks`, fronteira de
 *      frase mais perto do meio) deixa a chamada sozinha no 2º bloco do card.
 *
 * Tudo aqui é puro e warning-only: o 4º post é fail-soft (#9568) e a decisão
 * final é do editor no gate. O invariante `use-melhor-um-isca` (Stage 4) é o
 * único consumidor de runtime.
 */

import { splitBodyAndTags } from "./social-cta-lines.ts";
import { splitUseMelhorParagraphs, useMelhorSlideBody } from "./use-melhor-carousel.ts";
import type { UseMelhorUmFormat } from "./use-melhor-post.ts";

/**
 * Data da edição no formato da chamada (`DD/MM`) a partir do id `AAMMDD`.
 * `null` quando o id não é uma data AAMMDD válida.
 */
export function editionCallDate(editionId: string): string | null {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(editionId.trim());
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[3]}/${m[2]}`;
}

/** Texto padrão da chamada (todas as redes). `null` se o id não for AAMMDD. */
export function useMelhorEditionCall(editionId: string): string | null {
  const date = editionCallDate(editionId);
  return date ? `O guia completo está na edição de ${date}.` : null;
}

/** Chamada datada: "na edição de 30/10" (dia/mês com 1 ou 2 dígitos). */
const DATED_CALL_RE = /\bna\s+edi[çc][ãa]o\s+de\s+(\d{1,2})\/(\d{1,2})\b/i;

/** Chamada relativa que envelhece ("edição de hoje", "edição do dia", "edição de amanhã"). */
const RELATIVE_CALL_RE = /\bedi[çc][ãa]o\s+(?:de\s+hoje|do\s+dia|de\s+amanh[ãa]|de\s+ontem)\b/i;

/** Contagem do que falta: "3 das 15", "5 dos 20", "faltam 12", "outras 12 dicas". */
const MISSING_COUNT_RES: RegExp[] = [
  /\b\d+\s+d[ao]s\s+\d+\b/i,
  /\bfalta(?:m)?\s+(?:mais\s+)?\d+\b/i,
  /\b(?:outr[ao]s|mais|restantes?)\s+\d+\s+(?:dicas|fun[çc][õo]es|ferramentas|truques|prompts|recursos|itens|passos|atalhos|comandos|ideias|usos|exemplos|formas|maneiras|jeitos)\b/i,
];

/** "15 funções", "10 dicas" — item que é lista (e o post sugere lista completa). */
const LIST_COUNT_RE =
  /\b\d+\s+(?:dicas|fun[çc][õo]es|ferramentas|truques|prompts|recursos|itens|atalhos|comandos|ideias|usos|exemplos|formas|maneiras|jeitos|segredos|h[áa]bitos|apps|aplicativos|sites|extens[õo]es)\b/i;

/** Promessa de lista inteira na edição (que só tem link + uma frase). */
const FULL_LIST_PROMISE_RE = /\b(?:lista\s+completa|tod[ao]s\s+[ao]s\s+\d+)\b/i;

function stripBold(s: string): string {
  return s.replace(/\*\*/g, "").trim();
}

export interface LintUseMelhorIscaOptions {
  /** Formato do `## um` (`useMelhorUmFormat`). A chamada é obrigatória só em `"prosa"`. */
  format: UseMelhorUmFormat;
  /** Id `AAMMDD` da edição; sem ele a data da chamada não é comparada. */
  editionId?: string | null;
}

/**
 * Pure (#11667): problemas do `## um` contra o padrão de isca. Lista vazia =
 * conforme. Mensagens curtas, em PT, prontas pro resumo do gate.
 */
export function lintUseMelhorIsca(genericText: string, opts: LintUseMelhorIscaOptions): string[] {
  const { body } = splitBodyAndTags(genericText);
  const flat = stripBold(body.replace(/\s+/g, " "));
  if (!flat) return [];
  const problems: string[] = [];

  const relative = RELATIVE_CALL_RE.exec(flat);
  if (relative) {
    problems.push(
      `chamada relativa "${relative[0]}" envelhece (o post é lido dias depois) — usar a data: "na edição de DD/MM"`,
    );
  }

  for (const re of MISSING_COUNT_RES) {
    const m = re.exec(flat);
    if (m) {
      problems.push(`diz quantos itens faltam ("${m[0]}") — a isca mostra uma parte e aponta para a edição, sem contar o resto`);
      break;
    }
  }

  const promise = FULL_LIST_PROMISE_RE.exec(flat);
  if (promise) {
    problems.push(
      `promete "${promise[0]}" — a edição traz só o link e uma frase do item; o post não pode prometer a lista inteira`,
    );
  }

  const dated = DATED_CALL_RE.exec(flat);
  if (dated) {
    const expected = opts.editionId ? editionCallDate(opts.editionId) : null;
    const found = `${dated[1].padStart(2, "0")}/${dated[2].padStart(2, "0")}`;
    if (expected && found !== expected) {
      problems.push(`chamada aponta para a edição de ${found}, mas esta edição é de ${expected}`);
    }
  }

  if (!dated) {
    const listCount = LIST_COUNT_RE.exec(flat);
    if (listCount) {
      problems.push(
        `cita "${listCount[0]}" sem apontar para a edição — fechar com a chamada datada ("na edição de DD/MM")`,
      );
    } else if (opts.format === "prosa") {
      problems.push(`sem a chamada datada no fim do 3º parágrafo ("O guia completo está na edição de DD/MM.")`);
    }
    return problems;
  }

  // Posição: no texto corrido, a chamada fecha o ÚLTIMO parágrafo e cai
  // sozinha no 2º bloco do slide (uma única frase antes dela).
  if (opts.format === "prosa") {
    const paras = splitUseMelhorParagraphs(body);
    const last = paras[paras.length - 1] ?? "";
    if (!DATED_CALL_RE.test(stripBold(last))) {
      problems.push(`a chamada datada precisa fechar o último parágrafo (o 3º), não ficar no meio do texto`);
    } else {
      const blocks = useMelhorSlideBody(last).split("\n\n");
      const tail = stripBold(blocks[blocks.length - 1] ?? "");
      if (blocks.length !== 2 || !DATED_CALL_RE.test(tail) || /[.!?]\s+\S/.test(tail)) {
        problems.push(
          `o último parágrafo precisa ter UMA única frase antes da chamada datada — senão o slide não separa a chamada num bloco próprio`,
        );
      }
    }
  }
  return problems;
}
