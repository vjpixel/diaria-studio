/**
 * clarice-chunk.ts (#2606) — chunking seguro para textos >10k chars enviados ao Clarice.
 *
 * O MCP `mcp__clarice__correct_text` e o REST endpoint têm limite ~10k chars/chamada.
 * Edições longas (newsletter completa ~15-25k chars) estouram sem chunking.
 *
 * Responsabilidades deste módulo:
 *   1. `splitIntoChunks`: dividir texto em fronteiras seguras (parágrafo / seção `---`),
 *      nunca no meio de frase ou link markdown.
 *   2. `applyChunkSuggestions`: aplicar sugestões de um chunk ao texto completo, com
 *      política de ambiguidade (pular sugestão se `from` aparece mais de 1× no chunk).
 *   3. `mergeChunkSuggestions`: mesclar aplicações de todos os chunks em sequência.
 *
 * IMPORTANTE: este módulo é PURO/determinístico — não chama o MCP nem rede.
 * O top-level orchestrator chama o MCP por chunk e usa estas funções para o remap.
 *
 * Divisão de responsabilidade:
 *   - Orchestrator: lê texto → splitIntoChunks → para cada chunk: chama MCP → chama
 *     applyChunkSuggestions com o fullText acumulado → continua com o texto atualizado.
 *   - Este módulo: split + apply + policy de ambiguidade (sem I/O, sem MCP).
 *
 * Threshold de ativação: CLARICE_CHUNK_THRESHOLD (default 9_000 chars).
 * Se o texto inteiro for ≤ threshold, retorna um único chunk (sem split).
 */

export interface TextChunk {
  /** Conteúdo do chunk, pronto para enviar ao Clarice. */
  text: string;
  /**
   * Offset (em chars) deste chunk no texto original.
   * Usado para encontrar a região correta ao aplicar sugestões.
   */
  startOffset: number;
}

export interface ClariceChunkSuggestion {
  from: string;
  to: string;
  rule?: string;
  explanation?: string;
}

export interface ApplyResult {
  /** Texto completo com as sugestões deste chunk aplicadas. */
  text: string;
  /** Sugestões que foram aplicadas com sucesso. */
  applied: ClariceChunkSuggestion[];
  /** Sugestões puladas (com motivo). */
  skipped: Array<ClariceChunkSuggestion & { reason: string }>;
}

