/**
 * lint-checks/section-item-format.ts (#1737 item 2 — extraído de lint-newsletter-md.ts)
 *
 * Verifica formato de itens nas seções secundárias (#909).
 *
 * Regra (writer.md passo 3 + context/templates/newsletter.md):
 *   linha N:   **[Título](URL)**
 *   linha N+1: Descrição em 1 frase plain text (não vazia, sem markdown)
 *   linha N+2: vazia (separador entre items)
 *
 * Detecções:
 *   - "[Título](URL) descrição" — título + descrição na mesma linha (bug 260507)
 *   - URL quebrada em multilinha "[Título](\nurl\n)" — pega via reflexo
 *     (depende de normalize-newsletter ter rodado antes)
 *   - inline link em uma linha mas próxima linha vazia ou outro inline
 *     link (faltou descrição entre)
 *
 * Não enforça `**negrito**` em volta — bold é cosmetic e validate-domains
 * já cobre se necessário.
 */

import { sectionHeaderRegex, ALL_SECTION_NAMES_PATTERN } from "../section-naming.ts";

export interface SectionItemFormatError {
  section: string;
  line: number;
  type:
    | "title_and_description_same_line"
    | "title_without_description"
    | "broken_url_multiline";
  excerpt: string;
}

export interface SectionItemFormatReport {
  ok: boolean;
  errors: SectionItemFormatError[];
}

// #1693 parte 2 (enforce): emoji-tolerante + USE MELHOR/VÍDEOS. Antes era bare →
// `checkSectionItemFormat` era no-op em toda edição de produção (headers reais
// carregam emoji, ex: `**🛠️ USE MELHOR**`). Grupo 1 captura o nome da seção
// (usado em currentSection). #1737: pattern de nomes consolidado em
// section-naming.ts (ALL_SECTION_NAMES_PATTERN inclui os legacy + `S?` opcional).
// Aplicado linha-a-linha (trim) → flags "u" (^/$ = início/fim da linha única).
const SECTION_ITEM_HEADER_RE = sectionHeaderRegex(ALL_SECTION_NAMES_PATTERN, {
  capture: "name",
  flags: "u",
});

// Linha contendo APENAS um inline link bem-formado (com **bold** opcional
// e trailing spaces opcionais). Segura pra detectar item title-line.
// Exportado (#2372) — reutilizado por use-melhor-tempo.ts (era duplicado).
export const INLINE_LINK_ONLY_RE =
  /^\s*\*{0,2}\s*\[[^\]]+\]\(https?:\/\/[^\s)]+\)\s*\*{0,2}\s*$/;

// Linha com inline link + texto extra (descrição colada). Match conservador.
const INLINE_LINK_WITH_TEXT_RE =
  /^\s*\*{0,2}\s*\[[^\]]+\]\(https?:\/\/[^\s)]+\)\*{0,2}\s+\S/;

export function checkSectionItemFormat(md: string): SectionItemFormatReport {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const errors: SectionItemFormatError[] = [];

  let currentSection: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();

    const sectionMatch = t.match(SECTION_ITEM_HEADER_RE);
    if (sectionMatch) {
      currentSection = sectionMatch[1].toUpperCase();
      continue;
    }
    if (t === "---") {
      currentSection = null;
      continue;
    }
    if (
      currentSection &&
      /^(?:\*\*)?DESTAQUE\s+\d+/.test(t)
    ) {
      currentSection = null;
      continue;
    }

    if (!currentSection) continue;

    // Detecta inline link + descrição na mesma linha
    if (INLINE_LINK_WITH_TEXT_RE.test(raw)) {
      errors.push({
        section: currentSection,
        line: i + 1,
        type: "title_and_description_same_line",
        excerpt: t.slice(0, 100),
      });
      continue;
    }

    // Inline link bem-formado em linha solo: validar próxima linha não-vazia
    // existe e é descrição (não outro inline link nem header).
    if (INLINE_LINK_ONLY_RE.test(raw)) {
      // Próxima linha não-vazia
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j >= lines.length) {
        errors.push({
          section: currentSection,
          line: i + 1,
          type: "title_without_description",
          excerpt: t.slice(0, 100),
        });
        continue;
      }
      const nextNonEmpty = lines[j].trim();
      // Próximo é outro inline link → faltou descrição
      if (INLINE_LINK_ONLY_RE.test(lines[j])) {
        errors.push({
          section: currentSection,
          line: i + 1,
          type: "title_without_description",
          excerpt: t.slice(0, 100),
        });
        continue;
      }
      // Se a próxima linha não-vazia for um header (DESTAQUE, --- ou
      // SEÇÃO) também conta como faltando descrição.
      if (
        SECTION_ITEM_HEADER_RE.test(nextNonEmpty) ||
        /^(?:\*\*)?DESTAQUE\s+\d+/.test(nextNonEmpty) ||
        nextNonEmpty === "---"
      ) {
        errors.push({
          section: currentSection,
          line: i + 1,
          type: "title_without_description",
          excerpt: t.slice(0, 100),
        });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
