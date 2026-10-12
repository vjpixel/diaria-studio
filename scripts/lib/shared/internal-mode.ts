/**
 * scripts/lib/shared/internal-mode.ts (#10080)
 *
 * A navegação da equipe entrava nas contagens do pixel 1285191740325112: em
 * 05/10/2026, às 23h, a versão D registrou 23 cliques no botão de compra em
 * uma hora, provavelmente testes. O localhost já estava fora (#9982), mas a
 * navegação em diar.ia.br continuava contando.
 *
 * Modo interno das páginas `/evento/agente-ia/*` e `/guia/agente-ia`:
 * - abrir qualquer uma delas com `?interno=1` grava o marcador no
 *   localStorage do navegador. Só estas páginas leem o marcador: a home e o
 *   acervo de diar.ia.br (pixel pelo GTM) e o checkout da Hotmart (pixel
 *   próprio) continuam medindo;
 * - `?interno=0` apaga o marcador;
 * - o parâmetro sai da barra de endereço logo depois de lido
 *   (`history.replaceState`), para não vazar num link copiado;
 * - com o marcador, a página não inicializa o pixel da Meta, não carrega o
 *   GTM (LinkedIn, Google Ads e GA4) e não manda o beacon do clique. Os
 *   links para o checkout continuam funcionando.
 *
 * O bootstrap roda inline no `<head>`, ANTES do GTM e do pixel, e expõe
 * `window.__DIA_INTERNO__`. As páginas são estáticas: o HTML leva o texto
 * literal destas funções, e os testes comparam byte a byte com o helper (mesmo
 * padrão de `visitorIdBootstrapJs`, #8978).
 */

export const INTERNAL_MODE_STORAGE_KEY = "diaria_interno";
const INTERNAL_MODE_QUERY_PARAM = "interno";
const INTERNAL_MODE_FLAG = "window.__DIA_INTERNO__";

/**
 * Snippet JS (sem `<script>` em volta) que lê `?interno=1|0`, grava ou apaga
 * o marcador e define `window.__DIA_INTERNO__`. Fail-soft: localStorage
 * bloqueado (aba anônima de alguns navegadores) vira modo normal, nunca erro.
 */
export function internalModeBootstrapJs(): string {
  const param = JSON.stringify(INTERNAL_MODE_QUERY_PARAM);
  return (
    // IIFE: nenhuma variável vaza para o escopo global (um `const q` num
    // script da página quebraria com SyntaxError).
    "(function () {" +
    "var q = null;" +
    "try {" +
    `var key = ${JSON.stringify(INTERNAL_MODE_STORAGE_KEY)};` +
    `q = new URLSearchParams(window.location.search).get(${param});` +
    "if (q === '1') window.localStorage.setItem(key, '1');" +
    "else if (q === '0') window.localStorage.removeItem(key);" +
    `${INTERNAL_MODE_FLAG} = window.localStorage.getItem(key) === '1';` +
    `} catch (e) { ${INTERNAL_MODE_FLAG} = false; }` +
    // Tira o parâmetro da barra de endereço: um link copiado daqui não pode
    // levar `?interno=1` para visitantes reais (desligaria a medição deles).
    "if (q !== null) {" +
    "try {" +
    "var u = new URL(window.location.href);" +
    `u.searchParams.delete(${param});` +
    "window.history.replaceState(window.history.state, '', u.pathname + u.search + u.hash);" +
    "} catch (e) {}" +
    "}" +
    "})();"
  );
}

/** Envolve um snippet para que ele só rode fora do modo interno. Usado no
 * loader do GTM (que fica byte a byte igual ao de `renderAnalyticsHead`). */
export function skipWhenInternalJs(js: string): string {
  return `if (!${INTERNAL_MODE_FLAG}) {${js}}`;
}
