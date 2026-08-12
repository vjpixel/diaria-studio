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
 * chars por padrão, baseada no 1º parágrafo do corpo do D1 que ainda tenha
 * prosa aproveitável — por convenção do template,
 * `context/templates/newsletter.md`, o parágrafo de abertura "abre a
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

/** `![alt](url)` — sintaxe de imagem markdown. Casada e removida ANTES do
 * strip de link genérico abaixo: sem isso, o regex de link (que não conhece
 * o `!` prefixo) convertia `![Diagrama](url)` em `!Diagrama`, vazando um `!`
 * solto pro snippet de busca (achado do fleet review pré-merge). */
const IMAGE_MARKDOWN_RE = /!\[[^\]]*\]\([^)]*\)/g;

/** `[label](url)` — sintaxe de link markdown (não-imagem, já sem o `!`
 * consumido pelo strip de imagem acima). */
const LINK_MARKDOWN_RE = /\[([^\]]+)\]\([^)]*\)/g;

/** Versões não-globais dos dois regex acima, só pra teste de presença
 * (`.test()`/`.some(...)` em regex `/g` mantém `lastIndex` entre chamadas e
 * corrompe silenciosamente checagens repetidas — usar instância própria sem
 * a flag evita essa pegadinha clássica). */
const HAS_IMAGE_MARKDOWN_RE = /!\[[^\]]*\]\([^)]*\)/;
const HAS_LINK_MARKDOWN_RE = /\[[^\]]+\]\([^)]*\)/;

/** Remove formatação inline de markdown (imagem/link/bold/italic/código) e
 * colapsa espaços — o corpo do destaque em `02-reviewed.md` pode conter
 * `**bold**`, `[label](url)`, `![alt](url)` ou `` `código` `` que não deve
 * vazar pra um snippet de busca em texto puro. */
