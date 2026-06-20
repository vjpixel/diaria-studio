/**
 * lint-checks/use-melhor-tempo.ts (#2372)
 *
 * Verifica que cada item da seção USE MELHOR inclui estimativa de tempo de
 * leitura. Aceita os dois formatos editoriais usados em produção:
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
 * Formatos aceitos de item USE MELHOR (ambos suportados):
 *
 *   Formato canônico de produção (mesma linha — validado em 260615–260619):
 *     **[Título](URL)** Descrição em 1 frase plain text (15 min)
 *
 *   Formato legado de 2 linhas (ainda suportado para compat):
 *     **[Título](URL)**
 *     Descrição em 1 frase plain text (15 min)
 *
 * Algoritmo (#2396 — fix do no-op no formato real):
 *   1. Detectar início da seção USE MELHOR (header regex).
 *   2a. Linha com link + descrição inline (formato canônico produção):
 *       extrair o texto após o link e checar presença de tempo nele.
 *   2b. Linha com link sozinho (formato legado 2 linhas):
 *       olhar a próxima linha não-vazia como a linha de descrição e checar.
 *   3. Encerrar a seção em `---` OU em qualquer header de seção seguinte
 *      (cobre input malformado sem `---`, evitando section-bleed).
 *   4. Acumular erros; retornar { ok, errors[], checked }.
 */

import { sectionHeaderRegex, ALL_SECTION_NAMES_PATTERN } from "../section-naming.ts";
import { INLINE_LINK_ONLY_RE } from "./section-item-format.ts";

/** Regex que casa o header da seção USE MELHOR (com ou sem emoji, com ou sem bold). */
const USE_MELHOR_HEADER_RE = sectionHeaderRegex(String.raw`USE\s+MELHOR`, {
  capture: "none",
  flags: "u",
});

/**
 * Regex que casa QUALQUER header de seção (LANÇAMENTOS, RADAR, VÍDEOS, etc.).
 * Usado para encerrar o scan da seção USE MELHOR ao bater no próximo header,
 * mesmo quando o `---` separador está ausente (input malformado).
 *
 * Substitui o guard removido `t.startsWith("**") && !INLINE_LINK_ONLY_RE` que
 * encerrava em QUALQUER linha bold — esse guard tinha FP em descrições com
 * bold-leading (`**OpenAI** lança...`). Este só casa nomes de seção canônicos,
 * então não confunde uma descrição bold com um header (#2396 finding section-bleed).
 */
const ANY_SECTION_HEADER_RE = sectionHeaderRegex(ALL_SECTION_NAMES_PATTERN, {
  capture: "none",
  flags: "u",
});

/**
 * Padrão de estimativa de tempo. Aceita os formatos usados em produção real
 * (validado em 260615–260619):
 *   - `(15 min)` — parênteses, formato canônico documentado em writer.md:106
 *   - `(~15 min)` — parênteses com tilde aproximado (260616)
 *   - `— 5 min` / `– 8 min de leitura` — em/en dash, atalho aprovado 260612
 *   - `~10 min` / `~40 min` inline — tilde sem parênteses (260617, 260618)
 *
 * Casa: "(15 min)", "(~30 min)", "— 5 min", "– 8 min de leitura", "—5min",
 *        "(2 min de leitura)", "~10 min", "~40 min"
 * Não casa: "- 5 min" (hyphen sem parênteses), descrição sem estimativa, "(min)" sem número,
 *            "Módulos curtos, no seu ritmo." (sem nenhuma estimativa).
 */
