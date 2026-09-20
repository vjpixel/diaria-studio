/**
 * scripts/lib/shared/kit-recommendations-block.ts (#8539, extraído do #7524)
 *
 * Bloco opcional do widget Kit Creator Network (lado OUTGOING) — antes vivia
 * só em `workers/reativar/src/index.ts` (`renderKitRecommendationsBlock`),
 * embutido via `<iframe>` na tela de sucesso do `reativar`. Extraído pra
 * `lib/shared/` no #8539 porque a página de sucesso do `reativar` deixou de
 * existir como render próprio — o clique confirmado agora REDIRECIONA pra
 * `/confirmada` (`scripts/lib/shared/confirmado-page.ts`, Worker `site`),
 * que passa a ser o único lugar que renderiza uma tela de "cadastro
 * confirmado" pros dois caminhos (Kit DOI direto e Brevo/reativar). Sem essa
 * extração, o widget ficaria preso a um render que não roda mais.
 *
 * Puro — sem I/O, sem env. O `embedUrl` (secret `KIT_RECOMMENDATIONS_EMBED_URL`,
 * ver docstring do campo em `workers/reativar/src/index.ts`/`workers/site/src/index.ts`)
 * é responsabilidade do CALL SITE resolver a partir do próprio `env`.
 */

/**
 * Escapa o atributo mesmo o valor vindo de secret (não de request): um typo
 * com `"`/`<` no `wrangler secret put` quebraria o HTML em silêncio.
 */
export function renderKitRecommendationsBlock(embedUrl: string): string {
  const src = embedUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<div style="margin-top:32px"><iframe src="${src}" width="100%" height="480" style="border:none" title="Outras newsletters recomendadas"></iframe></div>`;
}
