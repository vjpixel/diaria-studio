/**
 * clarice-chunk.ts (#2606) — chunking seguro para textos >10k chars enviados ao Clarice.
 *
 * O MCP `mcp__clarice__correct_text` e o REST endpoint têm limite ~10k chars/chamada.
 * Edições longas (newsletter completa ~15-25k chars) estouram sem chunking.
 *
 * Responsabilidades deste módulo:
 *   1. `splitIntoChunks`: dividir texto em fronteiras seguras (parágrafo / seção `---`),
 *      nunca no meio de frase ou link markdown.
 *   2. `applyChunkSuggestions`: aplicar sugestões de UM chunk ao texto DESSE chunk
 *      (chunk-local), com política de ambiguidade (pular sugestão se `from` aparece
 *      ≠ 1× no chunk).
 *   3. `mergeChunkSuggestions`: aplicar cada chunk localmente e concatenar de volta.
 *
 * IMPORTANTE: este módulo é PURO/determinístico — não chama o MCP nem rede.
 * O top-level orchestrator chama o MCP por chunk e usa estas funções para o apply.
 *
 * Divisão de responsabilidade:
 *   - Orchestrator: lê texto → splitIntoChunks → para cada chunk: chama MCP com
 *     `chunk.text` → junta `{chunk, suggestions}` → chama `mergeChunkSuggestions`.
 *   - Este módulo: split + apply chunk-local + policy de ambiguidade (sem I/O, sem MCP).
 *
 * Design chunk-local (sem aritmética de offset): como `splitIntoChunks` garante que a
 * concatenação dos chunks reconstrói o texto original, aplicar as sugestões de cada chunk
 * ao próprio `chunk.text` e re-concatenar produz o texto corrigido — sem precisar remapear
 * offsets no texto completo (que sofreria drift conforme sugestões mudam o tamanho do texto).
 * Cada sugestão do Clarice tem `from` contido em um único chunk (o chunk que o Clarice viu),
 * então a aplicação local é sempre bem-definida.
 *
 * Threshold de ativação: CLARICE_CHUNK_THRESHOLD (default 9_000 chars).
 * Se o texto inteiro for ≤ threshold, retorna um único chunk (sem split).
 */

import { countOccurrences } from "../clarice-apply.ts";
import type { ClariceSuggestion } from "./schemas/clarice-suggestions.ts";

export interface TextChunk {
  /** Conteúdo do chunk, pronto para enviar ao Clarice. */
  text: string;
  /**
   * Offset (em chars) deste chunk no texto original. Informativo/auditoria — o apply
   * chunk-local não depende dele (a concatenação dos chunks reconstrói o original).
   */
  startOffset: number;
}

/**
 * Alias de `ClariceSuggestion` (#2701 item 2 do self-review #2700) — antes este
 * módulo declarava uma interface própria estruturalmente idêntica ao schema Zod
 * de `clarice-suggestions.ts`, forçando `scripts/clarice-correct.ts` a fazer
 * `as ClariceChunkSuggestion[]` unsafe cast no array já validado retornado por
 * `correctTextViaREST`. Com o alias, os dois tipos são literalmente o mesmo tipo
 * e a atribuição não precisa de cast.
 */
export type ClariceChunkSuggestion = ClariceSuggestion;

export interface ApplyResult {
  /** Texto completo com as sugestões deste chunk aplicadas. */
  text: string;
  /** Sugestões que foram aplicadas com sucesso. */
  applied: ClariceChunkSuggestion[];
  /** Sugestões puladas (com motivo). */
  skipped: Array<ClariceChunkSuggestion & { reason: string }>;
}

/**
 * Threshold padrão de chars para ativar chunking.
 * #2798: baixado de 9.000 → 4.500 — o cortex.clarice.ai dá timeout consistente
 * (`rest_exit3_timeout`) em textos >5k, então seções secundárias de 5–9k ficavam
 * ABAIXO do threshold antigo (enviadas inteiras num request) e estouravam as 3
 * tentativas. Com 4.500, qualquer seção >4.5k é dividida em chunks menores que o
 * endpoint processa dentro do timeout. Reincidiu (#2320 fechado como one-off,
 * reapareceu em 260702) — a causa era tamanho de request, não flakiness pura.
 */
export const CLARICE_CHUNK_THRESHOLD = 4_500;

/**
 * Divide o texto em chunks de no máximo `maxChars` chars, em fronteiras seguras:
 * - Prioridade 1: linha separadora `---` (seção editorial)
 * - Prioridade 2: parágrafo vazio (linha em branco entre parágrafos)
 * - Nunca divide no meio de uma linha (garante que links markdown não quebram)
 *
 * Se o texto inteiro couber em `maxChars`, retorna um único chunk.
 *
 * @param text Texto completo a dividir
 * @param maxChars Limite máximo de chars por chunk (default: CLARICE_CHUNK_THRESHOLD)
 */
