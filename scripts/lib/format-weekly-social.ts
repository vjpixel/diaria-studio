/**
 * format-weekly-social.ts (#4101, restrito ao Instagram pelo #4483)
 *
 * Formatação da caption do post semanal do Instagram (os itens mais
 * clicados da semana — ver `weekly-instagram-select.ts`).
 *
 * **#4483 removeu LinkedIn/Facebook/Threads/Twitter-X deste arquivo** — a
 * skill `/diaria-instagram-semanal` (renomeada de `/diaria-semanal`)
 * publica exclusivamente no Instagram agora (o recap semanal do LinkedIn
 * passou a ser coberto por `/diaria-linkedin-semanal`, #4456). As funções
 * `formatLinkedInWeekly`/`formatFacebookWeekly`/`formatThreadsWeekly`/
 * `formatTwitterWeeklyThread` e as constantes de limite de caracteres
 * associadas foram removidas junto — ver histórico do arquivo (git log)
 * pra recuperar caso algum canal volte a fazer sentido aqui no futuro.
 *
 * Pura (texto in, texto out) — nenhuma I/O ou chamada de rede.
 * `publish-weekly-social.ts` consome esta função antes de despachar.
 */

/** Limite de caracteres de caption no Instagram (mesmo valor de publish-instagram.ts). */
export const INSTAGRAM_WEEKLY_CHAR_LIMIT = 2200;

const ARCHIVE_URL = "https://diar.ia.br";

const INTRO_LINE = "Os mais clicados da semana na diar.ia.br:";

/** Shape mínimo que a formatação precisa — desacoplado do tipo de seleção completo (`InstagramRankedCandidate`). */
export interface InstagramWeeklyItem {
  title: string;
}

/**
 * Instagram: caption sem links clicáveis (IG não linka no corpo) — títulos
 * numerados + "link na bio" apontando pro arquivo. Truncado no limite de
 * caption do IG (2200 chars) preservando palavras inteiras, mesmo padrão de
 * `truncateCaption` em publish-instagram.ts.
 *
 * Formato de imagem: carrossel (#4146, decisão do editor 260727) — 1 card
 * 4:5 por item selecionado, na mesma ordem numerada desta caption. Desde o
 * #4483, os itens não correspondem mais 1:1 a dias da semana (podem vir de
 * D1/D2/D3 de qualquer dia, inclusive 2 itens do mesmo dia) — esta função só
 * numera os títulos (`items.length` itens); a montagem do carrossel em si
 * (`image_urls`, 1 por item, resolvida pelo destaque/edição de origem de
 * CADA item) é responsabilidade de `publish-weekly-social.ts`
 * (`resolveWeeklyImageUrls`).
 */
export function formatInstagramWeekly(items: InstagramWeeklyItem[]): string {
  if (items.length === 0) return "";
  const body =
    `${INTRO_LINE}\n\n` +
    items.map((it, i) => `${i + 1}. ${it.title}`).join("\n") +
    `\n\nEdição completa de cada matéria no link da bio. Arquivo completo em ${ARCHIVE_URL}.`;
  return truncateAtLimit(body, INSTAGRAM_WEEKLY_CHAR_LIMIT);
}

function truncateAtLimit(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.lastIndexOf(" ", maxLen - 3);
  const idx = cut > 0 ? cut : maxLen - 3;
  return text.slice(0, idx) + "...";
}
