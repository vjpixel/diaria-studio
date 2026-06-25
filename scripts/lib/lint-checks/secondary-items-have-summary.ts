/**
 * lint-checks/secondary-items-have-summary.ts (#2545)
 *
 * Verifica que todo item de seção secundária (LANÇAMENTOS / RADAR / USE MELHOR)
 * tem uma descrição (linha não-vazia abaixo do título). Seção É IA? e VÍDEOS
 * são excluídas — elas têm formato próprio sem descrição obrigatória inline.
 *
 * Problema que este lint resolve: itens non-inbox com `summary` vazio escapam
 * do `enrich-inbox-articles.ts` quando há cache-miss (o body não estava no
 * cache do 1i) e o cap de fallback fetch foi atingido. Sem este lint, o
 * item entra no writer e renderiza só o título pelado no email — editor só
 * percebe no gate do Stage 4 (como aconteceu em 260625, caso OpenClaw).
 *
 * Estratégia: varrer `02-reviewed.md` linha-a-linha. Em cada seção secundária
 * alvo (LANÇAMENTOS/RADAR/USE MELHOR), para cada linha de título de item
 * (inline link), verificar que a próxima linha não-vazia não é outro link,
 * header, separador ou EOF. Se for — descrição ausente → erro.
 *
 * Observação: o checker de formato `section-item-format.ts` já detecta
 * `title_without_description` (link sem linha seguinte). Este lint é mais
 * simples — só acusa descrição vazia/ausente — e roda como check separado
 * pré-gate, facilitando a ação de fix pelo editor (distingue "falta o texto"
 * de "formato errado").
 *
 * Exit via CLI:
 *   0 — todos os itens das seções alvo têm descrição
 *   1 — algum item tem descrição vazia
 *   2 — erro de argumento / arquivo não encontrado
 */

import { sectionHeaderRegex } from "../section-naming.ts";
import { INLINE_LINK_ONLY_RE } from "./section-item-format.ts";

// Seções cujos itens exigem descrição obrigatória
const TARGET_SECTION_RE = sectionHeaderRegex(
  String.raw`LAN[ÇC]AMENTOS?|RADAR|USE\s+MELHOR|PESQUISAS?|OUTRAS?\s+NOT[ÍI]CIAS?`,
  { capture: "none", flags: "u" },
);

// Qualquer header de seção (inclusive VÍDEOS / É IA?) — para encerrar scan
const ANY_SECTION_HEADER_RE = sectionHeaderRegex(
  String.raw`LAN[ÇC]AMENTOS?|RADAR|USE\s+MELHOR|V[ÍI]DEOS?|PESQUISAS?|OUTRAS?\s+NOT[ÍI]CIAS?`,
  { capture: "none", flags: "u" },
);

export interface SecondaryItemSummaryError {
  section: string;
  /** Linha do título (1-based). */
  titleLine: number;
  /** Trecho do título (até 80 chars). */
  titleExcerpt: string;
}

export interface SecondaryItemSummaryReport {
  ok: boolean;
  errors: SecondaryItemSummaryError[];
}

/**
 * Varre `md` e retorna erros para cada item de seção secundária sem descrição.
 *
 * "Descrição" = linha não-vazia imediatamente após o título (inline link) que
 * NÃO é outro inline link, header de seção, separador `---` ou é EOF.
 *
 * Para USE MELHOR, itens com formato canônico (link + descrição na mesma linha)
 * também são aceitos como tendo descrição.
 */
export function checkSecondaryItemsHaveSummary(
  md: string,
): SecondaryItemSummaryReport {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const errors: SecondaryItemSummaryError[] = [];

  let currentSection: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();

    // Detectar seção alvo
    if (TARGET_SECTION_RE.test(t)) {
      // Extrair nome da seção (pegar tudo sem bold e emoji)
      currentSection = t.replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
      continue;
    }

    // Qualquer outro header de seção encerra a seção alvo
    if (ANY_SECTION_HEADER_RE.test(t)) {
      currentSection = null;
      continue;
    }

    // Separador `---` encerra seção
    if (t === "---") {
      currentSection = null;
      continue;
    }

    // Seção DESTAQUE também encerra
    if (/^(?:\*\*)?DESTAQUE\s+\d+/.test(t)) {
      currentSection = null;
      continue;
    }

    if (!currentSection) continue;

    // Formato canônico de produção (link + descrição inline): sempre válido
    // Ex: `**[Título](URL)** Descrição... (5 min)` — tem descrição na mesma linha.
    // \*{0,2} tolera com ou sem bold; aceita qualquer link+texto como item válido.
    const INLINE_LINK_WITH_TEXT_RE = /^\s*\*{0,2}\s*\[[^\]]+\]\(https?:\/\/[^\s)]+\)\*{0,2}\s+\S/;
    if (INLINE_LINK_WITH_TEXT_RE.test(raw)) {
      // Item com link + descrição inline: tem descrição, OK
      continue;
    }

    // Formato canônico de item USE MELHOR com descrição inline (BOLDED title):
    // `**[Título](URL)** Descrição...`. Usado apenas para verificar se a PRÓXIMA
    // linha é outro item de seção (não uma descrição que começa com link).
    // Distinção importante (#2579): uma descrição que começa com `[Fonte](url) texto`
    // NÃO tem asteriscos bold ao redor do link e NÃO é outro item — é descrição válida.
    const INLINE_LINK_BOLDED_ITEM_RE =
      /^\s*\*\*\s*\[[^\]]+\]\(https?:\/\/[^\s)]+\)\s*\*\*\s+\S/;

    // Linha contendo APENAS um inline link (título do item)
    if (INLINE_LINK_ONLY_RE.test(raw)) {
      // Procurar próxima linha não-vazia
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;

      const noDescription =
        j >= lines.length || // EOF
        INLINE_LINK_ONLY_RE.test(lines[j]) || // próxima é outro link (título pelado)
        INLINE_LINK_BOLDED_ITEM_RE.test(lines[j]) || // próxima é item USE MELHOR bolded+desc inline
        ANY_SECTION_HEADER_RE.test(lines[j].trim()) || // próxima é header
        /^(?:\*\*)?DESTAQUE\s+\d+/.test(lines[j].trim()) || // próxima é DESTAQUE
        lines[j].trim() === "---"; // próxima é separador

      if (noDescription) {
        errors.push({
          section: currentSection,
          titleLine: i + 1,
          titleExcerpt: t.slice(0, 80),
        });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