export function splitIntoChunks(text: string, maxChars = CLARICE_CHUNK_THRESHOLD): TextChunk[] {
  if (text.length <= maxChars) {
    return [{ text, startOffset: 0 }];
  }

  const chunks: TextChunk[] = [];
  let remaining = text;
  let globalOffset = 0;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push({ text: remaining, startOffset: globalOffset });
      break;
    }

    // Encontrar a melhor fronteira dentro de [maxChars/2, maxChars]
    // (não queremos chunks muito pequenos — mínimo de metade do limite).
    const window = remaining.slice(0, maxChars);
    const minCut = Math.floor(maxChars / 2);

    // Tentar cortar em separador de seção `---` (prioridade 1)
    const sectionCut = findLastSectionBoundary(window, minCut);
    if (sectionCut !== -1) {
      const chunk = remaining.slice(0, sectionCut);
      chunks.push({ text: chunk, startOffset: globalOffset });
      globalOffset += sectionCut;
      remaining = remaining.slice(sectionCut);
      continue;
    }

    // Tentar cortar em parágrafo vazio (prioridade 2)
    const paragraphCut = findLastParagraphBoundary(window, minCut);
    if (paragraphCut !== -1) {
      const chunk = remaining.slice(0, paragraphCut);
      chunks.push({ text: chunk, startOffset: globalOffset });
      globalOffset += paragraphCut;
      remaining = remaining.slice(paragraphCut);
      continue;
    }

    // Fallback: cortar no final da última linha completa dentro do limite
    const lineCut = findLastLineBoundary(window, minCut);
    if (lineCut !== -1) {
      const chunk = remaining.slice(0, lineCut);
      chunks.push({ text: chunk, startOffset: globalOffset });
      globalOffset += lineCut;
      remaining = remaining.slice(lineCut);
      continue;
    }

    // Último fallback: cortar em maxChars (não deveria ocorrer com texto normal)
    chunks.push({ text: remaining.slice(0, maxChars), startOffset: globalOffset });
    globalOffset += maxChars;
    remaining = remaining.slice(maxChars);
  }

  return chunks;
}

/**
 * Aplica as sugestões do Clarice ao texto de UM chunk (chunk-local).
 *
 * Política de ambiguidade (fix #2606):
 *   - Uma sugestão `{from, to}` é aplicada somente se `from` aparece EXATAMENTE
 *     1× no estado ATUAL do texto do chunk (após sugestões anteriores do mesmo chunk).
 *   - Se `from` aparece 0× no chunk: skip ("from não encontrado").
 *   - Se `from` aparece 2+× no chunk: skip ("âncora ambígua").
 *   - Isso evita substituições globais indesejadas (ex: `"os"→""` aplicado em todo o texto).
 *
 * A aplicação é feita SOMENTE no `chunk.text` — não no texto completo. Isso elimina
 * aritmética de offset (e o drift que ela sofreria quando sugestões mudam o tamanho do
 * texto). `mergeChunkSuggestions` re-concatena os chunks corrigidos para formar o resultado.
 *
 * Substituição via FORMA-FUNÇÃO `replace(from, () => to)` — evita que `$&`, `$'`, `` $` ``,
 * `$1` etc. em `to` sejam interpretados como padrões de backreference pelo `String.replace`
 * (mesma proteção de `clarice-apply.ts`).
 *
 * @param chunk O chunk enviado ao Clarice
 * @param suggestions Sugestões retornadas pelo Clarice para este chunk
 * @param log Função de log para sugestões puladas (default: console.warn)
 * @returns ApplyResult com `text` = texto corrigido DESTE chunk
 */
