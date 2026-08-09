/**
 * brand-wordmark.ts (#4797 — extraído de `newsletter-render-html.ts`)
 *
 * Tratamento tipográfico canônico da marca: "diar.ia.br" em negrito, com o
 * ".br" (e o "." separador) na cor teal do DS (`COLORS.brand`). Nasceu no
 * e-mail (#2532, ajustado em #2674) e vivia só em
 * `scripts/lib/newsletter-render-html.ts` — issue #4797: nenhuma página do
 * site (hubs temáticos, arquivo, livros, cursos, `workers/poll`) aplicava o
 * mesmo tratamento, mesmo citando a marca em texto corrido dezenas de vezes.
 *
 * Módulo SEM NENHUMA dependência de I/O (só `design-tokens.ts`, também
 * puro) — seguro de importar em qualquer bundle, inclusive Cloudflare
 * Workers (mesmo padrão de `scripts/lib/shared/robots-txt.ts`, #4777: um
 * módulo puro pode ser importado direto via caminho relativo
 * `../../../scripts/lib/shared/...` num Worker sem arrastar a cadeia Node-only
 * de `newsletter-render-html.ts`, ver `test/worker-bundle-node-only-imports.test.ts`).
 *
 * `test/lib-boundary.test.ts` é o forcing function que levou este helper pra
 * cá: `scripts/lib/shared/hub-page.ts`/`geo-faq.ts`/`curadoria-page.ts`/
 * `markdown-links.ts` (todos em `shared/`) precisavam do wordmark, e um
 * import cruzado de `shared/` pra um arquivo na raiz de `scripts/lib/`
 * (`newsletter-render-html.ts` — que carrega uma cadeia inteira específica
 * de e-mail: word-joiner, estilo inline pro Outlook, `readFileSync`) seria
 * exatamente o tipo de dependência invertida que a fronteira lint-enforced
 * existe pra sinalizar. `newsletter-render-html.ts` e
 * `scripts/lib/mensal/monthly-render.ts` agora importam DAQUI — import único,
 * sem duplicata de lógica entre e-mail e site.
 *
 * IMPORTANTE — ordem de aplicação: `applyBrandWordmark` espera receber uma
 * string JÁ ESCAPADA pra HTML (`escHtml`/`esc`) — ele injeta `<strong>`/
 * `<span>` cru por cima, então rodar ANTES do escape corromperia a marcação
 * (o escaper trataria `<strong>` como texto literal) e rodar em texto
 * NÃO-escapado arriscaria interpolar conteúdo de usuário sem sanitização.
 * Ordem canônica em todo call site: escapar → aplicar wordmark (por último).
 */
import { COLORS } from "./design-tokens.ts";

const TEAL = COLORS.brand;

/**
 * #2674 (260630): wordmark em negrito, com `.` e `.br` no teal da marca.
 */
const BRAND_WORDMARK_HTML =
  `<strong>diar<span style="color:${TEAL}">.</span>ia<span style="color:${TEAL}">.br</span></strong>`;

/**
 * Regex de módulo (não realocar por chamada). `replace` com `/g` é
 * stateless. `i`: casa a forma antiga da marca (capitalizada, sem `.br`) e
 * `diar.ia.br` (domínio minúsculo, ex: comissão) indiferente de caixa.
 * Alternância URL-safe: o domínio cheio `diar.ia.br` casa salvo se seguido
 * por `/` `\w` `@` (path de URL); a forma sem `.br` casa salvo se seguido
 * por `.br` (deixa o domínio cheio capturar) ou por `/` `\w` `@` (URL).
 * Lookbehind `(?<![/\w.@])` exclui `https://diar.ia.br`, `www.diar.ia.br`,
 * `user@diar.ia.br`. Fim de frase (forma antiga seguida de ponto, ou
 * `diar.ia.br.`) continua casando.
 */
const BRAND_WORDMARK_RE =
  /(?<![/\w.@])(?:diar\.ia\.br(?![/\w@])|diar\.ia(?!\.br)(?![/\w@]))/gi;

/**
 * Aplica-se a conteúdo de TEXTO já renderizado (segmentos de prosa). Casa a
 * forma antiga da marca (sem `.br`) E `diar.ia.br` (domínio em minúscula),
 * absorvendo um sufixo `.br` opcional no MESMO match (sem `.br` duplicado).
 * O `i` faz casar minúsculas/maiúsculas indiferentemente; os
 * lookbehind/lookahead garantem que **NUNCA toca URLs** — um `diar.ia.br`
 * precedido por `/` `.` `@` ou letra (ex: `https://diar.ia.br/p`,
 * `www.diar.ia.br`) ou seguido por `/` letra `@` (path de URL) NÃO casa.
 * Também não casa `diaria` sem ponto. Output lowercase (`diar...`), logo
 * re-aplicar é idempotente.
 *
 * @param linkHref (opcional) — quando presente, envolve o wordmark num link
 *   pra esse destino (mantendo o estilo do wordmark: negrito + pontos teal,
 *   sem sublinhar). Usado pela newsletter MENSAL (#3181): toda ocorrência de
 *   `diar.ia.br` vira link pra `diaria.beehiiv.com`. Sem o param,
 *   comportamento inalterado (texto puro) — a diária e as páginas do site
 *   seguem sem link (já vivem no próprio domínio / no Beehiiv).
 */
export function applyBrandWordmark(s: string, linkHref?: string): string {
  const html = linkHref
    ? `<a href="${linkHref}" style="color:inherit;text-decoration:none">${BRAND_WORDMARK_HTML}</a>`
    : BRAND_WORDMARK_HTML;
  // Replacement via função: `html` (que embute `linkHref` arbitrário) é inserido
  // LITERAL — evita a interpretação de `$&`/`$1`/`$$` que o replace-string faz se
  // a URL contiver `$` (agora que linkHref é parâmetro, não mais só a constante).
  return s.replace(BRAND_WORDMARK_RE, () => html);
}