function stripInlineMarkdown(text: string): string {
  return (
    text
      .replace(IMAGE_MARKDOWN_RE, "") // ![alt](url) -> removida inteira, nunca vaza o "!"
      .replace(LINK_MARKDOWN_RE, "$1") // [label](url) -> label
      .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold** -> bold
      .replace(/\*([^*]+)\*/g, "$1") // *italic* -> italic
      .replace(/__([^_]+)__/g, "$1") // __bold__ -> bold
      .replace(/_([^_]+)_/g, "$1") // _italic_ -> italic
      .replace(/`([^`]+)`/g, "$1") // `code` -> code
      // Marcador markdown não-fechado (contagem ímpar de **/*/`) não bate
      // nenhum dos pares acima e sobreviveria cru no texto — remove qualquer
      // `*`, `_` ou `` ` `` residual em vez de deixar vazar pro snippet.
      .replace(/[*_`]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * True quando `paragraph` (ANTES de qualquer strip pra exibição) é
 * inteiramente composto por um ou mais links/imagens markdown, sem nenhum
 * texto real ao redor — ex: `"![Diagrama](url)"` ou `"[Fonte](url)"`
 * sozinhos num parágrafo. Um parágrafo assim não tem "abertura de história"
 * nenhuma pra virar meta description; o caller deve pular pro próximo
 * parágrafo em vez de sugerir só o rótulo do link/alt-text.
 *
 * Detecta removendo TODO link/imagem — rótulo incluso, diferente de
 * `stripInlineMarkdown` (que preserva o rótulo do link) — e checando se
 * sobra algo.
 */
function isOnlyLinkOrImage(paragraph: string): boolean {
  const withoutLinksOrImages = paragraph
    .replace(IMAGE_MARKDOWN_RE, "")
    .replace(/\[[^\]]+\]\([^)]*\)/g, "")
    .trim();
  return withoutLinksOrImages.length === 0;
}

/** True quando `text` tem um "run" de pelo menos 2 palavras separadas por
 * espaço — heurística mínima de "isto é prosa real ao redor do link", usada
 * só pra parágrafos que CONTÊM um link/imagem (ver `firstUsableParagraph`).
 * NÃO é um requisito geral de todo parágrafo — um destaque real
 * legitimamente pode ter um parágrafo de 1 palavra sem nenhum link (ex:
 * "Confirmado.", caso coberto pela suite existente), e essa função nunca é
 * consultada nesse caso. */
function hasWordRun(text: string): boolean {
  return /\S+\s+\S+/.test(text);
}

/**
 * Primeiro parágrafo de `body` que, depois do strip de markdown, ainda tem
 * prosa aproveitável — pula parágrafos que são só imagem/link (sem texto ao
 * redor, `isOnlyLinkOrImage`) e, quando o parágrafo CONTÉM um link/imagem
 * cercado de pontuação solta (não pego por `isOnlyLinkOrImage`, que só
 * considera whitespace puro), exige que sobre pelo menos um "run" de 2
 * palavras fora do rótulo do link (`hasWordRun`) — sem isso, um parágrafo
 * como `"— [Fonte](url)"` produziria só "— Fonte", sugestão sem sentido.
 * Parágrafos SEM nenhum link/imagem não passam por essa 2ª checagem — um
 * parágrafo de prosa comum de 1 palavra continua válido. `null` quando
 * NENHUM parágrafo do corpo qualifica.
 */
function firstUsableParagraph(body: string): string | null {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  for (const raw of paragraphs) {
    if (isOnlyLinkOrImage(raw)) continue;
    const stripped = stripInlineMarkdown(raw);
    if (!stripped) continue;
    const hadLinkOrImage = HAS_IMAGE_MARKDOWN_RE.test(raw) || HAS_LINK_MARKDOWN_RE.test(raw);
    if (hadLinkOrImage && !hasWordRun(stripped)) continue;
    return stripped;
  }
  return null;
}

export interface MetaDescriptionInput {
  /** Corpo do D1 (parágrafos) — mesmo shape de `Destaque.body` em
   * `scripts/extract-destaques.ts`. Usa-se o 1º parágrafo com prosa
   * aproveitável (ver `firstUsableParagraph`). `null`/`undefined` são
   * tolerados explicitamente — o call site real (`orchestrator-stage-4.md`
   * §4c.1c) interpola JSON stringificado que pode vir malformado/ausente. */
  body: string | null | undefined;
  /** Teto de caracteres. Default `DEFAULT_META_DESCRIPTION_MAX_LENGTH` (155).
   * Valores `<= 1` são tratados como inválidos (não dá pra truncar em
   * boundary de palavra/frase com 0-1 char de orçamento) e caem no default —
   * `truncateAtBoundary` não é chamado com um `max` degenerado. */
  maxLength?: number;
}

/**
 * Gera a sugestão de meta description sobre o D1: 1º parágrafo do corpo com
 * prosa aproveitável, markdown inline removido, truncado em boundary de
 * frase/palavra (nunca no meio de uma palavra, via `truncateAtBoundary`) até
 * `maxLength` chars.
 *
 * Retorna `null` — nunca uma string vazia/corrompida como sentinela — quando
 * `body` é vazio/nulo/indisponível, ou quando NENHUM parágrafo do corpo tem
 * prosa aproveitável (ex: todo parágrafo é só uma imagem/link sem texto ao
 * redor, ou reduz a um rótulo de link solto sem palavras reais em volta). O
 * chamador (Stage 4) decide como exibir a ausência (ex: "⚠️ indisponível").
 */
export function buildMetaDescriptionSuggestion(input: MetaDescriptionInput): string | null {
  const { body, maxLength } = input;
  const effectiveMaxLength =
    typeof maxLength === "number" && maxLength > 1 ? maxLength : DEFAULT_META_DESCRIPTION_MAX_LENGTH;

  const paragraph = firstUsableParagraph(body ?? "");
  if (!paragraph) return null;
  return truncateAtBoundary(paragraph, effectiveMaxLength);
}
