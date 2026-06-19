/**
 * lint-checks/use-melhor-tempo.ts (#2372)
 *
 * Verifica que cada item da seção USE MELHOR inclui estimativa de tempo de
 * leitura na linha de descrição. Aceita os dois formatos editoriais usados em
 * produção:
 *   - parênteses (formato canônico do writer.md): `(15 min)`, `(30 min)`
 *   - em/en dash (atalho aprovado 260612):         `— 5 min`, `– 8 min de leitura`
 *
 * Check BLOQUEANTE — forçar inclusão do tempo, padrão editorial desde 260612.
 * Roda no Stage 4 (PÓS-gate, via STAGE_4_RULES) — NÃO no Stage 2 pré-gate: o
 * `stitch-newsletter.ts` renderiza a descrição a partir do `summary` (sem tempo),
 * e é o editor quem adiciona "(N min)" ao curar a seção USE MELHOR no gate.
 * Também exposto via CLI `--check use-melhor-tempo` (exit 1) p/ writer fallback.
 *
 * Regex: `/(\(\s*\d+\s*min\b|[–—]\s*\d+\s*min\b)/` na linha de descrição.
 *
 * Estrutura esperada de item USE MELHOR (uma das formas aceitas):
 *   **[Título](URL)**
 *   Descrição em 1 frase plain text (15 min)
 *   ou
 *   Descrição em 1 frase plain text — 15 min
 *
 * Algoritmo:
 *   1. Detectar início da seção USE MELHOR (header regex).
 *   2. Para cada inline-link-only line (title line do item), olhar a próxima
 *      linha não-vazia como a linha de descrição.
 *   3. Verificar que a descrição contém a estimativa de tempo.
 *   4. Acumular erros; retornar { ok, errors[], checked }.
 */

import { sectionHeaderRegex } from "../section-naming.ts";
import { INLINE_LINK_ONLY_RE } from "./section-item-format.ts";

/** Regex que casa o header da seção USE MELHOR (com ou sem emoji, com ou sem bold). */
const USE_MELHOR_HEADER_RE = sectionHeaderRegex(String.raw`USE\s+MELHOR`, {
  capture: "none",
  flags: "u",
});

/**
 * Padrão de estimativa de tempo. Aceita os dois formatos de produção:
 *   - `(15 min)` — parênteses, formato canônico documentado em writer.md:106
 *   - `— 5 min` / `– 8 min de leitura` — em/en dash, atalho aprovado 260612
 *
 * Casa: "(15 min)", "(30 min)", "— 5 min", "– 8 min de leitura", "—5min", "(2 min de leitura)"
 * Não casa: "- 5 min" (hyphen sem parênteses), descrição sem estimativa, "(min)" sem número.
 */
export const USE_MELHOR_TEMPO_RE = /(\(\s*\d+\s*min\b|[–—]\s*\d+\s*min\b)/;

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
        // nextNonEmpty é garantidamente não-vazio: o while-loop acima pula
        // linhas em branco e o guard `j >= lines.length` trata o caso EOF.
        const nextNonEmpty = descLine.trim();

        // Se a próxima linha é outro link, header ou separador → sem descrição
        if (
          INLINE_LINK_ONLY_RE.test(descLine) ||
          nextNonEmpty === "---" ||
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