export function applyChunkSuggestions(
  chunk: TextChunk,
  suggestions: ClariceChunkSuggestion[],
  log: (msg: string) => void = (msg) => console.warn(msg),
): ApplyResult {
  const applied: ClariceChunkSuggestion[] = [];
  const skipped: Array<ClariceChunkSuggestion & { reason: string }> = [];
  let text = chunk.text;

  for (const suggestion of suggestions) {
    const { from, to } = suggestion;

    // Guarda whitespace-only além de vazio (paridade com clarice-apply.ts).
    if (!from || !from.trim() || from === to) {
      skipped.push({ ...suggestion, reason: "sugestão vazia ou no-op" });
      continue;
    }

    // Avaliar contra o estado ATUAL do texto do chunk (já com applies anteriores deste
    // chunk). Igual à semântica de clarice-apply.ts — "manter"→"manter a" pode tornar
    // uma sugestão subsequente unique ou ambiguous.
    const count = countOccurrences(text, from);

    if (count === 0) {
      const reason = `"from" não encontrado no chunk (offset ${chunk.startOffset})`;
      log(`[clarice-chunk] SKIP: ${JSON.stringify(from)} → ${reason}`);
      skipped.push({ ...suggestion, reason });
      continue;
    }

    if (count > 1) {
      const reason = `âncora ambígua — "${from}" aparece ${count}× no chunk (pular para evitar replace global)`;
      log(`[clarice-chunk] SKIP: ${JSON.stringify(from)} → ${reason}`);
      skipped.push({ ...suggestion, reason });
      continue;
    }

    // Exatamente 1 ocorrência — substituição segura. Forma-função evita interpretação
    // de $ patterns em `to`.
    text = text.replace(from, () => to);
    applied.push(suggestion);
  }

  return { text, applied, skipped };
}

/**
 * Aplica as sugestões de cada chunk localmente e re-concatena para formar o texto completo
 * corrigido. Como `splitIntoChunks` garante que `chunks.map(c => c.text).join("") === texto
 * original`, concatenar os chunks corrigidos produz o texto final correto — sem aritmética
 * de offset.
 *
 * @param chunkSuggestions Array de `{chunk, suggestions}` na ordem de `splitIntoChunks`
 * @param log Função de log (default: console.warn)
 */
export function mergeChunkSuggestions(
  chunkSuggestions: Array<{ chunk: TextChunk; suggestions: ClariceChunkSuggestion[] }>,
  log: (msg: string) => void = (msg) => console.warn(msg),
): ApplyResult {
  const parts: string[] = [];
  const allApplied: ClariceChunkSuggestion[] = [];
  const allSkipped: Array<ClariceChunkSuggestion & { reason: string }> = [];

  for (const { chunk, suggestions } of chunkSuggestions) {
    const result = applyChunkSuggestions(chunk, suggestions, log);
    parts.push(result.text);
    allApplied.push(...result.applied);
    allSkipped.push(...result.skipped);
  }

  return { text: parts.join(""), applied: allApplied, skipped: allSkipped };
}

/**
 * Núcleo compartilhado: encontra a última posição de corte para `re` dentro de
 * `text`, considerando apenas posições ≥ `minCut`. Retorna -1 se não encontrado.
 * `re` deve ter a flag `g` e ser criado em cada chamada (regex stateful via exec).
 *
 * #2705: sem a flag `g`, `RegExp.prototype.exec` nunca avança `lastIndex` — o
 * `while` abaixo receberia sempre o mesmo primeiro match e travaria em loop
 * infinito. Os 2 callers atuais (`findLastSectionBoundary`, `findLastParagraphBoundary`)
 * sempre passam um regex `/g` literal fresco, mas a assinatura aceita qualquer
 * `RegExp` sem enforcement — um erro de caller aqui travaria silenciosamente em
 * vez de falhar. Fail loud: documenta o contrato explicitamente em vez de
 * "consertar" silenciosamente o input (ex: recriando o regex com `g`).
 */
export function findLastBoundary(text: string, re: RegExp, minCut: number): number {
  if (!re.global) {
    throw new Error("findLastBoundary requer regex com flag g");
  }
  let lastMatch = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const cutPos = m.index + m[0].length;
    if (cutPos >= minCut) {
      lastMatch = cutPos;
    }
  }
  return lastMatch;
}

/**
 * Encontra a última posição de corte em linha `---` dentro de `text[minCut..]`.
 * Retorna o índice imediatamente após a linha `---\n` (início do próximo bloco).
 * Retorna -1 se não encontrado.
 */
function findLastSectionBoundary(text: string, minCut: number): number {
  // Procura `\n---\n` — separador de seção editorial.
  return findLastBoundary(text, /\n---\n/g, minCut);
}

/**
 * Encontra a última posição de corte em parágrafo vazio (`\n\n`) dentro de `text[minCut..]`.
 * Retorna o índice após os `\n\n`.
 * Retorna -1 se não encontrado.
 */
function findLastParagraphBoundary(text: string, minCut: number): number {
  return findLastBoundary(text, /\n\n/g, minCut);
}

/**
 * Encontra a última posição de fim de linha (`\n`) dentro de `text[minCut..]`.
 * Garante que não cortamos no meio de uma linha.
 * Retorna -1 se não encontrado.
 */
function findLastLineBoundary(text: string, minCut: number): number {
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline >= minCut) return lastNewline + 1;
  return -1;
}
