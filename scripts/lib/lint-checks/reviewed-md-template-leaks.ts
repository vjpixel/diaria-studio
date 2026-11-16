/**
 * scripts/lib/lint-checks/reviewed-md-template-leaks.ts (#13252)
 *
 * Duas checagens puras sobre o texto de `02-reviewed.md`, rodadas como
 * invariante de erro no Stage 2 (logo após o stitch) e no Stage 4 (antes do
 * gate). Incidente da edição 261116: a seleção de boxes pôs
 * `encerramento-social-apoio.md` no slot 1. O bloco "Para encerrar" saiu duas
 * vezes, e a cópia do slot 1 trouxe o marcador `{{OPENING}}` cru (o caminho do
 * box não passa por `renderEncerramentoSocialApoio`). Só o Kit (exit 8) e o
 * site (exit 5) recusaram, já no Stage 5.
 *
 * - `findUnknownTemplateMarkers`: qualquer `{{...}}` que não seja merge tag
 *   conhecida de ESP. A seleção já recusa o snippet de encerramento
 *   (`isNonBoxSnippet`); este check é a defesa no conteúdo, para qualquer via
 *   (pin, colagem à mão, snippet novo com marcador).
 * - `findClosingCreditsLines`: onde o parágrafo de créditos ("Nesta edição
 *   da diar.ia.br, usei...") aparece. Mais de uma vez = bloco duplicado.
 */

/**
 * Merge tags de ESP que podem aparecer legitimamente no texto da edição e o
 * ESP resolve no envio. Conjunto fechado, de propósito: tag nova entra aqui
 * com o motivo, nunca por regex frouxa.
 * - Kit (Liquid): `{{ subscriber.campo }}` (`lib/kit-broadcasts.ts`);
 * - Brevo: `{{ contact.CAMPO }}`, `{{ unsubscribe }}`;
 * - voto do É IA?: `{{poll_token}}` (#4487) e o legado `{{email}}` (#1186);
 * - Beehiiv (arquivo histórico): `{{email_address_id}}`.
 */
const KNOWN_ESP_MERGE_TAG_RES: readonly RegExp[] = [
  /^\{\{\s*subscriber\.[a-z0-9_]+\s*\}\}$/i,
  /^\{\{\s*contact\.[a-z0-9_]+\s*\}\}$/i,
  /^\{\{\s*(?:poll_token|email|email_address_id|unsubscribe)\s*\}\}$/,
];

export function isKnownEspMergeTag(tag: string): boolean {
  return KNOWN_ESP_MERGE_TAG_RES.some((re) => re.test(tag));
}

export interface TemplateMarkerHit {
  marker: string;
  /** Linha 1-based no texto original. */
  line: number;
}

/** Comentários HTML não chegam ao leitor; o texto deles não conta. */
function blankHtmlComments(md: string): string {
  // Troca o conteúdo por espaços preservando as quebras de linha, para os
  // números de linha seguirem batendo com o arquivo.
  return md.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

/** Todo `{{...}}` fora de comentário HTML que não é merge tag conhecida. */
export function findUnknownTemplateMarkers(md: string): TemplateMarkerHit[] {
  const lines = blankHtmlComments(md).split("\n");
  const hits: TemplateMarkerHit[] = [];
  lines.forEach((text, i) => {
    for (const m of text.matchAll(/\{\{[^{}\n]*\}\}/g)) {
      if (!isKnownEspMergeTag(m[0])) hits.push({ marker: m[0], line: i + 1 });
    }
  });
  return hits;
}

/**
 * Início do parágrafo de créditos de ferramentas do "Para encerrar"
 * (`FIXED_BLOCKS.para_encerrar_tools` em `stitch-newsletter.ts` e
 * `data/snippets/encerramento-social-apoio.md`). Casado depois de tirar a
 * ênfase markdown (`**diar.ia.br**`).
 */
const CLOSING_CREDITS_RE = /Nesta edição da diar\.ia\.br,\s*usei\b/gi;

/** Linhas (1-based) onde o parágrafo de créditos começa, fora de comentário HTML. */
export function findClosingCreditsLines(md: string): number[] {
  const lines = blankHtmlComments(md).split("\n");
  const out: number[] = [];
  lines.forEach((text, i) => {
    const plain = text.replace(/[*_]/g, "");
    const count = [...plain.matchAll(CLOSING_CREDITS_RE)].length;
    for (let k = 0; k < count; k++) out.push(i + 1);
  });
  return out;
}
