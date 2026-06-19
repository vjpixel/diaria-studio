/**
 * lint-checks/use-melhor-tempo.ts (#2372)
 *
 * Verifica que cada item da seção USE MELHOR inclui estimativa de tempo de
 * leitura na linha de descrição, no formato `— N min` (em dash + número +
 * "min", com variantes: "— 5 min", "— 8 min de leitura", "— 15 min").
 *
 * Check BLOQUEANTE (igual a `destaque-min-chars`) — forçar inclusão do tempo
 * antes do gate humano, pois é padrão editorial desde 260612.
 *
 * Regex: /—\s*\d+\s*min/ na linha de descrição de cada item.
 *
 * Estrutura esperada de item USE MELHOR (uma das formas aceitas):
 *   **[Título](URL)**
 *   Descrição em 1 frase plain text — X min
 *
 * Algoritmo:
 *   1. Detectar início da seção USE MELHOR (header regex).
 *   2. Para cada inline-link-only line (title line do item), olhar a próxima
 *      linha não-vazia como a linha de descrição.
 *   3. Verificar que a descrição contém /—\s*\d+\s*min/.
 *   4. Acumular erros; retornar { ok, errors[], checked }.
 */

import { sectionHeaderRegex } from "../section-naming.ts";

/** Regex que casa o header da seção USE MELHOR (com ou sem emoji, com ou sem bold). */
const USE_MELHOR_HEADER_RE = sectionHeaderRegex(String.raw`USE\s+MELHOR`, {
  capture: "none",
  flags: "u",
});

/** Linha com um inline link bem-formado (título do item — com ou sem bold). */
const INLINE_LINK_ONLY_RE =
  /^\s*\*{0,2}\s*\[[^\]]+\]\(https?:\/\/[^\s)]+\)\s*\*{0,2}\s*$/;

/**
 * Padrão de tempo de leitura: `— N min` (en dash ou em dash, espaços opcionais,
 * número inteiro, "min" com texto opcional a seguir).
 *
 * Casa: "— 5 min", "— 8 min de leitura", "— 15 min.", "—5min"
 * Não casa: "- 5 min" (hyphen — intencionalmente rejeitado; padrão é em dash)
 */
export const USE_MELHOR_TEMPO_RE = /[–—]\s*\d+\s*min/;

export interface UseMelhorTempoError {
  /** Número sequencial do item na seção (1-based). */
  item: number;
  /** Linha de título (1-based). */
  titleLine: number;
  /** Linha de descrição (1-based), ou -1 se não encontrada. */
  descLine: number;
  /** Trecho da linha de descrição (até 80 chars), ou "(sem descrição)". */
  excerpt: string;
}

export interface UseMelhorTempoReport {
  ok: boolean;
  errors: UseMelhorTempoError[];
  /** Total de itens USE MELHOR verificados. */
  checked: number;
}

/**
 * #2372: Verifica que cada item da seção USE MELHOR inclui estimativa de tempo
 * (`— N min`) na linha de descrição. Retorna erros para os itens que não têm.
 */
export function checkUseMelhorTempo(md: string): UseMelhorTempoReport {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const errors: UseMelhorTempoError[] = [];
  let inUseMelhor = false;
  let itemNum = 0;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();

    // Detectar início da seção USE MELHOR
    if (USE_MELHOR_HEADER_RE.test(t)) {
      inUseMelhor = true;
      itemNum = 0;
      continue;
    }

    // Fim da seção: `---` separator ou novo header de seção
    if (inUseMelhor) {
      if (t === "---") {
        inUseMelhor = false;
        continue;
      }
      // Novo header (qualquer linha **BOLD** que não é um inline-link)
      if (t.startsWith("**") && !INLINE_LINK_ONLY_RE.test(lines[i])) {
        // Se parece outro header de seção, sair
        // (sectionHeaderRegex já cobre isso no caller, mas defensivamente)
        inUseMelhor = false;
        continue;
      }

      // Linha de título de item (inline link)
      if (INLINE_LINK_ONLY_RE.test(lines[i])) {
        itemNum++;
        const titleLineNum = i + 1;

        // Encontrar próxima linha não-vazia como descrição
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === "") j++;

        if (j >= lines.length) {
          // Sem descrição
          errors.push({
            item: itemNum,
            titleLine: titleLineNum,
            descLine: -1,
            excerpt: "(sem descrição)",
          });
          continue;
        }

        const descLine = lines[j];
        const descLineNum = j + 1;
        const nextNonEmpty = descLine.trim();

        // Se a próxima linha é outro link, header ou separador → sem descrição
        if (
          INLINE_LINK_ONLY_RE.test(descLine) ||
          nextNonEmpty === "---" ||
          nextNonEmpty === "" ||
          // Outro header bold (seção, destaque)
          (/^\*\*[A-ZÁÀÂÃÉÈÊÍÏÓÔÕÚÜÇ]/.test(nextNonEmpty) &&
            !INLINE_LINK_ONLY_RE.test(descLine))
        ) {
          errors.push({
            item: itemNum,
            titleLine: titleLineNum,
            descLine: descLineNum,
            excerpt: "(sem descrição)",
          });
          continue;
        }

        // Verificar presença de `— N min`
        if (!USE_MELHOR_TEMPO_RE.test(descLine)) {
          errors.push({
            item: itemNum,
            titleLine: titleLineNum,
            descLine: descLineNum,
            excerpt: descLine.trim().slice(0, 80),
          });
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, checked: itemNum };
}