/** Threshold padrão de chars para ativar chunking. */
export const CLARICE_CHUNK_THRESHOLD = 9_000;

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
 * Aplica sugestões do Clarice (de um chunk) ao texto completo.
 *
 * Política de ambiguidade (fix #2606):
 *   - Uma sugestão `{from, to}` é aplicada somente se `from` aparece EXATAMENTE
 *     1× no chunk.text (região do texto enviada ao Clarice).
 *   - Se `from` aparece 0× no chunk: skip ("from não encontrado no chunk").
 *   - Se `from` aparece 2+× no chunk: skip ("âncora ambígua — from aparece N× no chunk").
 *   - Isso evita substituições globais indesejadas (ex: `"os"→""` aplicado em todo o texto).
 *
 * Aplicação é feita no fullText, mas restrita à região [chunk.startOffset, chunk.startOffset +
 * chunk.text.length] — a busca de `from` acontece no texto completo dentro dessa região.
 *
 * @param fullText Texto completo atual (pode já ter sugestões anteriores aplicadas)
 * @param chunk O chunk original enviado ao Clarice (com startOffset no texto original)
 * @param suggestions Sugestões retornadas pelo Clarice para este chunk
 * @param log Função de log para sugestões puladas (default: console.warn)
 */
export function applyChunkSuggestions(
  fullText: string,
  chunk: TextChunk,
  suggestions: ClariceChunkSuggestion[],
  log: (msg: string) => void = (msg) => console.warn(msg),
): ApplyResult {
  const applied: ClariceChunkSuggestion[] = [];
  const skipped: Array<ClariceChunkSuggestion & { reason: string }> = [];
  let currentText = fullText;

  for (const suggestion of suggestions) {
    const { from, to } = suggestion;

    if (!from || from === to) {
      // Sugestão no-op ou vazia — pular silenciosamente
      skipped.push({ ...suggestion, reason: "sugestão vazia ou no-op" });
      continue;
    }

    // Verificar ocorrências no chunk original (não no fullText completo)
    // para determinar se a sugestão é ambígua.
    const occurrencesInChunk = countOccurrences(chunk.text, from);

    if (occurrencesInChunk === 0) {
      const reason = `"from" não encontrado no chunk (offset ${chunk.startOffset})`;
      log(`[clarice-chunk] SKIP: ${JSON.stringify(from)} → não encontrado no chunk. ${reason}`);
      skipped.push({ ...suggestion, reason });
      continue;
    }

    if (occurrencesInChunk > 1) {
      const reason = `âncora ambígua — "${from}" aparece ${occurrencesInChunk}× no chunk (pular para evitar replace global)`;
      log(`[clarice-chunk] SKIP: ${JSON.stringify(from)} → ${reason}`);
      skipped.push({ ...suggestion, reason });
      continue;
    }

    // Exatamente 1 ocorrência no chunk — aplicar no fullText.
    // A substituição deve ser feita apenas na região do chunk dentro do fullText.
    // Como o fullText pode ter sido modificado por chunks anteriores (offsets podem
    // ter mudado), procurar `from` no fullText todo mas verificar que encontra exatamente 1×.
    const occurrencesInFull = countOccurrences(currentText, from);

    if (occurrencesInFull === 0) {
      const reason = `"from" não encontrado no texto completo (pode ter sido removido por sugestão anterior)`;
      log(`[clarice-chunk] SKIP: ${JSON.stringify(from)} → ${reason}`);
      skipped.push({ ...suggestion, reason });
      continue;
    }

    if (occurrencesInFull > 1) {
      // Tentar restringir ao segmento do chunk no fullText atual.
      // Usar um slice aproximado baseado no startOffset (pode ter drift por edições anteriores).
      const regionStart = Math.max(0, chunk.startOffset - 50); // pequena margem
      const regionEnd = Math.min(currentText.length, chunk.startOffset + chunk.text.length + 50);
      const region = currentText.slice(regionStart, regionEnd);
      const occurrencesInRegion = countOccurrences(region, from);

      if (occurrencesInRegion !== 1) {
        const reason = `âncora ambígua — "${from}" aparece ${occurrencesInFull}× no texto completo e ${occurrencesInRegion}× na região do chunk`;
        log(`[clarice-chunk] SKIP: ${JSON.stringify(from)} → ${reason}`);
        skipped.push({ ...suggestion, reason });
        continue;
      }

      // Exatamente 1 na região — substituir apenas essa ocorrência
      const regionUpdated = region.replace(from, to);
      currentText = currentText.slice(0, regionStart) + regionUpdated + currentText.slice(regionEnd);
      applied.push(suggestion);
      continue;
    }

    // Exatamente 1 no fullText — substituição segura e direta
    currentText = currentText.replace(from, to);
    applied.push(suggestion);
  }

  return { text: currentText, applied, skipped };
}

/**
 * Mescla a aplicação de sugestões de múltiplos chunks em sequência.
 * Chama `applyChunkSuggestions` para cada chunk, passando o texto acumulado.
 *
 * @param fullText Texto original completo
 * @param chunkSuggestions Array de [chunk, suggestions] na mesma ordem de `splitIntoChunks`
 * @param log Função de log (default: console.warn)
 */
export function mergeChunkSuggestions(
  fullText: string,
  chunkSuggestions: Array<{ chunk: TextChunk; suggestions: ClariceChunkSuggestion[] }>,
  log: (msg: string) => void = (msg) => console.warn(msg),
): ApplyResult {
  let currentText = fullText;
  const allApplied: ClariceChunkSuggestion[] = [];
  const allSkipped: Array<ClariceChunkSuggestion & { reason: string }> = [];

  for (const { chunk, suggestions } of chunkSuggestions) {
    const result = applyChunkSuggestions(currentText, chunk, suggestions, log);
    currentText = result.text;
    allApplied.push(...result.applied);
    allSkipped.push(...result.skipped);
  }

  return { text: currentText, applied: allApplied, skipped: allSkipped };
}

// --- helpers internos ---

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

/**
 * Encontra a última posição de corte em linha `---` dentro de `text[minCut..]`.
 * Retorna o índice imediatamente após a linha `---\n` (início do próximo bloco).
 * Retorna -1 se não encontrado.
 */
function findLastSectionBoundary(text: string, minCut: number): number {
  // Procura `\n---\n` ou `\n---` no final — separador de seção editorial.
  const pattern = /\n---\n/g;
  let lastMatch = -1;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const cutPos = m.index + m[0].length;
    if (cutPos >= minCut) {
      lastMatch = cutPos;
    }
  }
  return lastMatch;
}

/**
 * Encontra a última posição de corte em parágrafo vazio (`\n\n`) dentro de `text[minCut..]`.
 * Retorna o índice após os `\n\n`.
 * Retorna -1 se não encontrado.
 */
function findLastParagraphBoundary(text: string, minCut: number): number {
  const pattern = /\n\n/g;
  let lastMatch = -1;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const cutPos = m.index + m[0].length;
    if (cutPos >= minCut) {
      lastMatch = cutPos;
    }
  }
  return lastMatch;
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
