/**
 * meta-description.ts (#5101 item 2)
 *
 * Sugestão de meta description sobre o D1, pro resumo consolidado do Stage 4
 * (revisão editorial). Contexto (#5101): o "preview text" da Beehiiv — o
 * teaser que a Beehiiv usa como preheader do e-mail — também alimenta
 * `<meta name="description">`/`og:description`/`twitter:description` da
 * página web publicada. O preview text é escrito sobre D2/D3 (funciona bem
 * como teaser de e-mail: "leia sobre X e Y lá dentro"), mas isso produz um
 * snippet de busca/card social que descreve OUTRAS matérias, não a do
 * título da página (D1) — quebra a expectativa de quem clica a partir do
 * Google ou de um link compartilhado.
 *
 * Este módulo é PURO e não decide nada sozinho: gera uma SUGESTÃO (≤155
 * chars, baseada no primeiro parágrafo do corpo do D1 — por convenção do
 * template, `context/templates/newsletter.md`, esse parágrafo "abre a
 * história" e já é o texto mais "resumo" do destaque) para o editor colar no
 * campo de SEO description da Beehiiv **se esse campo existir** — não
 * confirmado a partir daqui (não há acesso à UI da Beehiiv nesta sessão; ver
 * `docs/seo-notes.md`). Trocar o preview text em produção é decisão do
 * editor (trade-off contra a taxa de abertura do e-mail) — este módulo não
 * grava nada, só sugere texto pro gate humano do Stage 4 exibir.
 */

import { truncateAtBoundary } from "./truncate-at-boundary.ts";

/** Teto convencional do snippet de busca do Google (e da maioria dos card
 * unfurlers de rede social) — mesmo valor documentado em `seoMetaDescription`
 * (`scripts/lib/slug.ts`, #1989), que resolve o mesmo problema para as
 * páginas estáticas (cursos/livros), não para a newsletter. */
export const DEFAULT_META_DESCRIPTION_MAX_LENGTH = 155;

/** Remove formatação inline de markdown (bold/italic/link/código) e colapsa
 * espaços — o corpo do destaque em `02-reviewed.md` pode conter `**bold**`,
 * `[label](url)` ou `` `código` `` que não deve vazar pra um snippet de
 * busca em texto puro. */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [label](url) -> label
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold** -> bold
    .replace(/\*([^*]+)\*/g, "$1") // *italic* -> italic
    .replace(/__([^_]+)__/g, "$1") // __bold__ -> bold
    .replace(/_([^_]+)_/g, "$1") // _italic_ -> italic
    .replace(/`([^`]+)`/g, "$1") // `code` -> code
    .replace(/\s+/g, " ")
    .trim();
}

/** Primeiro parágrafo não-vazio de um corpo multi-parágrafo (separado por
 * linha(s) em branco, formato padrão do template de destaque). */
function firstParagraph(body: string): string {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paragraphs[0] ?? "";
}

export interface MetaDescriptionInput {
  /** Corpo do D1 (parágrafos) — mesmo shape de `Destaque.body` em
   * `scripts/extract-destaques.ts`. Usa-se só o 1º parágrafo (abertura da
   * história, ver docstring do módulo). */
  body: string;
  /** Teto de caracteres. Default `DEFAULT_META_DESCRIPTION_MAX_LENGTH` (155). */
  maxLength?: number;
}

/**
 * Gera a sugestão de meta description sobre o D1: 1º parágrafo do corpo,
 * markdown inline removido, truncado em boundary de frase/palavra (nunca no
 * meio de uma palavra, via `truncateAtBoundary`) até `maxLength` chars.
 *
 * Retorna string vazia se `body` não tiver nenhum parágrafo não-vazio — o
 * chamador (Stage 4) decide como exibir a ausência (ex: "⚠️ indisponível").
 */
export function buildMetaDescriptionSuggestion(input: MetaDescriptionInput): string {
  const { body, maxLength = DEFAULT_META_DESCRIPTION_MAX_LENGTH } = input;
  const paragraph = stripInlineMarkdown(firstParagraph(body ?? ""));
  if (!paragraph) return "";
  return truncateAtBoundary(paragraph, maxLength);
}