export const USE_MELHOR_TEMPO_RE =
  /(\(\s*~?\s*\d+\s*min\b|[–—]\s*~?\s*\d+\s*min\b|~\s*\d+\s*min\b)/;

/**
 * Sub-pattern de URL que tolera UM nível de parênteses balanceados no path —
 * ex: `https://en.wikipedia.org/wiki/GPT-4_(model)`. Sem isso, `[^\s)]+` para
 * no primeiro `)` e a linha inteira falha o match → item silenciosamente
 * pulado (mesma classe de no-op de #2396). URLs de Wikipedia/MDN com `(...)`
 * no slug são comuns na curadoria de USE MELHOR.
 */
const URL_WITH_BALANCED_PARENS = String.raw`https?:\/\/[^\s)]*(?:\([^\s)]*\)[^\s)]*)*`;

/**
 * Formato CANÔNICO de produção (#2396): link **bold** seguido de descrição inline
 * na mesma linha. Ex: `**[Título](URL)** Descrição... (5 min)`
 *
 * Casa: `**[Foo](https://x.com)** Desc...`
 * Não casa: `**[Foo](https://x.com)**` (sem texto após — isso é INLINE_LINK_ONLY_RE)
 *
 * Grupo de captura 1: texto da descrição (tudo após o link bold).
 */
const INLINE_LINK_WITH_DESC_RE = new RegExp(
  String.raw`^\s*\*{0,2}\s*\[[^\]]+\]\(${URL_WITH_BALANCED_PARENS}\)\*{0,2}\s+(\S.*)$`,
);

export interface UseMelhorTempoError {
  /** Número sequencial do item na seção (1-based). */
  item: number;
  /** Número de linha do item (título ou linha combinada), 1-based. */
  titleLine: number;
  /** Linha de descrição (1-based), ou -1 se não encontrada (formato 2-linhas). */
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
 * #2372/#2396: Verifica que cada item da seção USE MELHOR inclui estimativa de
 * tempo (`(N min)` ou `— N min`) na descrição. Retorna erros para os itens que
 * não têm.
 *
 * Suporta o formato CANÔNICO de produção (link+descrição na mesma linha) e o
 * formato legado de 2 linhas (título em linha, descrição na seguinte).
 */
export function checkUseMelhorTempo(md: string): UseMelhorTempoReport {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const errors: UseMelhorTempoError[] = [];
  let inUseMelhor = false;
  let itemNum = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();

    // Detectar início da seção USE MELHOR
    if (USE_MELHOR_HEADER_RE.test(t)) {
      inUseMelhor = true;
      itemNum = 0;
      continue;
    }

    if (!inUseMelhor) continue;

    // Fim da seção: `---` separator OU próximo header de seção (#2396).
    // O check de header cobre input malformado sem `---` entre seções — sem
    // ele, itens de LANÇAMENTOS/RADAR vazariam para a contagem de USE MELHOR.
    if (t === "---" || ANY_SECTION_HEADER_RE.test(t)) {
      inUseMelhor = false;
      continue;
    }

    // Formato CANÔNICO de produção (#2396): link + descrição na MESMA linha
    // Ex: `**[Título](URL)** Descrição... (5 min)`
    // Verificado em 260615–260619: este é o formato real de 100% das edições.
    const inlineMatch = INLINE_LINK_WITH_DESC_RE.exec(raw);
    if (inlineMatch) {
      itemNum++;
      const desc = inlineMatch[1]; // texto após o link bold
      if (!USE_MELHOR_TEMPO_RE.test(desc)) {
        errors.push({
          item: itemNum,
          titleLine: i + 1,
          descLine: i + 1, // mesma linha
          excerpt: desc.slice(0, 80),
        });
      }
      continue;
    }

    // Formato LEGADO de 2 linhas: título (link sozinho) numa linha,
    // descrição na próxima linha não-vazia.
    if (INLINE_LINK_ONLY_RE.test(raw)) {
      itemNum++;
      const titleLineNum = i + 1;

      // Encontrar próxima linha não-vazia como descrição
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;

      if (j >= lines.length) {
        // EOF sem descrição
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

      // Se a próxima linha é outro link (novo item), separador, ou header de
      // seção → sem descrição. O check de section header (#2413 finding #10)
      // cobre input malformado sem `---` entre USE MELHOR e a próxima seção:
      // sem ele, o header "**🚀 LANÇAMENTOS**" seria tratado como descrição e
      // checar a ausência de tempo no texto do header (diagnostic confuso).
      if (
        INLINE_LINK_ONLY_RE.test(descLine) ||
        INLINE_LINK_WITH_DESC_RE.test(descLine) ||
        nextNonEmpty === "---" ||
        ANY_SECTION_HEADER_RE.test(nextNonEmpty)
      ) {
        errors.push({
          item: itemNum,
          titleLine: titleLineNum,
          descLine: descLineNum,
          excerpt: "(sem descrição)",
        });
        continue;
      }

      // FP fix (#2396 finding #2): descrição que começa com bold (`**OpenAI** lança...`)
      // NÃO deve ser tratada como header de seção. A verificação anterior usava
      // `/^\*\*[A-ZÁÀÂÃÉÈÊÍÏÓÔÕÚÜÇ]/` que casava bold-leading legítimo. Agora só
      // consideramos fim de seção se for `---`, INLINE_LINK_*, ou header canônico (#2413).
      // Uma linha de descrição pode começar com bold sem ser header.

      // Verificar presença de tempo na descrição
      if (!USE_MELHOR_TEMPO_RE.test(descLine)) {
        errors.push({
          item: itemNum,
          titleLine: titleLineNum,
          descLine: descLineNum,
          excerpt: nextNonEmpty.slice(0, 80),
        });
      }
    }
  }

  return { ok: errors.length === 0, errors, checked: itemNum };
}
